#!/usr/bin/env node
/**
 * The same file transfer over plain TCP, as a baseline for the benchmarks.
 *
 *   tcp.ts recv <port> <output-file> [--json]
 *   tcp.ts send <host> <port> <file> [--json]
 *
 * The sender's clock stops when the receiver closes the connection after
 * reading everything, mirroring how rudp-send stops when its FIN is ACKed.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import net from "node:net";
import { parseArgs } from "node:util";
import { MB, fail, formatBytes, parsePort, printTable } from "../src/cli/common.js";

const USAGE = `usage:
  tcp.ts recv <port> <output-file> [--json]
  tcp.ts send <host> <port> <file> [--json]
`;

function report(json: boolean, title: string, result: Record<string, unknown> & { seconds: number; mbps: number; sha256: string }) {
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  printTable(title, [
    ["time", `${result.seconds.toFixed(3)} s`],
    ["throughput", `${result.mbps.toFixed(2)} MB/s`],
    ["sha256", result.sha256],
  ]);
}

function recv(port: number, outFile: string, json: boolean): void {
  const server = net.createServer({ noDelay: true }, (socket) => {
    server.close(); // one connection, like rudp-recv
    const start = performance.now();
    const out = createWriteStream(outFile);
    const hash = createHash("sha256");
    let bytes = 0;
    socket.on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    socket.pipe(out);
    out.on("finish", () => {
      const seconds = (performance.now() - start) / 1000;
      socket.end();
      report(json, `received ${formatBytes(bytes)} into ${outFile} over TCP`, {
        protocol: "tcp",
        bytes,
        seconds: Number(seconds.toFixed(4)),
        mbps: Number((bytes / MB / seconds).toFixed(3)),
        sha256: hash.digest("hex"),
      });
    });
  });
  server.listen(port, () => process.stderr.write(`listening on tcp port ${port}\n`));
}

function send(host: string, port: number, file: string, json: boolean): void {
  const size = statSync(file).size;
  const hash = createHash("sha256");
  const socket = net.connect({ host, port, noDelay: true }, () => {
    const start = performance.now();
    const stream = createReadStream(file, { highWaterMark: 256 * 1024 });
    stream.on("data", (c) => hash.update(c as Buffer));
    stream.pipe(socket);
    socket.on("close", () => {
      const seconds = (performance.now() - start) / 1000;
      report(json, `sent ${formatBytes(size)} to ${host}:${port} over TCP`, {
        protocol: "tcp",
        bytes: size,
        seconds: Number(seconds.toFixed(4)),
        mbps: Number((size / MB / seconds).toFixed(3)),
        retransmissions: null, // kernel-internal; see `ss -ti` on Linux
        sha256: hash.digest("hex"),
      });
    });
  });
  socket.on("data", () => {}); // drain the receiver's FIN
  socket.on("error", (err) => fail(err.message));
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { json: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
});
const [cmd, ...args] = positionals;
if (values.help) process.stdout.write(USAGE);
else if (cmd === "recv" && args.length === 2) recv(parsePort(args[0]), args[1]!, values.json);
else if (cmd === "send" && args.length === 3) send(args[0]!, parsePort(args[1]), args[2]!, values.json);
else fail(`bad arguments\n\n${USAGE}`, 2);
