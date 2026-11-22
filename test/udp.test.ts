import { describe, expect, it } from "vitest";
import { connect, listen } from "../src/udp.js";
import { randomData, sha256 } from "./helpers.js";

describe("over a real UDP socket on localhost", () => {
  it.each(["sr", "gbn"] as const)("transfers 2 MB intact with %s", async (mode) => {
    const data = randomData(2 << 20, 123);
    const { connection: server, address } = await listen(0, { host: "127.0.0.1", timeWaitMs: 50 });
    const chunks: Buffer[] = [];
    server.on("data", (c) => chunks.push(c));
    const serverClosed = new Promise<void>((resolve) => server.once("close", () => resolve()));

    const client = await connect("127.0.0.1", address.port, { mode, timeWaitMs: 50 });
    const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    client.end(data);
    await Promise.all([serverClosed, clientClosed]);

    const received = Buffer.concat(chunks);
    expect(received.length).toBe(data.length);
    expect(sha256(received)).toBe(sha256(data));
    expect(server.mode).toBe(mode);
  });

  it("rejects connect() when nobody is listening", async () => {
    await expect(
      connect("127.0.0.1", 9, { maxRetries: 2, rtt: { initialRto: 50, minRto: 50 } }),
    ).rejects.toThrow(/handshake timed out/);
  });
});
