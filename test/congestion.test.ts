import { describe, expect, it } from "vitest";
import { FixedWindow, Reno } from "../src/congestion.js";

describe("Reno congestion control", () => {
  it("doubles cwnd every round trip in slow start", () => {
    const cc = new Reno({ initialSsthresh: 64 });
    const history = [cc.cwnd];
    for (let rtt = 0; rtt < 5; rtt++) {
      const inFlight = Math.floor(cc.cwnd);
      cc.onAck(inFlight, false); // one ACK per segment of the window
      history.push(cc.cwnd);
    }
    expect(history).toEqual([1, 2, 4, 8, 16, 32]);
  });

  it("grows by about one segment per round trip above ssthresh", () => {
    const cc = new Reno({ initialCwnd: 10, initialSsthresh: 10 });
    cc.onAck(10, false);
    expect(cc.cwnd).toBeGreaterThan(10.9);
    expect(cc.cwnd).toBeLessThan(11.1);
  });

  it("halves cwnd on three duplicate ACKs, once per recovery", () => {
    const cc = new Reno({ initialCwnd: 40, initialSsthresh: 20 });
    expect(cc.onTripleDupAck(40)).toBe(true);
    expect(cc.cwnd).toBe(20);
    expect(cc.ssthresh).toBe(20);
    expect(cc.inRecovery).toBe(true);
    expect(cc.onTripleDupAck(40)).toBe(false); // second loss in the same window
    expect(cc.cwnd).toBe(20);
    cc.onAck(5, false); // partial ACK: no growth
    expect(cc.cwnd).toBe(20);
    cc.onAck(5, true); // full ACK: leave recovery
    expect(cc.inRecovery).toBe(false);
    expect(cc.cwnd).toBe(20);
  });

  it("resets to one segment on timeout", () => {
    const cc = new Reno({ initialCwnd: 30 });
    cc.onTimeout(30);
    expect(cc.cwnd).toBe(1);
    expect(cc.ssthresh).toBe(15);
    cc.onAck(1, false);
    expect(cc.cwnd).toBe(2); // slow start again
  });

  it("never sets ssthresh below 2 and never exceeds maxCwnd", () => {
    const cc = new Reno({ maxCwnd: 50 });
    cc.onTimeout(1);
    expect(cc.ssthresh).toBe(2);
    const big = new Reno({ maxCwnd: 50, initialSsthresh: 1000 });
    big.onAck(500, false);
    expect(big.cwnd).toBe(50);
  });

  it("FixedWindow never changes", () => {
    const cc = new FixedWindow(1);
    cc.onAck();
    cc.onTimeout();
    expect(cc.cwnd).toBe(1);
  });
});
