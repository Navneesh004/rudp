/**
 * One RUDP connection: handshake, reliable ordered delivery, flow control,
 * congestion control and teardown, on top of an unreliable datagram Link.
 *
 * The connection is event-driven and never blocks: every action happens in
 * response to a datagram arriving, a timer firing, or the application calling
 * write()/end(). That is what lets the same code run over a real UDP socket and
 * inside the deterministic simulator used by the tests.
 *
 * Events: connect, data(chunk), end (peer finished sending), finish (all our
 * data and FIN acknowledged), drain, cwnd(sample), state(from, to),
 * close(err?), error(err).
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { realClock, type Clock, type TimerHandle } from "./clock.js";
import { FixedWindow, Reno, type CongestionControl } from "./congestion.js";
import type { Link } from "./link.js";
import {
  ACK,
  FIN,
  SACK,
  SYN,
  decode,
  decodeSack,
  encode,
  encodeSack,
  seqAdd,
  seqGte,
  seqLt,
  type Packet,
} from "./packet.js";
import { RttEstimator, type RttOptions } from "./rtt.js";
import { StateMachine, type State } from "./state.js";
import { ReceiveWindow, SendWindow, type Mode, type Segment } from "./window.js";

export type { Mode } from "./window.js";

export const PROTOCOL_VERSION = 1;
const MODE_CODES: readonly Mode[] = ["saw", "gbn", "sr"];
/** Give up re-sending a FIN sooner than data: by then all data is already delivered. */
const FIN_RETRIES = 6;
const DUP_THRESH = 3;

export interface ConnectionOptions {
  link: Link;
  clock?: Clock;
  /** Reliability strategy. Set by the client; the server adopts it from the SYN. Default "sr". */
  mode?: Mode;
  /** Maximum payload bytes per segment. Default 1200 (fits a 1280-byte IPv6 minimum MTU). */
  mss?: number;
  /** Receive buffer size in segments; advertised as the flow-control window. Default 512. */
  recvBuffer?: number;
  /** Cap on segments in flight, regardless of cwnd or the peer's window. Default 512. */
  maxWindow?: number;
  /** "reno" (default) or "none" for a fixed window of maxWindow segments. */
  congestion?: "reno" | "none";
  rtt?: RttOptions;
  /** Consecutive timeouts before the connection is declared dead. Default 15. */
  maxRetries?: number;
  /** How long the active closer lingers in TIME_WAIT to re-ACK a lost final FIN. Default 1000 ms. */
  timeWaitMs?: number;
  /** write() returns false once this many bytes are queued. Default 1 MiB. */
  highWaterMark?: number;
  /** Close our side automatically when the peer sends FIN. Default true. */
  autoClose?: boolean;
  /** Initial sequence number source, for tests. Default: cryptographically random. */
  isn?: () => number;
}

export interface ConnectionStats {
  packetsSent: number;
  packetsReceived: number;
  segmentsSent: number;
  /** Payload bytes put on the wire, including retransmissions. */
  bytesSent: number;
  /** Payload bytes the peer has acknowledged. */
  bytesAcked: number;
  /** In-order payload bytes delivered to the application. */
  bytesReceived: number;
  acksSent: number;
  retransmissions: number;
  fastRetransmits: number;
  timeouts: number;
  dupAcks: number;
  rttSamples: number;
  corruptDropped: number;
  outOfOrder: number;
  duplicatesReceived: number;
  windowProbes: number;
}

export interface ConnectionSummary extends ConnectionStats {
  mode: Mode;
  state: State;
  cwnd: number;
  ssthresh: number;
  srtt: number | undefined;
  rto: number;
}

export interface CwndSample {
  /** ms since connect() / listen() */
  t: number;
  cwnd: number;
  ssthresh: number;
}

export type ConnectionEvents = {
  connect: [];
  data: [chunk: Buffer];
  end: [];
  finish: [];
  drain: [];
  cwnd: [sample: CwndSample];
  state: [from: State, to: State];
  close: [err?: Error];
  error: [err: Error];
};

const zeroStats = (): ConnectionStats => ({
  packetsSent: 0,
  packetsReceived: 0,
  segmentsSent: 0,
  bytesSent: 0,
  bytesAcked: 0,
  bytesReceived: 0,
  acksSent: 0,
  retransmissions: 0,
  fastRetransmits: 0,
  timeouts: 0,
  dupAcks: 0,
  rttSamples: 0,
  corruptDropped: 0,
  outOfOrder: 0,
  duplicatesReceived: 0,
  windowProbes: 0,
});

