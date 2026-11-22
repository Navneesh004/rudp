import { describe, expect, it } from "vitest";
import { Connection } from "../src/connection.js";
import { decode, SYN } from "../src/packet.js";
import { SimClock } from "../src/sim/clock.js";
import { createLinkPair } from "../src/sim/link.js";
import { mulberry32 } from "../src/sim/random.js";
import { sha256, simulateTransfer } from "./helpers.js";

const MB = 1 << 20;

function expectIntact(r: ReturnType<typeof simulateTransfer>) {
  expect(r.errors).toEqual([]);
  expect(r.received.length).toBe(r.data.length);
  expect(sha256(r.received)).toBe(sha256(r.data));
  expect(r.client.state).toBe("CLOSED");
  expect(r.server.state).toBe("CLOSED");
}

describe("handshake and teardown", () => {
  it("walks both state machines through open and close", () => {
    const r = simulateTransfer({ size: 10_000 });
    expectIntact(r);
    expect(r.client.stateHistory).toEqual(["CLOSED", "SYN_SENT", "ESTABLISHED", "FIN_WAIT", "TIME_WAIT", "CLOSED"]);
    expect(r.server.stateHistory).toEqual([
      "CLOSED",
      "LISTEN",
      "SYN_RECEIVED",
      "ESTABLISHED",
      "CLOSE_WAIT",
      "LAST_ACK",
      "CLOSED",
    ]);
  });

  it("server adopts the client's reliability mode from the SYN", () => {
    const r = simulateTransfer({ mode: "gbn", size: 5_000 });
    expect(r.server.mode).toBe("gbn");
  });

  it("survives losing the first SYN, SYN+ACK and final ACK", () => {
    let dropped = 0;
    const r = simulateTransfer({
      size: 20_000,
      setup: ({ links }) => {
        // Drop the first three handshake packets in either direction.
        for (const link of [links.a, links.b]) {
          const send = link.send.bind(link);
          link.send = (d: Buffer) => {
            const p = decode(d);
            const isHandshake = p && (p.flags & SYN || p.payload.length === 0);
            if (isHandshake && dropped < 3) {
              dropped++;
              return;
            }
            send(d);
          };
        }
      },
    });
    expectIntact(r);
    expect(dropped).toBe(3);
    expect(r.client.stats.retransmissions + r.server.stats.retransmissions).toBeGreaterThan(0);
  });

  it("gives up with an error when the peer never answers", () => {
    const clock = new SimClock();
    const { a } = createLinkPair(clock, mulberry32(1), { loss: 1 });
    const client = new Connection({ link: a, clock, maxRetries: 4 });
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e));
    client.connect();
    clock.run();
    expect(client.state).toBe("CLOSED");
    expect(errors[0]?.message).toMatch(/handshake timed out/);
  });

  it("times out an established connection whose path dies", () => {
    const r = simulateTransfer({
      size: 200_000,
      client: { maxRetries: 5 },
      setup: ({ clock, links }) => {
        clock.setTimeout(() => (links.a.down = true), 100);
      },
    });
    expect(r.errors[0]?.message).toMatch(/timed out/);
    expect(r.client.state).toBe("CLOSED");
  });

  it("rejects writes after end()", () => {
    const clock = new SimClock();
    const { a } = createLinkPair(clock, mulberry32(1), {});
    const c = new Connection({ link: a, clock });
    c.end();
    expect(() => c.write("x")).toThrow(/write after end/);
  });
});

describe("reliable transfer over a lossy link", () => {
  it.each([0, 0.1, 0.3])("1 MB with selective repeat at %s loss arrives intact", (loss) => {
    const r = simulateTransfer({ mode: "sr", size: MB, forward: { loss, delay: 20, jitter: 5 }, seed: 42 });
    expectIntact(r);
    if (loss > 0) expect(r.client.stats.retransmissions).toBeGreaterThan(0);
  });

  it("never retransmits on a clean link without reordering", () => {
    const r = simulateTransfer({ size: MB, forward: { delay: 20 } });
    expectIntact(r);
    expect(r.client.stats.retransmissions).toBe(0);
    expect(r.client.stats.timeouts).toBe(0);
  });

  it.each(["saw", "gbn"] as const)("1 MB with %s at 10%% loss arrives intact", (mode) => {
    const r = simulateTransfer({ mode, size: MB, forward: { loss: 0.1, delay: 20 }, seed: 7 });
    expectIntact(r);
  });

  it("survives reordering, duplication and corruption together", () => {
    const r = simulateTransfer({
      size: 512 * 1024,
      forward: { loss: 0.05, delay: 15, jitter: 40, duplicate: 0.05, corrupt: 0.05 },
      seed: 99,
    });
    expectIntact(r);
    expect(r.server.stats.corruptDropped).toBeGreaterThan(0);
    expect(r.server.stats.outOfOrder).toBeGreaterThan(0);
    expect(r.server.stats.duplicatesReceived).toBeGreaterThan(0);
  });

  it("handles sequence numbers that wrap past 2^32 mid-transfer", () => {
    const r = simulateTransfer({
      size: 300_000,
      forward: { loss: 0.05, delay: 10 },
      client: { isn: () => 0xffffffff - 100_000 },
    });
    expectIntact(r);
  });

  it.each([1, 2, 3, 4, 5])("is correct for random seed %i at 20%% loss with jitter", (seed) => {
    const r = simulateTransfer({ size: 200_000, forward: { loss: 0.2, delay: 10, jitter: 20 }, seed });
    expectIntact(r);
  });
});

