/**
 * Retransmission-timeout calculation from RFC 6298.
 *
 *   first sample R:   SRTT = R,  RTTVAR = R/2
 *   later samples:    RTTVAR = (1 - β)·RTTVAR + β·|SRTT - R|
 *                     SRTT   = (1 - α)·SRTT   + α·R
 *   RTO = max(minRto, SRTT + max(G, 4·RTTVAR)),  α = 1/8, β = 1/4
 *
 * Karn's rule (only sample segments that were never retransmitted) is applied
 * by the caller, which is the only place that knows a segment's history.
 * backoff() doubles the RTO after a timeout; the next valid sample recomputes it.
 */
export interface RttOptions {
  /** RTO before any sample has been taken (RFC 6298 says 1 s). */
  initialRto?: number;
  /** Lower bound on the RTO in ms (RFC 6298 recommends 1 s; Linux uses 200 ms). */
  minRto?: number;
  /** Upper bound on the RTO in ms. */
  maxRto?: number;
  /** Clock granularity G in ms. */
  granularity?: number;
}

const ALPHA = 1 / 8;
const BETA = 1 / 4;
const K = 4;

export class RttEstimator {
  private srttMs: number | undefined;
  private rttvarMs = 0;
  private rtoMs: number;
  readonly minRto: number;
  readonly maxRto: number;
  private readonly granularity: number;

  constructor(opts: RttOptions = {}) {
    this.minRto = opts.minRto ?? 200;
    this.maxRto = opts.maxRto ?? 60_000;
    this.granularity = opts.granularity ?? 1;
    this.rtoMs = this.clamp(opts.initialRto ?? 1000);
  }

  /** Feed one measured round-trip time, in milliseconds. */
  sample(rtt: number): void {
    if (!(rtt >= 0) || !Number.isFinite(rtt)) return;
    if (this.srttMs === undefined) {
      this.srttMs = rtt;
      this.rttvarMs = rtt / 2;
    } else {
      this.rttvarMs = (1 - BETA) * this.rttvarMs + BETA * Math.abs(this.srttMs - rtt);
      this.srttMs = (1 - ALPHA) * this.srttMs + ALPHA * rtt;
    }
    this.rtoMs = this.clamp(this.srttMs + Math.max(this.granularity, K * this.rttvarMs));
  }

  /** Exponential backoff after a retransmission timeout (RFC 6298 §5.5). */
  backoff(): void {
    this.rtoMs = this.clamp(this.rtoMs * 2);
  }

  /**
   * Undo backoff once an ACK shows the path is delivering again. Under Karn's
   * rule there may be no fresh sample to do it, which at high loss leaves the
   * RTO stuck at its backed-off value; Linux resets it the same way.
   */
  resetBackoff(): void {
    if (this.srttMs === undefined) return;
    this.rtoMs = this.clamp(this.srttMs + Math.max(this.granularity, K * this.rttvarMs));
  }

  get rto(): number {
    return this.rtoMs;
  }

  get srtt(): number | undefined {
    return this.srttMs;
  }

  get rttvar(): number {
    return this.rttvarMs;
  }

  private clamp(v: number): number {
    return Math.min(this.maxRto, Math.max(this.minRto, v));
  }
}