export class Connection extends EventEmitter<ConnectionEvents> {
  readonly stats: ConnectionStats = zeroStats();

  private readonly sm = new StateMachine((from, to) => this.emit("state", from, to));
  private readonly link: Link;
  private readonly clock: Clock;
  private readonly mss: number;
  private readonly recvBuffer: number;
  private readonly maxWindow: number;
  private readonly ccKind: "reno" | "none";
  private readonly maxRetries: number;
  private readonly timeWaitMs: number;
  private readonly highWaterMark: number;
  private readonly autoClose: boolean;
  private readonly isnSource: () => number;
  private readonly rtt: RttEstimator;
  private modeValue: Mode;

  private cc: CongestionControl;
  private snd: SendWindow | undefined;
  private rcv: ReceiveWindow | undefined;
  private isn = 0;

  // Application data waiting to be segmented.
  private readonly sendQueue: Buffer[] = [];
  private queuedBytes = 0;
  private needDrain = false;

  // Teardown bookkeeping.
  private endRequested = false;
  private finSent = false;
  private finAcked = false;
  private peerFin = false;
  private finishEmitted = false;
  private closed = false;

  // Loss recovery.
  private peerWindow = 1;
  private dupAcks = 0;
  private inRecovery = false;
  private recoverPoint = 0;
  private consecutiveTimeouts = 0;
  private probe = false;

  // Timers.
  private rtxTimer: TimerHandle | undefined;
  private handshakeTimer: TimerHandle | undefined;
  private persistTimer: TimerHandle | undefined;
  private timeWaitTimer: TimerHandle | undefined;
  private handshakeTries = 0;
  private synSentAt = 0;
  private startedAt = 0;
  private pausePending = false;
  private lastCwnd = -1;
  private lastSsthresh = -1;

