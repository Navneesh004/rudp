/**
 * Compare stop-and-wait, Go-Back-N and selective repeat in the deterministic
 * simulator (no Docker needed). Prints a Markdown table; every run with the
 * same arguments gives the same numbers.
 *
 *   npm run bench:sim                         # 1 MB, 50 ms RTT
 *   npm run bench:sim -- --size 4 --rtt 100 --seed 7
 *   npm run bench:sim -- --out results        # also write CSVs for bench/plot.py
 *
 * With --out, writes:
 *   sim_results.csv  throughput and retransmissions per mode and loss rate
 *   sim_cwnd.csv     cwnd trace of a selective-repeat transfer through a
 *                    1 MB/s bottleneck with a 60-packet queue
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Connection, type Mode } from "../src/connection.js";
import { SimClock } from "../src/sim/clock.js";
import { createLinkPair, type LinkConditions } from "../src/sim/link.js";
import { mulberry32 } from "../src/sim/random.js";

const { values } = parseArgs({
  options: {
    size: { type: "string", default: "1" },
    rtt: { type: "string", default: "50" },
    seed: { type: "string", default: "3" },
    losses: { type: "string", default: "0,1,2,5,10" },
    out: { type: "string" },
  },
});
const size = Math.round(Number(values.size) * (1 << 20));
const rttMs = Number(values.rtt);
const oneWay = rttMs / 2;
const seed = Number(values.seed);
const losses = values.losses.split(",").map(Number);

interface Row {
  seconds: number;
  retransmissions: number;
  segments: number;
}

function transfer(
  mode: Mode,
  bytes: number,
  forward: LinkConditions,
  onCwnd?: (t: number, cwnd: number, ssthresh: number) => void,
): Row {
  const clock = new SimClock();
  const { a, b } = createLinkPair(clock, mulberry32(seed), forward, { delay: oneWay });
  const client = new Connection({ link: a, clock, mode, isn: () => 1 });
  const server = new Connection({ link: b, clock, isn: () => 2 });
  let received = 0;
  let doneAt = Number.NaN;
  server.on("data", (c) => (received += c.length));
  server.on("end", () => (doneAt = clock.now()));
  client.on("error", () => {});
  if (onCwnd) client.on("cwnd", (s) => onCwnd(s.t, s.cwnd, s.ssthresh));
  client.on("connect", () => client.end(Buffer.alloc(bytes, 0x5a)));
  server.listen();
  client.connect();
  clock.run();
  if (received !== bytes) throw new Error(`${mode} lost data`);
  return { seconds: doneAt / 1000, retransmissions: client.stats.retransmissions, segments: client.stats.segmentsSent };
}

const modes: Mode[] = ["saw", "gbn", "sr"];
const names: Record<Mode, string> = { saw: "Stop-and-wait", gbn: "Go-Back-N", sr: "Selective repeat" };
const mbps = (r: Row) => size / 1e6 / r.seconds;

const csv = ["mode,loss_pct,rtt_ms,size_mib,seed,throughput_mbps,retransmissions,segments_sent"];
console.log(`Simulated ${(size / (1 << 20)).toFixed(0)} MiB transfer, ${rttMs} ms RTT, loss on the data path, seed ${seed}\n`);
console.log(`| Loss | ${modes.map((m) => names[m]).join(" | ")} |`);
console.log(`| ---: | ${modes.map(() => "---:").join(" | ")} |`);
for (const loss of losses) {
  const cells = modes.map((m) => {
    const r = transfer(m, size, { loss: loss / 100, delay: oneWay });
    csv.push([m, loss, rttMs, values.size, seed, mbps(r).toFixed(4), r.retransmissions, r.segments].join(","));
    return `${mbps(r).toFixed(3)} MB/s · ${r.retransmissions} rtx`;
  });
  console.log(`| ${loss}% | ${cells.join(" | ")} |`);
}

if (values.out) {
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "sim_results.csv"), csv.join("\n") + "\n");
  const trace = ["t_ms,cwnd,ssthresh"];
  transfer("sr", 4 << 20, { delay: oneWay, bandwidth: 1000, queueLimit: 60 }, (t, c, s) =>
    trace.push(`${t.toFixed(1)},${c.toFixed(3)},${s}`),
  );
  writeFileSync(join(values.out, "sim_cwnd.csv"), trace.join("\n") + "\n");
  console.log(`\nwrote ${join(values.out, "sim_results.csv")} and ${join(values.out, "sim_cwnd.csv")}`);
}
