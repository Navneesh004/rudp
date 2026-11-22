/**
 * Compare stop-and-wait, Go-Back-N and selective repeat in the deterministic
 * simulator (no Docker needed). Prints a Markdown table; every run with the
 * same arguments gives the same numbers.
 *
 *   npm run bench:sim                 # 1 MB, 50 ms RTT
 *   npm run bench:sim -- --size 4 --rtt 100 --seed 7
 */
import { parseArgs } from "node:util";
import { Connection, type Mode } from "../src/connection.js";
import { SimClock } from "../src/sim/clock.js";
import { createLinkPair } from "../src/sim/link.js";
import { mulberry32 } from "../src/sim/random.js";

const { values } = parseArgs({
  options: {
    size: { type: "string", default: "1" },
    rtt: { type: "string", default: "50" },
    seed: { type: "string", default: "3" },
    losses: { type: "string", default: "0,1,2,5,10" },
  },
});
const size = Math.round(Number(values.size) * (1 << 20));
const oneWay = Number(values.rtt) / 2;
const seed = Number(values.seed);
const losses = values.losses.split(",").map(Number);

interface Row {
  seconds: number;
  retransmissions: number;
  segments: number;
}

function run(mode: Mode, lossPct: number): Row {
  const clock = new SimClock();
  const { a, b } = createLinkPair(clock, mulberry32(seed), { loss: lossPct / 100, delay: oneWay }, { delay: oneWay });
  const client = new Connection({ link: a, clock, mode, isn: () => 1 });
  const server = new Connection({ link: b, clock, isn: () => 2 });
  const data = Buffer.alloc(size, 0x5a);
  let received = 0;
  let doneAt = Number.NaN;
  server.on("data", (c) => (received += c.length));
  server.on("end", () => (doneAt = clock.now()));
  client.on("error", () => {});
  client.on("connect", () => client.end(data));
  server.listen();
  client.connect();
  clock.run();
  if (received !== size) throw new Error(`${mode} at ${lossPct}% lost data`);
  return { seconds: doneAt / 1000, retransmissions: client.stats.retransmissions, segments: client.stats.segmentsSent };
}

const modes: Mode[] = ["saw", "gbn", "sr"];
const names: Record<Mode, string> = { saw: "Stop-and-wait", gbn: "Go-Back-N", sr: "Selective repeat" };
const fmt = (r: Row) => `${((size / 1e6) / r.seconds).toFixed(3)} MB/s · ${r.retransmissions} rtx`;

console.log(`Simulated ${(size / (1 << 20)).toFixed(0)} MiB transfer, ${values.rtt} ms RTT, loss on the data path, seed ${seed}\n`);
console.log(`| Loss | ${modes.map((m) => names[m]).join(" | ")} |`);
console.log(`| ---: | ${modes.map(() => "---:").join(" | ")} |`);
for (const loss of losses) {
  console.log(`| ${loss}% | ${modes.map((m) => fmt(run(m, loss))).join(" | ")} |`);
}
