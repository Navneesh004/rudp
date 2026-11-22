#!/usr/bin/env node
/**
 * rudp-send <host> <port> <file>
 *
 * Sends a file over RUDP and prints transfer time, throughput, retransmission
 * count and final congestion window.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { connect } from "../udp.js";
import { MODE_NAMES } from "../window.js";
import { MB, fail, formatBytes, parseIntOption, parseMode, parsePort, printTable } from "./common.js";

const USAGE = `usage: rudp-send <host> <port> <file> [options]

options:
  --mode <saw|gbn|sr>   reliability strategy (default: sr)
  --mss <bytes>         payload bytes per packet (default: 1200)
  --window <segments>   maximum segments in flight (default: 512)
  --min-rto <ms>        lower bound on the retransmission timeout (default: 200)
  --cwnd-log <file>     write congestion window samples to a CSV file
  --json                print the result as one line of JSON
  -h, --help            show this help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      mss: { type: "string" },
      window: { type: "string" },
      "min-rto": { type: "string" },
      "cwnd-log": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const [host, portArg, file] = positionals;
  if (!host || !portArg || !file) fail(`missing arguments\n\n${USAGE}`, 2);
  const port = parsePort(portArg);
  const mode = parseMode(values.mode);
  const mss = parseIntOption("mss", values.mss);
  const window = parseIntOption("window", values.window);
  const minRto = parseIntOption("min-rto", values["min-rto"]);

  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    fail(`cannot read ${file}`);
  }

  const conn = await connect(host, port, {
    mode,
    mss,
    maxWindow: window,
    rtt: minRto ? { minRto } : undefined,
  });
  const start = performance.now();

  const cwndRows: string[] = ["t_ms,cwnd,ssthresh"];
  const first = conn.summary();
  cwndRows.push(`0,${first.cwnd},${first.ssthresh}`);
  conn.on("cwnd", (s) => cwndRows.push(`${s.t.toFixed(1)},${s.cwnd.toFixed(3)},${s.ssthresh}`));

  const hash = createHash("sha256");
  const stream = createReadStream(file, { highWaterMark: 256 * 1024 });
  stream.on("data", (chunk) => {
    const buf = chunk as Buffer;
    hash.update(buf);
    if (!conn.write(buf)) stream.pause();
  });
  conn.on("drain", () => stream.resume());
  stream.on("end", () => conn.end());
  stream.on("error", (err) => conn.destroy(err));

  const seconds = await new Promise<number>((resolve, reject) => {
    conn.once("finish", () => resolve((performance.now() - start) / 1000));
    conn.once("close", (err) => reject(err ?? new Error("connection closed before the transfer finished")));
  });
  await new Promise<void>((resolve) => (conn.state === "CLOSED" ? resolve() : conn.once("close", () => resolve())));

  if (values["cwnd-log"]) writeFileSync(values["cwnd-log"], cwndRows.join("\n") + "\n");

  const s = conn.summary();
  const result = {
    protocol: "rudp",
    mode,
    bytes: size,
    seconds: Number(seconds.toFixed(4)),
    mbps: Number((size / MB / seconds).toFixed(3)),
    retransmissions: s.retransmissions,
    fastRetransmits: s.fastRetransmits,
    timeouts: s.timeouts,
    segmentsSent: s.segmentsSent,
    finalCwnd: Number(s.cwnd.toFixed(2)),
    ssthresh: s.ssthresh,
    srttMs: s.srtt === undefined ? null : Number(s.srtt.toFixed(2)),
    rtoMs: Number(s.rto.toFixed(1)),
    sha256: hash.digest("hex"),
  };

  if (values.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  printTable(`sent ${basename(file)} (${formatBytes(size)}) to ${host}:${port} using ${MODE_NAMES[mode]}`, [
    ["time", `${result.seconds.toFixed(3)} s`],
    ["throughput", `${result.mbps.toFixed(2)} MB/s`],
    [
      "retransmissions",
      `${result.retransmissions} (${result.fastRetransmits} fast, ${result.timeouts} timeouts) of ${result.segmentsSent} segments`,
    ],
    ["final cwnd", `${result.finalCwnd} segments (ssthresh ${result.ssthresh})`],
    ["srtt / rto", `${result.srttMs ?? "-"} ms / ${result.rtoMs} ms`],
    ["sha256", result.sha256],
  ]);
}

main().catch((err: Error) => fail(err.message));