  constructor(opts: ConnectionOptions) {
    super();
    this.link = opts.link;
    this.clock = opts.clock ?? realClock;
    this.modeValue = opts.mode ?? "sr";
    this.mss = opts.mss ?? 1200;
    this.recvBuffer = opts.recvBuffer ?? 512;
    this.maxWindow = opts.maxWindow ?? 512;
    this.ccKind = opts.congestion ?? "reno";
    this.maxRetries = opts.maxRetries ?? 15;
    this.timeWaitMs = opts.timeWaitMs ?? 1000;
    this.highWaterMark = opts.highWaterMark ?? 1 << 20;
    this.autoClose = opts.autoClose ?? true;
    this.isnSource = opts.isn ?? (() => randomBytes(4).readUInt32BE(0));
    this.rtt = new RttEstimator(opts.rtt);
    this.cc = this.makeCongestionControl();
    if (this.mss < 1 || this.mss > 0xffff - 17) throw new RangeError(`invalid mss ${this.mss}`);
    this.link.onReceive((d) => this.onDatagram(d));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get state(): State {
    return this.sm.state;
  }
  get mode(): Mode {
    return this.modeValue;
  }
  get stateHistory(): readonly State[] {
    return this.sm.history;
  }
  /** Segments sent but not yet cumulatively acknowledged. */
  get inFlight(): number {
    return this.snd?.outstanding ?? 0;
  }

  /** Active open: send SYN and wait for SYN+ACK. */
  connect(): this {
    this.sm.transition("SYN_SENT");
    this.startedAt = this.clock.now();
    this.isn = this.isnSource() >>> 0;
    this.sendSyn();
    return this;
  }

  /** Passive open: wait for a SYN. */
  listen(): this {
    this.sm.transition("LISTEN");
    this.startedAt = this.clock.now();
    return this;
  }

  /** Queue data for sending. Returns false when the caller should wait for "drain". */
  write(data: Buffer | string): boolean {
    if (this.endRequested || this.closed) throw new Error("write after end");
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    if (buf.length > 0) {
      this.sendQueue.push(buf);
      this.queuedBytes += buf.length;
      this.pump();
    }
    const ok = this.queuedBytes < this.highWaterMark;
    if (!ok) this.needDrain = true;
    return ok;
  }

  /** Finish sending: a FIN follows once all queued data has been acknowledged. */
  end(data?: Buffer | string): void {
    if (data !== undefined) this.write(data);
    if (this.endRequested) return;
    this.endRequested = true;
    this.pump();
    this.checkClose();
  }

  /** Stop delivering "data" events; the advertised window shrinks as data is held back. */
  pause(): void {
    if (this.rcv) this.rcv.pause();
    else this.pausePending = true;
  }

  resume(): void {
    this.pausePending = false;
    if (!this.rcv?.isPaused) return;
    const held = this.rcv.resume();
    for (const chunk of held) this.deliver(chunk);
    this.sendAck(); // window update
  }

  /** Abort immediately without a FIN exchange. */
  destroy(err?: Error): void {
    this.shutdown(err);
  }

  summary(): ConnectionSummary {
    return {
      ...this.stats,
      mode: this.modeValue,
      state: this.sm.state,
      cwnd: this.cc.cwnd,
      ssthresh: this.cc.ssthresh,
      srtt: this.rtt.srtt,
      rto: this.rtt.rto,
    };
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  private sendSyn(): void {
    const synAck = this.sm.is("SYN_RECEIVED");
    this.sendPacket({
      seq: this.isn,
      ack: synAck ? this.rcv!.rcvNxt : 0,
      flags: synAck ? SYN | ACK : SYN,
      window: this.recvBuffer,
      payload: Buffer.from([PROTOCOL_VERSION, MODE_CODES.indexOf(this.modeValue)]),
    });
    this.synSentAt = this.clock.now();
    this.handshakeTries++;
    this.clearTimer("handshakeTimer");
    this.handshakeTimer = this.clock.setTimeout(() => this.onHandshakeTimeout(), this.rtt.rto);
  }

  private onHandshakeTimeout(): void {
    this.handshakeTimer = undefined;
    if (!this.sm.is("SYN_SENT", "SYN_RECEIVED")) return;
    if (this.handshakeTries > this.maxRetries) {
      this.shutdown(new Error(`handshake timed out after ${this.handshakeTries} attempts`));
      return;
    }
    this.stats.timeouts++;
    this.stats.retransmissions++;
    this.rtt.backoff();
    this.sendSyn();
  }

  private onListen(p: Packet): void {
    if (!(p.flags & SYN) || p.flags & ACK) return;
    if (p.payload[0] !== PROTOCOL_VERSION) return; // unknown protocol version: ignore
    this.modeValue = MODE_CODES[p.payload[1] ?? 2] ?? "sr";
    this.cc = this.makeCongestionControl();
    this.rcv = new ReceiveWindow(seqAdd(p.seq, 1), this.recvBuffer, this.modeValue === "sr");
    this.peerWindow = p.window;
    this.isn = this.isnSource() >>> 0;
    this.sm.transition("SYN_RECEIVED");
    this.sendSyn();
  }

  private onSynSent(p: Packet): void {
    if ((p.flags & (SYN | ACK)) !== (SYN | ACK) || p.ack !== seqAdd(this.isn, 1)) return;
    this.clearTimer("handshakeTimer");
    if (this.handshakeTries === 1) this.sampleRtt(this.clock.now() - this.synSentAt);
    this.rcv = new ReceiveWindow(seqAdd(p.seq, 1), this.recvBuffer, this.modeValue === "sr");
    this.peerWindow = p.window;
    this.establish();
    this.sendAck(); // third leg of the handshake
    this.pump();
  }

  private onSynReceived(p: Packet): void {
    if (p.flags & SYN && !(p.flags & ACK)) {
      this.sendSyn(); // our SYN+ACK was lost and the client retried
      return;
    }
    if (!(p.flags & ACK) || p.ack !== seqAdd(this.isn, 1)) return;
    this.clearTimer("handshakeTimer");
    if (this.handshakeTries === 1) this.sampleRtt(this.clock.now() - this.synSentAt);
    this.establish();
    this.onSegment(p); // the final ACK may be lost, so the first data packet completes the handshake too
  }

  private establish(): void {
    this.snd = new SendWindow(seqAdd(this.isn, 1));
    this.sm.transition("ESTABLISHED");
    if (this.pausePending) this.rcv!.pause();
    this.emitCwnd();
    this.emit("connect");
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  private onDatagram(datagram: Buffer): void {
    if (this.closed) return;
    this.stats.packetsReceived++;
    const p = decode(datagram);
    if (!p) {
      this.stats.corruptDropped++;
      return;
    }
    switch (this.sm.state) {
      case "CLOSED":
        return;
      case "LISTEN":
        return this.onListen(p);
      case "SYN_SENT":
        return this.onSynSent(p);
      case "SYN_RECEIVED":
        return this.onSynReceived(p);
      default:
        return this.onSegment(p);
    }
  }

  private onSegment(p: Packet): void {
    if (p.flags & SYN) {
      this.sendAck(); // duplicate SYN or SYN+ACK: the peer missed our ACK
      return;
    }
    if (p.flags & ACK) this.onAck(p);
    if (this.closed) return;
    if (!(p.flags & SACK) && p.payload.length > 0) this.onData(p);
    if (this.closed) return;
    if (p.flags & FIN) this.onFin(p);
    if (this.closed) return;
    this.pump();
    this.checkClose();
  }

  private onData(p: Packet): void {
    const rcv = this.rcv!;
    if (this.peerFin) {
      this.sendAck();
      return;
    }
    const res = rcv.receive(p.seq, p.payload);
    if (res.duplicate) this.stats.duplicatesReceived++;
    if (res.outOfOrder) this.stats.outOfOrder++;
    for (const chunk of res.delivered) this.deliver(chunk);
    if (this.closed) return;
    this.sendAck(); // ACK every segment: the sender's dup-ACK counting depends on it
  }

  private deliver(chunk: Buffer): void {
    this.stats.bytesReceived += chunk.length;
    this.emit("data", chunk);
  }

  private onFin(p: Packet): void {
    const rcv = this.rcv!;
    if (p.seq === rcv.rcvNxt && !this.peerFin) {
      rcv.consumeFin();
      this.peerFin = true;
      this.sendAck();
      if (this.sm.is("ESTABLISHED")) this.sm.transition("CLOSE_WAIT");
      this.emit("end");
      if (this.autoClose && this.sm.is("CLOSE_WAIT") && !this.closed) this.end();
    } else if (seqLt(p.seq, rcv.rcvNxt)) {
      this.sendAck(); // retransmitted FIN: our ACK was lost
    }
  }

  // -------------------------------------------------------------------------
  // ACK processing (the sending half)
  // -------------------------------------------------------------------------

  private onAck(p: Packet): void {
    const snd = this.snd;
    if (!snd) return;
    const now = this.clock.now();
    const ack = p.ack;

    let newlySacked: Segment[] = [];
    if (p.flags & SACK && this.modeValue === "sr") newlySacked = snd.applySack(decodeSack(p.payload));

    const windowUpdate = p.window !== this.peerWindow;
    this.peerWindow = p.window;
    if (p.window > 0 && this.probe) {
      this.probe = false;
      this.clearTimer("persistTimer");
    }

    if (snd.isNewAck(ack)) {
      const { newlyAcked, removed } = snd.ack(ack);
      const fresh = [...newlyAcked, ...newlySacked];
      this.sampleSegments(fresh, now);
      for (const s of removed) {
        if (s.fin) this.finAcked = true;
        else this.stats.bytesAcked += s.len;
      }
      this.dupAcks = 0;
      this.consecutiveTimeouts = 0;
      this.rtt.resetBackoff();

      const exits = this.inRecovery && seqGte(ack, this.recoverPoint);
      const partial = this.inRecovery && !exits;
      if (exits) this.inRecovery = false;
      this.cc.onAck(fresh.length, exits);
      // NewReno: a partial ACK during recovery means the next hole was lost too.
      if (partial && this.modeValue === "sr") snd.markFirstLost();

      this.restartRtxTimer();
      this.emitCwnd();
    } else if (
      ack === snd.sndUna &&
      !snd.isEmpty &&
      (p.payload.length === 0 || p.flags & SACK) &&
      !(p.flags & FIN) &&
      !windowUpdate
    ) {
      this.dupAcks++;
      this.stats.dupAcks++;
      if (this.dupAcks === DUP_THRESH && this.modeValue !== "saw") this.enterRecovery();
    }

    // Selective repeat: SACK information can reveal more holes (RFC 6675).
    if (this.modeValue === "sr" && newlySacked.length > 0 && !snd.isEmpty) {
      const lost = snd.markLostBySack(DUP_THRESH);
      if (lost > 0 && !this.inRecovery) this.enterRecovery();
    }
  }

  /** Fast retransmit + fast recovery after three duplicate ACKs. */
  private enterRecovery(): void {
    const snd = this.snd!;
    if (this.inRecovery) return;
    this.inRecovery = true;
    this.recoverPoint = snd.sndNxt;
    this.cc.onTripleDupAck(snd.outstanding);
    this.stats.fastRetransmits++;
    if (this.modeValue === "gbn") snd.markAllLost(); // receiver discarded everything after the hole
    else {
      snd.markFirstLost();
      if (this.modeValue === "sr") snd.markLostBySack(DUP_THRESH);
    }
    this.emitCwnd();
  }

  private sampleSegments(segments: Segment[], now: number): void {
    if (segments.length === 0) return;
    // Karn's rule: an ACK for a retransmitted segment is ambiguous, so take no sample.
    if (segments.some((s) => s.sentCount > 1)) return;
    let latest = segments[0]!.sentAt;
    for (const s of segments) latest = Math.max(latest, s.sentAt);
    this.sampleRtt(now - latest);
  }

  private sampleRtt(ms: number): void {
    this.rtt.sample(ms);
    this.stats.rttSamples++;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Send as much as the congestion and flow-control windows allow. */
  private pump(): void {
    const snd = this.snd;
    if (!snd || this.closed || !this.sm.is("ESTABLISHED", "CLOSE_WAIT", "FIN_WAIT", "LAST_ACK")) return;
    const now = this.clock.now();
    const cwndLimit = Math.max(1, Math.floor(this.cc.cwnd));
    const rwnd = this.probe ? Math.max(1, this.peerWindow) : this.peerWindow;
    const rwndLimit = Math.min(this.maxWindow, rwnd);
    let flight = snd.flight;

    while (flight < cwndLimit) {
      const lost = snd.nextLost();
      if (lost) {
        snd.markRetransmitted(lost, now);
        this.stats.retransmissions++;
        this.transmit(lost);
        flight++;
        continue;
      }
      if (snd.outstanding >= rwndLimit) break;
      if (this.queuedBytes > 0) {
        this.transmit(snd.add(this.takeChunk(this.mss), false, now));
        flight++;
        continue;
      }
      if (this.endRequested && !this.finSent && snd.isEmpty) {
        this.finSent = true;
        this.transmit(snd.add(Buffer.alloc(0), true, now));
        this.sm.transition(this.sm.is("CLOSE_WAIT") ? "LAST_ACK" : "FIN_WAIT");
        flight++;
        continue;
      }
      break;
    }

    if (snd.isEmpty) this.clearTimer("rtxTimer");
    else if (this.rtxTimer === undefined) this.armRtxTimer();

    // Zero window: probe periodically so a lost window update cannot deadlock us.
    const hasWork = this.queuedBytes > 0 || (this.endRequested && !this.finSent);
    if (this.peerWindow === 0 && snd.isEmpty && hasWork && this.persistTimer === undefined) {
      this.persistTimer = this.clock.setTimeout(() => {
        this.persistTimer = undefined;
        this.probe = true;
        this.stats.windowProbes++;
        this.pump();
      }, this.rtt.rto);
    }

    if (this.needDrain && this.queuedBytes < this.highWaterMark) {
      this.needDrain = false;
      this.clock.setTimeout(() => this.emit("drain"), 0); // never re-enter write() from pump()
    }
  }

  private transmit(seg: Segment): void {
    const rcv = this.rcv!;
    this.sendPacket({
      seq: seg.seq,
      ack: rcv.rcvNxt,
      flags: seg.fin ? ACK | FIN : ACK,
      window: rcv.window,
      payload: seg.payload,
    });
    this.stats.segmentsSent++;
    this.stats.bytesSent += seg.payload.length;
  }

  private sendAck(): void {
    const rcv = this.rcv;
    if (!rcv) return;
    const blocks = this.modeValue === "sr" ? rcv.sackBlocks() : [];
    this.sendPacket({
      seq: this.snd ? this.snd.sndNxt : seqAdd(this.isn, 1),
      ack: rcv.rcvNxt,
      flags: blocks.length > 0 ? ACK | SACK : ACK,
      window: rcv.window,
      payload: encodeSack(blocks),
    });
    this.stats.acksSent++;
  }

  private sendPacket(p: Packet): void {
    this.stats.packetsSent++;
    this.link.send(encode(p));
  }

  private takeChunk(max: number): Buffer {
    const parts: Buffer[] = [];
    let need = max;
    while (need > 0 && this.sendQueue.length > 0) {
      const head = this.sendQueue[0]!;
      if (head.length <= need) {
        parts.push(head);
        this.sendQueue.shift();
        need -= head.length;
      } else {
        parts.push(head.subarray(0, need));
        this.sendQueue[0] = head.subarray(need);
        need = 0;
      }
    }
    this.queuedBytes -= max - need;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private armRtxTimer(): void {
    this.rtxTimer = this.clock.setTimeout(() => this.onRtxTimeout(), this.rtt.rto);
  }

  private restartRtxTimer(): void {
    this.clearTimer("rtxTimer");
    if (this.snd && !this.snd.isEmpty) this.armRtxTimer();
  }

  private onRtxTimeout(): void {
    this.rtxTimer = undefined;
    const snd = this.snd;
    if (!snd || snd.isEmpty || this.closed) return;
    this.stats.timeouts++;

    const onlyFin = snd.outstanding === 1 && snd.segments[0]!.fin;
    if (this.peerWindow > 0) this.consecutiveTimeouts++; // a zero-window probe never gives up
    if (this.consecutiveTimeouts > (onlyFin ? FIN_RETRIES : this.maxRetries)) {
      if (onlyFin) {
        // All data was acknowledged before the FIN went out; the peer has most
        // likely closed already. Treat the connection as finished.
        this.finAcked = true;
        snd.ack(snd.sndNxt);
        this.finishClose();
        return;
      }
      this.shutdown(new Error(`connection timed out after ${this.consecutiveTimeouts} retransmission timeouts`));
      return;
    }

    this.cc.onTimeout(snd.outstanding);
    this.inRecovery = false;
    this.dupAcks = 0;
    this.rtt.backoff();
    snd.markAllLost(); // GBN resends everything; SR skips what was SACKed
    this.emitCwnd();
    this.pump();
  }

  private clearTimer(name: "rtxTimer" | "handshakeTimer" | "persistTimer" | "timeWaitTimer"): void {
    const t = this[name];
    if (t !== undefined) {
      this.clock.clearTimeout(t);
      this[name] = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  private checkClose(): void {
    if (this.closed) return;
    if (this.finAcked && !this.finishEmitted) {
      this.finishEmitted = true;
      this.emit("finish");
      if (this.closed) return;
    }
    if (this.sm.is("FIN_WAIT") && this.finAcked && this.peerFin) {
      this.sm.transition("TIME_WAIT");
      this.clearTimer("rtxTimer");
      this.timeWaitTimer = this.clock.setTimeout(() => this.shutdown(), this.timeWaitMs);
    } else if (this.sm.is("LAST_ACK") && this.finAcked) {
      this.shutdown();
    }
  }

  private finishClose(): void {
    if (!this.finishEmitted) {
      this.finishEmitted = true;
      this.emit("finish");
    }
    this.shutdown();
  }

  private shutdown(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of ["rtxTimer", "handshakeTimer", "persistTimer", "timeWaitTimer"] as const) this.clearTimer(t);
    if (!this.sm.is("CLOSED")) this.sm.transition("CLOSED");
    if (err && this.listenerCount("error") > 0) this.emit("error", err);
    this.emit("close", err);
  }

  private makeCongestionControl(): CongestionControl {
    if (this.modeValue === "saw") return new FixedWindow(1);
    if (this.ccKind === "none") return new FixedWindow(this.maxWindow);
    return new Reno({ maxCwnd: this.maxWindow });
  }

  private emitCwnd(): void {
    const { cwnd, ssthresh } = this.cc;
    if (cwnd === this.lastCwnd && ssthresh === this.lastSsthresh) return;
    this.lastCwnd = cwnd;
    this.lastSsthresh = ssthresh;
    this.emit("cwnd", { t: this.clock.now() - this.startedAt, cwnd, ssthresh });
  }
}
