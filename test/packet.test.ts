import { describe, expect, it } from "vitest";
import {
  ACK,
  FIN,
  HEADER,
  SACK,
  SYN,
  decode,
  decodeSack,
  describeFlags,
  encode,
  encodeSack,
  seqAdd,
  seqDiff,
  seqGt,
  seqLt,
  type Packet,
} from "../src/packet.js";

const sample: Packet = {
  seq: 0xdeadbeef,
  ack: 12345,
  flags: SYN | ACK,
  window: 256,
  payload: Buffer.from("hello, reliable world"),
};

describe("packet encode/decode", () => {
  it("has a 17-byte header", () => {
    expect(encode({ ...sample, payload: Buffer.alloc(0) }).length).toBe(HEADER);
    expect(encode(sample).length).toBe(HEADER + sample.payload.length);
  });

  it("round-trips every field", () => {
    const decoded = decode(encode(sample));
    expect(decoded).not.toBeNull();
    expect(decoded!.seq).toBe(sample.seq);
    expect(decoded!.ack).toBe(sample.ack);
    expect(decoded!.flags).toBe(sample.flags);
    expect(decoded!.window).toBe(sample.window);
    expect(decoded!.payload.equals(sample.payload)).toBe(true);
  });

  it("round-trips an empty payload and maximum field values", () => {
    const p: Packet = { seq: 0xffffffff, ack: 0xffffffff, flags: FIN | ACK, window: 0xffff, payload: Buffer.alloc(0) };
    expect(decode(encode(p))).toEqual(p);
  });

  it("returns null when any single byte is flipped", () => {
    const buf = encode(sample);
    for (let i = 0; i < buf.length; i++) {
      const bad = Buffer.from(buf);
      bad[i] = bad[i]! ^ 0x01;
      expect(decode(bad), `byte ${i}`).toBeNull();
    }
  });

  it("rejects truncated, padded and too-short buffers", () => {
    const buf = encode(sample);
    expect(decode(buf.subarray(0, buf.length - 1))).toBeNull();
    expect(decode(Buffer.concat([buf, Buffer.from([0])]))).toBeNull();
    expect(decode(Buffer.alloc(5))).toBeNull();
  });

  it("refuses to encode unknown flags or oversized payloads", () => {
    expect(() => encode({ ...sample, flags: 64 })).toThrow(RangeError);
    expect(() => encode({ ...sample, payload: Buffer.alloc(70_000) })).toThrow(RangeError);
  });
});

describe("SACK blocks", () => {
  it("round-trip", () => {
    const blocks = [
      [100, 200],
      [0xfffffff0, 16],
    ] as const;
    expect(decodeSack(encodeSack(blocks))).toEqual(blocks);
  });

  it("describes flags", () => {
    expect(describeFlags(SYN | ACK)).toBe("SYN|ACK");
    expect(describeFlags(ACK | SACK)).toBe("ACK|SACK");
    expect(describeFlags(0)).toBe("-");
  });
});

describe("sequence arithmetic", () => {
  it("wraps around 2^32", () => {
    expect(seqAdd(0xffffffff, 1)).toBe(0);
    expect(seqAdd(0xfffffff0, 0x20)).toBe(0x10);
    expect(seqDiff(5, 0xfffffffb)).toBe(10);
    expect(seqLt(0xfffffff0, 5)).toBe(true);
    expect(seqGt(5, 0xfffffff0)).toBe(true);
    expect(seqLt(5, 5)).toBe(false);
  });
});
