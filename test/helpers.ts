import { createHash } from "node:crypto";
import { Connection, type ConnectionOptions } from "../src/connection.js";
import { SimClock } from "../src/sim/clock.js";
import { createLinkPair, type LinkConditions, type LinkPair } from "../src/sim/link.js";
import { mulberry32 } from "../src/sim/random.js";
import type { Mode } from "../src/window.js";

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function randomData(size: number, seed: number): Buffer {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256);
  return buf;
}

export interface TransferOptions {
  mode?: Mode;
  size?: number;
  seed?: number;
  /** Conditions client → server (data direction). */
  forward?: LinkConditions;
  /** Conditions server → client (ACK direction). Defaults to `forward`. */
  reverse?: LinkConditions;
  client?: Partial<ConnectionOptions>;
  server?: Partial<ConnectionOptions>;
  /** Called once both connections exist, before anything runs. */
  setup?: (ctx: { clock: SimClock; client: Connection; server: Connection; links: LinkPair }) => void;
  maxTime?: number;
}

export interface TransferResult {
  data: Buffer;
  received: Buffer;
  client: Connection;
  server: Connection;
  clock: SimClock;
  links: LinkPair;
  errors: Error[];
  /** Virtual time at which the receiver saw the whole stream ("end" event). */
  completedAt: number | undefined;
}

/** Run a complete simulated transfer from client to server in virtual time. */
export function simulateTransfer(opts: TransferOptions = {}): TransferResult {
  const seed = opts.seed ?? 1;
  const clock = new SimClock();
  const links = createLinkPair(clock, mulberry32(seed), opts.forward ?? {}, opts.reverse ?? opts.forward ?? {});
  const data = randomData(opts.size ?? 100_000, seed);
  let isnSeed = seed * 7919;
  const isn = () => (isnSeed = (Math.imul(isnSeed, 2654435761) + 12345) >>> 0);

  const client = new Connection({ link: links.a, clock, mode: opts.mode ?? "sr", isn, ...opts.client });
  const server = new Connection({ link: links.b, clock, isn, ...opts.server });
  const errors: Error[] = [];
  const chunks: Buffer[] = [];
  let completedAt: number | undefined;

  client.on("error", (e) => errors.push(e));
  server.on("error", (e) => errors.push(e));
  server.on("data", (c) => chunks.push(c));
  server.on("end", () => (completedAt = clock.now()));
  client.on("connect", () => client.end(data));

  opts.setup?.({ clock, client, server, links });
  server.listen();
  client.connect();
  clock.run({ maxTime: opts.maxTime ?? 1e9 });

  return { data, received: Buffer.concat(chunks), client, server, clock, links, errors, completedAt };
}
