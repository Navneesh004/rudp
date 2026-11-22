#!/usr/bin/env node
/**
 * rudp-recv <port> <output-file>
 *
 * Waits for one RUDP connection, writes everything it receives to a file and
 * prints the SHA-256 so it can be compared with the sender's.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { listen } from "../udp.js";
import { MODE_NAMES } from "../window.js";
import { MB, fail, formatBytes, parsePort, printTable } from "./common.js";

const USAGE = `usage: rudp-recv <port> <output-file> [options]

options:
  --host <address>   address to bind (default: 0.0.0.0)
  --json             print the result as one line of JSON
  -h, --help         show this help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string", default: "0.0.0.0" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const [portArg, outFile] = positionals;
  if (!portArg || !outFile) fail(`missing arguments\n\n${USAGE}`, 2);
  const port = parsePort(portArg);

  const { connection: conn, address } = await listen(port, { host: values.host });
  process.stderr.write(`listening on udp ${address.address}:${address.port}\n`);

  const out = createWriteStream(outFile);
  const hash = createHash("sha256");
  let start = 0;
  let end = 0;
  let paused = false;

  conn.on("connect", () => {
    start = performance.now();
    process.stderr.write(`connection established (${MODE_NAMES[conn.mode]})\n`);
  });
  conn.on("data", (chunk) => {
    hash.update(chunk);
    // Disk slower than the network? Pause, which shrinks our advertised window.
    if (!out.write(chunk) && !paused) {
      paused = true;
      conn.pause();
      out.once("drain", () => {
        paused = false;
        conn.resume();
      });
    }
  });
  conn.on("end", () => {
    end = performance.now();
    out.end();
  });

  const [err] = (await once(conn, "close")) as [Error | undefined];
  if (err) fail(err.message);
  if (!out.writableFinished) await once(out, "finish");

  const s = conn.summary();
  const seconds = Math.max(end - start, 1e-6) / 1000;
  const result = {
    protocol: "rudp",
    mode: s.mode,
    bytes: s.bytesReceived,
    seconds: Number(seconds.toFixed(4)),
    mbps: Number((s.bytesReceived / MB / seconds).toFixed(3)),
    outOfOrder: s.outOfOrder,
    duplicates: s.duplicatesReceived,
    corruptDropped: s.corruptDropped,
    sha256: hash.digest("hex"),
  };

  if (values.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  printTable(`received ${formatBytes(result.bytes)} into ${outFile}`, [
    ["time", `${result.seconds.toFixed(3)} s`],
    ["throughput", `${result.mbps.toFixed(2)} MB/s`],
    ["out of order", String(result.outOfOrder)],
    ["duplicates", String(result.duplicates)],
    ["corrupt dropped", String(result.corruptDropped)],
    ["sha256", result.sha256],
  ]);
}

main().catch((err: Error) => fail(err.message));
