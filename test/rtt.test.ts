import { describe, expect, it } from "vitest";
import { RttEstimator } from "../src/rtt.js";

describe("RTT estimator (RFC 6298)", () => {
  it("starts at the initial RTO", () => {
    expect(new RttEstimator().rto).toBe(1000);
    expect(new RttEstimator().srtt).toBeUndefined();
  });

  it("initialises SRTT and RTTVAR from the first sample", () => {
    const r = new RttEstimator({ minRto: 0 });
    r.sample(100);
    expect(r.srtt).toBe(100);
    expect(r.rttvar).toBe(50);
    expect(r.rto).toBe(300); // 100 + 4 * 50
  });

  it("applies the smoothing formula to later samples", () => {
    const r = new RttEstimator({ minRto: 0 });
    r.sample(100);
    r.sample(200);
    // RTTVAR = 0.75*50 + 0.25*|100-200| = 62.5 ; SRTT = 0.875*100 + 0.125*200 = 112.5
    expect(r.rttvar).toBeCloseTo(62.5);
    expect(r.srtt).toBeCloseTo(112.5);
    expect(r.rto).toBeCloseTo(362.5);
  });

  it("converges on a steady RTT and respects the minimum", () => {
    const r = new RttEstimator({ minRto: 200 });
    for (let i = 0; i < 200; i++) r.sample(10);
    expect(r.srtt).toBeCloseTo(10);
    expect(r.rto).toBe(200);
  });

  it("doubles on backoff, capped at the maximum", () => {
    const r = new RttEstimator({ initialRto: 1000, maxRto: 5000 });
    r.backoff();
    expect(r.rto).toBe(2000);
    r.backoff();
    r.backoff();
    expect(r.rto).toBe(5000);
  });

  it("recomputes from SRTT on the next valid sample after backoff", () => {
    const r = new RttEstimator({ minRto: 0 });
    r.sample(100);
    r.backoff();
    r.backoff();
    expect(r.rto).toBe(1200);
    r.sample(100);
    expect(r.rto).toBeLessThan(400);
  });

  it("resetBackoff restores the RTO computed from SRTT", () => {
    const r = new RttEstimator({ minRto: 0 });
    r.resetBackoff(); // no sample yet: no-op
    expect(r.rto).toBe(1000);
    r.sample(100);
    r.backoff();
    r.backoff();
    r.resetBackoff();
    expect(r.rto).toBe(300);
  });

  it("ignores invalid samples", () => {
    const r = new RttEstimator();
    r.sample(-5);
    r.sample(Number.NaN);
    expect(r.srtt).toBeUndefined();
  });

  it("keeps RTO within bounds for random samples", () => {
    const r = new RttEstimator({ minRto: 200, maxRto: 60_000 });
    for (let i = 0; i < 1000; i++) {
      r.sample(Math.random() * 5000);
      if (i % 7 === 0) r.backoff();
      expect(r.rto).toBeGreaterThanOrEqual(200);
      expect(r.rto).toBeLessThanOrEqual(60_000);
    }
  });
});
