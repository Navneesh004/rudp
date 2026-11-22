import { describe, expect, it } from "vitest";
import { seqAdd } from "../src/packet.js";
import { ReceiveWindow, SendWindow } from "../src/window.js";

const data = (n: number, fill = 0) => Buffer.alloc(n, fill);

describe("SendWindow", () => {
  it("tracks sndUna/sndNxt and removes cumulatively ACKed segments", () => {
    const w = new SendWindow(1000);
    w.add(data(100), false, 0);
    w.add(data(100), false, 0);
    w.add(data(100), false, 0);
    expect(w.sndNxt).toBe(1300);
    const res = w.ack(1200);
    expect(res.removed.map((s) => s.seq)).toEqual([1000, 1100]);
    expect(w.sndUna).toBe(1200);
    expect(w.outstanding).toBe(1);
  });

  it("ignores old and impossible ACKs", () => {
    const w = new SendWindow(1000);
    w.add(data(100), false, 0);
    expect(w.ack(1000).removed).toHaveLength(0);
    expect(w.ack(5000).removed).toHaveLength(0);
    expect(w.sndUna).toBe(1000);
  });

  it("a FIN consumes one sequence number", () => {
    const w = new SendWindow(10);
    w.add(Buffer.alloc(0), true, 0);
    expect(w.sndNxt).toBe(11);
  });

  it("applies SACK blocks and excludes SACKed segments from flight", () => {
    const w = new SendWindow(0);
    for (let i = 0; i < 5; i++) w.add(data(100), false, 0);
    const newly = w.applySack([[200, 400]]);
    expect(newly.map((s) => s.seq)).toEqual([200, 300]);
    expect(w.flight).toBe(3);
    const res = w.ack(400);
    expect(res.removed).toHaveLength(4);
    expect(res.newlyAcked.map((s) => s.seq)).toEqual([0, 100]); // 200, 300 were already SACKed
  });

  it("detects loss after three SACKed segments above a hole", () => {
    const w = new SendWindow(0);
    for (let i = 0; i < 6; i++) w.add(data(100), false, 0);
    w.applySack([[100, 300]]);
    expect(w.markLostBySack(3)).toBe(0);
    w.applySack([[300, 400]]);
    expect(w.markLostBySack(3)).toBe(1);
    expect(w.nextLost()?.seq).toBe(0);
    w.markRetransmitted(w.nextLost()!, 5);
    expect(w.nextLost()).toBeUndefined();
    expect(w.segments[0]!.sentCount).toBe(2);
  });

  it("markAllLost skips SACKed segments (selective repeat resends only holes)", () => {
    const w = new SendWindow(0);
    for (let i = 0; i < 4; i++) w.add(data(100), false, 0);
    w.applySack([[100, 200]]);
    expect(w.markAllLost()).toBe(3);
    expect(w.flight).toBe(0);
  });

  it("works across sequence-number wraparound", () => {
    const isn = 0xffffff00;
    const w = new SendWindow(isn);
    w.add(data(200), false, 0);
    w.add(data(200), false, 0);
    expect(w.sndNxt).toBe(seqAdd(isn, 400));
    w.ack(seqAdd(isn, 200));
    expect(w.outstanding).toBe(1);
    w.ack(seqAdd(isn, 400));
    expect(w.isEmpty).toBe(true);
  });
});

describe("ReceiveWindow", () => {
  it("delivers in-order data and advances rcvNxt", () => {
    const r = new ReceiveWindow(500, 16, true);
    const res = r.receive(500, data(10, 1));
    expect(res.delivered).toHaveLength(1);
    expect(r.rcvNxt).toBe(510);
  });

  it("buffers out-of-order segments in selective-repeat mode", () => {
    const r = new ReceiveWindow(0, 16, true);
    expect(r.receive(10, data(10, 2)).outOfOrder).toBe(true);
    expect(r.receive(30, data(10, 4)).outOfOrder).toBe(true);
    expect(r.sackBlocks()).toEqual([
      [10, 20],
      [30, 40],
    ]);
    const res = r.receive(0, data(10, 1));
    expect(Buffer.concat(res.delivered)).toEqual(Buffer.concat([data(10, 1), data(10, 2)]));
    expect(r.rcvNxt).toBe(20);
    expect(r.sackBlocks()).toEqual([[30, 40]]);
  });

  it("merges adjacent SACK blocks", () => {
    const r = new ReceiveWindow(0, 16, true);
    r.receive(10, data(10));
    r.receive(20, data(10));
    expect(r.sackBlocks()).toEqual([[10, 30]]);
  });

  it("discards out-of-order segments in Go-Back-N mode", () => {
    const r = new ReceiveWindow(0, 16, false);
    expect(r.receive(10, data(10)).dropped).toBe(true);
    expect(r.sackBlocks()).toEqual([]);
  });

  it("flags duplicates", () => {
    const r = new ReceiveWindow(0, 16, true);
    r.receive(0, data(10));
    expect(r.receive(0, data(10)).duplicate).toBe(true);
  });

  it("holds data while paused and shrinks the advertised window", () => {
    const r = new ReceiveWindow(0, 2, true);
    r.pause();
    expect(r.receive(0, data(10)).delivered).toHaveLength(0);
    expect(r.window).toBe(1);
    r.receive(10, data(10));
    expect(r.window).toBe(0);
    expect(r.receive(20, data(10)).dropped).toBe(true); // buffer full
    expect(r.resume()).toHaveLength(2);
    expect(r.window).toBe(2);
  });

  it("orders SACK blocks correctly across wraparound", () => {
    const r = new ReceiveWindow(0xfffffff0, 16, true);
    r.receive(0x10, data(16));
    r.receive(0xfffffff8, data(8));
    expect(r.sackBlocks()).toEqual([
      [0xfffffff8, 0],
      [0x10, 0x20],
    ]);
  });
});
