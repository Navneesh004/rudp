/**
 * Sliding-window bookkeeping for both directions of a connection.
 *
 * SendWindow   the sender's scoreboard: which segments are outstanding, which the
 *              receiver has selectively acknowledged (SACKed), and which are
 *              presumed lost and waiting to be retransmitted.
 * ReceiveWindow the receiver's reassembly buffer: delivers bytes in order and, in
 *              selective-repeat mode, buffers out-of-order segments.
 *
 * Neither class touches timers or sockets; Connection drives them.
 */
import { seqAdd, seqDiff, seqGt, seqGte, seqLte, type SackBlock } from "./packet.js";

export type Mode = "saw" | "gbn" | "sr";

export const MODE_NAMES: Record<Mode, string> = {
  saw: "stop-and-wait",
  gbn: "Go-Back-N",
  sr: "selective repeat",
};

export interface Segment {
  readonly seq: number;
  readonly payload: Buffer;
  readonly fin: boolean;
  /** Sequence space consumed: payload length, or 1 for a FIN. */
  readonly len: number;
  sentAt: number;
  /** Number of transmissions; > 1 means it was retransmitted (Karn's rule). */
  sentCount: number;
  sacked: boolean;
  /** Presumed lost and not yet retransmitted. */
  lost: boolean;
}

export const segEnd = (s: Segment): number => seqAdd(s.seq, s.len);

export interface AckResult {
  /** Segments removed by this cumulative ACK that had not already been SACKed. */
  newlyAcked: Segment[];
  /** Every segment removed by this cumulative ACK. */
  removed: Segment[];
}

export class SendWindow {
  /** Outstanding segments in sequence order, starting at sndUna. */
  readonly segments: Segment[] = [];
  private una: number;
  private nxt: number;

  constructor(isn: number) {
    this.una = isn >>> 0;
    this.nxt = isn >>> 0;
  }

  /** Oldest unacknowledged sequence number. */
  get sndUna(): number {
    return this.una;
  }
  /** Next sequence number to be used for new data. */
  get sndNxt(): number {
    return this.nxt;
  }
  get outstanding(): number {
    return this.segments.length;
  }
  get isEmpty(): boolean {
    return this.segments.length === 0;
  }

  /** Segments believed to be in the network: not SACKed and not presumed lost (RFC 6675 "pipe"). */
  get flight(): number {
    let n = 0;
    for (const s of this.segments) if (!s.sacked && !s.lost) n++;
    return n;
  }

  /** Record a newly transmitted segment. */
  add(payload: Buffer, fin: boolean, now: number): Segment {
    const seg: Segment = {
      seq: this.nxt,
      payload,
      fin,
      len: fin ? 1 : payload.length,
      sentAt: now,
      sentCount: 1,
      sacked: false,
      lost: false,
    };
    this.segments.push(seg);
    this.nxt = seqAdd(this.nxt, seg.len);
    return seg;
  }

  /** Is `ack` a cumulative ACK that acknowledges something new? */
  isNewAck(ack: number): boolean {
    return seqGt(ack, this.una) && seqLte(ack, this.nxt);
  }

  /** Apply a cumulative ACK: everything below `ack` has arrived. */
  ack(ack: number): AckResult {
    const result: AckResult = { newlyAcked: [], removed: [] };
    if (!this.isNewAck(ack)) return result;
    while (this.segments.length > 0 && seqLte(segEnd(this.segments[0]!), ack)) {
      const seg = this.segments.shift()!;
      result.removed.push(seg);
      if (!seg.sacked) result.newlyAcked.push(seg);
    }
    this.una = ack;
    return result;
  }

  /** Mark segments covered by SACK blocks. Returns the segments SACKed for the first time. */
  applySack(blocks: readonly SackBlock[]): Segment[] {
    const newly: Segment[] = [];
    for (const seg of this.segments) {
      if (seg.sacked) continue;
      const end = segEnd(seg);
      for (const [start, stop] of blocks) {
        if (seqGte(seg.seq, start) && seqLte(end, stop)) {
          seg.sacked = true;
          seg.lost = false;
          newly.push(seg);
          break;
        }
      }
    }
    return newly;
  }

  /** Mark the oldest un-SACKed segment as lost (fast retransmit / NewReno partial ACK). */
  markFirstLost(): boolean {
    const seg = this.segments.find((s) => !s.sacked);
    if (!seg || seg.lost) return false;
    seg.lost = true;
    return true;
  }