describe("protocol behaviour", () => {
  const lossy = { loss: 0.1, delay: 25 };

  it("selective repeat retransmits less and finishes sooner than Go-Back-N", () => {
    const sr = simulateTransfer({ mode: "sr", size: MB, forward: lossy, seed: 3 });
    const gbn = simulateTransfer({ mode: "gbn", size: MB, forward: lossy, seed: 3 });
    expectIntact(sr);
    expectIntact(gbn);
    expect(sr.client.stats.retransmissions).toBeLessThan(gbn.client.stats.retransmissions);
    expect(sr.completedAt!).toBeLessThan(gbn.completedAt!);
  });

  it("Go-Back-N is much faster than stop-and-wait", () => {
    const gbn = simulateTransfer({ mode: "gbn", size: 256 * 1024, forward: { delay: 25 } });
    const saw = simulateTransfer({ mode: "saw", size: 256 * 1024, forward: { delay: 25 } });
    expect(gbn.completedAt! * 5).toBeLessThan(saw.completedAt!);
  });

  it("uses fast retransmit on duplicate ACKs, not only timeouts", () => {
    const r = simulateTransfer({ size: MB, forward: { loss: 0.02, delay: 25 }, seed: 11 });
    expectIntact(r);
    expect(r.client.stats.fastRetransmits).toBeGreaterThan(0);
    expect(r.client.stats.dupAcks).toBeGreaterThan(0);
  });

  it("slow start grows cwnd, and loss shrinks it (sawtooth)", () => {
    const samples: { cwnd: number }[] = [];
    const r = simulateTransfer({
      size: 2 * MB,
      // A bandwidth-limited bottleneck with a finite queue makes the sender
      // overflow it, like a real router.
      forward: { delay: 20, bandwidth: 1000, queueLimit: 60 },
      reverse: { delay: 20 },
      setup: ({ client }) => client.on("cwnd", (s) => samples.push(s)),
    });
    expectIntact(r);
    const cwnds = samples.map((s) => s.cwnd);
    expect(cwnds[0]).toBe(1);
    expect(Math.max(...cwnds)).toBeGreaterThan(30);
    let decreases = 0;
    for (let i = 1; i < cwnds.length; i++) if (cwnds[i]! < cwnds[i - 1]! * 0.75) decreases++;
    expect(decreases).toBeGreaterThan(0);
  });

  it("measures RTT and keeps the RTO within bounds", () => {
    const r = simulateTransfer({ size: 300_000, forward: { delay: 50, jitter: 10, loss: 0.05 } });
    expectIntact(r);
    const s = r.client.summary();
    expect(s.rttSamples).toBeGreaterThan(10);
    expect(s.srtt!).toBeGreaterThan(95);
    expect(s.srtt!).toBeLessThan(200);
    expect(s.rto).toBeGreaterThanOrEqual(200);
    expect(s.rto).toBeLessThanOrEqual(60_000);
  });

  it("flow control: a paused receiver stalls the sender without losing data", () => {
    let maxInFlight = 0;
    const r = simulateTransfer({
      size: 400_000,
      forward: { delay: 10 },
      server: { recvBuffer: 16 },
      setup: ({ clock, client, server, links }) => {
        server.once("connect", () => {
          server.pause();
          clock.setTimeout(() => server.resume(), 5_000);
        });
        const send = links.a.send.bind(links.a);
        links.a.send = (d: Buffer) => {
          send(d);
          maxInFlight = Math.max(maxInFlight, client.inFlight);
        };
      },
    });
    expectIntact(r);
    expect(r.completedAt!).toBeGreaterThan(5_000);
    expect(r.client.stats.windowProbes).toBeGreaterThan(0);
    // Never more than the receiver's 16-segment window in flight.
    expect(maxInFlight).toBeLessThanOrEqual(16);
  });

  it("transfers data in both directions at once", () => {
    const clock = new SimClock();
    const { a, b } = createLinkPair(clock, mulberry32(5), { loss: 0.1, delay: 10 });
    const client = new Connection({ link: a, clock });
    const server = new Connection({ link: b, clock });
    const up = Buffer.alloc(100_000, 1);
    const down = Buffer.alloc(150_000, 2);
    const gotUp: Buffer[] = [];
    const gotDown: Buffer[] = [];
    server.on("data", (c) => gotUp.push(c));
    client.on("data", (c) => gotDown.push(c));
    server.on("connect", () => server.write(down));
    client.on("connect", () => client.end(up));
    server.listen();
    client.connect();
    clock.run();
    expect(Buffer.concat(gotUp).equals(up)).toBe(true);
    expect(Buffer.concat(gotDown).equals(down)).toBe(true);
    expect(client.state).toBe("CLOSED");
    expect(server.state).toBe("CLOSED");
  });
});
