/**
 * Congestion control, TCP Reno/NewReno style (RFC 5681, RFC 6582). The
 * congestion window (cwnd) is counted in segments.
 *
 *   slow start           cwnd < ssthresh: +1 per ACKed segment (doubles every RTT)
 *   congestion avoidance cwnd ≥ ssthresh: +1/cwnd per ACKed segment (≈ +1 per RTT)
 *   3 duplicate ACKs     ssthresh = flight/2, cwnd = ssthresh (halve), enter fast recovery
 *   timeout              ssthresh = flight/2, cwnd = 1, back to slow start
 *
 * Fast recovery lasts until everything that was outstanding when the loss was
 * detected has been acknowledged, so a burst of losses only halves cwnd once.
 */
export interface CongestionControl {
  readonly cwnd: number;
  readonly ssthresh: number;
  readonly inRecovery: boolean;
  /** `acked` segments were newly acknowledged; `exitsRecovery` if the ACK covered the recovery point. */
  onAck(acked: number, exitsRecovery: boolean): void;
  /** Returns true if this triggered a fast retransmit (false if already recovering). */
  onTripleDupAck(flight: number): boolean;
  onTimeout(flight: number): void;
}

export interface RenoOptions {
  initialCwnd?: number;
  initialSsthresh?: number;
  /** Upper bound on cwnd; there is no point growing past the receiver's buffer. */
  maxCwnd?: number;
}

export class Reno implements CongestionControl {
  private cwndSegs: number;
  private ssthreshSegs: number;
  private recovering = false;
  private readonly maxCwnd: number;

  constructor(opts: RenoOptions = {}) {
    this.cwndSegs = opts.initialCwnd ?? 1;
    this.maxCwnd = opts.maxCwnd ?? 1024;
    this.ssthreshSegs = opts.initialSsthresh ?? this.maxCwnd;
  }

  get cwnd(): number {
    return this.cwndSegs;
  }
  get ssthresh(): number {
    return this.ssthreshSegs;
  }
  get inRecovery(): boolean {
    return this.recovering;
  }

  onAck(acked: number, exitsRecovery: boolean): void {
    if (this.recovering) {
      if (!exitsRecovery) return; // partial ACK: retransmit the next hole, don't grow
      this.recovering = false;
      this.cwndSegs = this.ssthreshSegs; // deflate the window
      return;
    }
    for (let i = 0; i < acked; i++) {
      if (this.cwndSegs < this.ssthreshSegs) this.cwndSegs += 1;
      else this.cwndSegs += 1 / this.cwndSegs;
    }
    this.cwndSegs = Math.min(this.cwndSegs, this.maxCwnd);
  }

  onTripleDupAck(flight: number): boolean {
    if (this.recovering) return false;
    this.ssthreshSegs = Math.max(Math.floor(flight / 2), 2);
    this.cwndSegs = this.ssthreshSegs;
    this.recovering = true;
    return true;
  }

  onTimeout(flight: number): void {
    this.ssthreshSegs = Math.max(Math.floor(flight / 2), 2);
    this.cwndSegs = 1;
    this.recovering = false;
  }
}

/** No congestion control: a fixed window (window = 1 gives stop-and-wait). */
export class FixedWindow implements CongestionControl {
  readonly inRecovery = false;
  constructor(readonly cwnd: number) {}
  get ssthresh(): number {
    return this.cwnd;
  }
  onAck(): void {}
  onTripleDupAck(): boolean {
    return true; // still allow the fast retransmit itself
  }
  onTimeout(): void {}
}