  /** Mark every un-SACKed outstanding segment as lost (retransmission timeout). */
  markAllLost(): number {
    let n = 0;
    for (const s of this.segments) {
      if (!s.sacked && !s.lost) {
        s.lost = true;
        n++;
      }
    }
    return n;
  }

  /**
   * RFC 6675-style loss detection: a segment is lost once at least `dupThresh`
   * segments sent after it have been SACKed.
   */
  markLostBySack(dupThresh = 3): number {
    let sackedAbove = 0;
    let n = 0;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i]!;
      if (s.sacked) sackedAbove++;
      else if (!s.lost && sackedAbove >= dupThresh && s.sentCount === 1) {
        s.lost = true;
        n++;
      }
    }
    return n;
  }

  /** The oldest segment waiting for retransmission. */
  nextLost(): Segment | undefined {
    return this.segments.find((s) => s.lost);
  }

  markRetransmitted(seg: Segment, now: number): void {
    seg.lost = false;
    seg.sentAt = now;
    seg.sentCount++;
  }
}

export interface ReceiveResult {
  /** In-order bytes released to the application by this segment. */
  delivered: Buffer[];
  duplicate: boolean;
  outOfOrder: boolean;
  /** Dropped because it was out of order (GBN) or the buffer was full. */
  dropped: boolean;
}

export class ReceiveWindow {
  private nxt: number;
  /** Out-of-order segments keyed by sequence number (selective repeat only). */
  private readonly ooo = new Map<number, Buffer>();
  /** In-order data held back while the application is paused (flow control). */
  private readonly held: Buffer[] = [];
  private paused = false;

  constructor(
    irs: number,
    readonly capacity: number,
    readonly buffering: boolean,
  ) {
    this.nxt = irs >>> 0;
  }

  /** Next sequence number expected (the cumulative ACK we send). */
  get rcvNxt(): number {
    return this.nxt;
  }

  get bufferedOutOfOrder(): number {
    return this.ooo.size;
  }

  /**
   * Window to advertise, in segments. Out-of-order segments are not subtracted
   * because the sender already counts them as outstanding.
   */
  get window(): number {
    return Math.max(0, this.capacity - this.held.length);
  }

  private get free(): number {
    return this.capacity - this.held.length - this.ooo.size;
  }

  receive(seq: number, payload: Buffer): ReceiveResult {
    const res: ReceiveResult = { delivered: [], duplicate: false, outOfOrder: false, dropped: false };
    if (payload.length === 0) return res;

    if (seq === this.nxt) {
      if (this.paused && this.free <= 0) {
        res.dropped = true;
        return res;
      }
      this.deliver(payload, res);
      let next = this.ooo.get(this.nxt);
      while (next !== undefined) {
        this.ooo.delete(this.nxt);
        this.deliver(next, res);
        next = this.ooo.get(this.nxt);
      }
      return res;
    }

    if (seqGt(seq, this.nxt)) {
      res.outOfOrder = true;
      if (this.ooo.has(seq)) res.duplicate = true;
      else if (!this.buffering || this.free <= 0) res.dropped = true;
      else this.ooo.set(seq, payload);
      return res;
    }

    res.duplicate = true; // entirely below rcvNxt: already delivered
    return res;
  }

  /** Consume the sequence number of the peer's FIN. */
  consumeFin(): void {
    this.nxt = seqAdd(this.nxt, 1);
  }

  /** SACK blocks describing the out-of-order data we hold, lowest first. */
  sackBlocks(max = 32): SackBlock[] {
    if (this.ooo.size === 0) return [];
    const starts = [...this.ooo.keys()].sort((a, b) => seqDiff(a, this.nxt) - seqDiff(b, this.nxt));
    const blocks: [number, number][] = [];
    for (const start of starts) {
      const end = seqAdd(start, this.ooo.get(start)!.length);
      const last = blocks[blocks.length - 1];
      if (last && last[1] === start) last[1] = end;
      else {
        if (blocks.length === max) break;
        blocks.push([start, end]);
      }
    }
    return blocks;
  }

  pause(): void {
    this.paused = true;
  }

  /** Resume delivery; returns the data that was held back while paused. */
  resume(): Buffer[] {
    this.paused = false;
    return this.held.splice(0);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private deliver(payload: Buffer, res: ReceiveResult): void {
    this.nxt = seqAdd(this.nxt, payload.length);
    if (this.paused) this.held.push(payload);
    else res.delivered.push(payload);
  }
}
