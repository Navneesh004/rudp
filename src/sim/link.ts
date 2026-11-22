import type { Clock } from "../clock.js";
import type { Link } from "../link.js";
import type { Rng } from "./random.js";

/** Impairments applied to every datagram in one direction. Probabilities are 0..1. */
export interface LinkConditions {
  /** Probability a datagram is dropped. */
  loss?: number;
  /** Fixed one-way delay in ms. */
  delay?: number;
  /** Extra uniformly random delay in ms (0..jitter); large jitter reorders packets. */
  jitter?: number;
  /** Probability a datagram is delivered twice. */
  duplicate?: number;
  /** Probability one random byte of the datagram is flipped. */
  corrupt?: number;
  /** Bottleneck rate in bytes per ms (≈ kB/s); datagrams queue behind each other. */
  bandwidth?: number;
  /** Bottleneck queue limit in datagrams; excess is tail-dropped. */
  queueLimit?: number;
}

export interface LinkStats {
  sent: number;
  delivered: number;
  dropped: number;
  duplicated: number;
  corrupted: number;
}

/** One direction of a simulated network path. */
class SimLink implements Link {
  private handler: ((d: Buffer) => void) | undefined;
  peer!: SimLink;
  readonly stats: LinkStats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, corrupted: 0 };
  /** Virtual time at which the bottleneck finishes serialising its queue. */
  private busyUntil = 0;
  private queued = 0;
  /** When true, everything sent is dropped (used to simulate a dead path). */
  down = false;

  constructor(
    private readonly clock: Clock,
    private readonly rng: Rng,
    private readonly cond: LinkConditions,
  ) {}

  onReceive(handler: (d: Buffer) => void): void {
    this.handler = handler;
  }

  send(datagram: Buffer): void {
    this.stats.sent++;
    const c = this.cond;
    if (this.down || this.rng() < (c.loss ?? 0)) {
      this.stats.dropped++;
      return;
    }

    let start = 0;
    if (c.bandwidth) {
      if (c.queueLimit !== undefined && this.queued >= c.queueLimit) {
        this.stats.dropped++;
        return;
      }
      const now = this.clock.now();
      this.busyUntil = Math.max(this.busyUntil, now) + datagram.length / c.bandwidth;
      start = this.busyUntil - now;
      this.queued++;
      this.clock.setTimeout(() => this.queued--, start);
    }

    const copies = this.rng() < (c.duplicate ?? 0) ? 2 : 1;
    if (copies === 2) this.stats.duplicated++;
    for (let i = 0; i < copies; i++) {
      let bytes = Buffer.from(datagram);
      if (this.rng() < (c.corrupt ?? 0) && bytes.length > 0) {
        bytes = Buffer.from(bytes);
        const at = Math.floor(this.rng() * bytes.length);
        bytes[at] = bytes[at]! ^ (1 + Math.floor(this.rng() * 255));
        this.stats.corrupted++;
      }
      const delay = start + (c.delay ?? 10) + this.rng() * (c.jitter ?? 0);
      this.clock.setTimeout(() => {
        this.stats.delivered++;
        this.peer.handler?.(bytes);
      }, delay);
    }
  }
}

export interface LinkPair {
  a: Link & { readonly stats: LinkStats; down: boolean };
  b: Link & { readonly stats: LinkStats; down: boolean };
}

/**
 * Create two connected endpoints. Datagrams sent on `a` arrive at `b` under
 * `aToB` conditions, and vice versa.
 */
export function createLinkPair(clock: Clock, rng: Rng, aToB: LinkConditions, bToA: LinkConditions = aToB): LinkPair {
  const a = new SimLink(clock, rng, aToB);
  const b = new SimLink(clock, rng, bToA);
  a.peer = b;
  b.peer = a;
  return { a, b };
}
