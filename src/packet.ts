/**
 * Wire format of an RUDP packet.
 *
 *  0               4               8   9       11      13              17
 *  +---------------+---------------+---+-------+-------+---------------+---------
 *  |      seq      |      ack      |flg| window| length|   checksum    | payload
 *  +---------------+---------------+---+-------+-------+---------------+---------
 *
 *  seq       uint32  sequence number of the first payload byte (SYN and FIN use one number)
 *  ack       uint32  next byte expected from the other side (cumulative)
 *  flags     uint8   SYN=1, ACK=2, FIN=4, SACK=8
 *  window    uint16  receiver's free buffer space, in segments (flow control)
 *  length    uint16  payload length in bytes
 *  checksum  uint32  CRC32 of header + payload, computed with this field zeroed
 *
 * All integers are big-endian (network byte order).
 */
import { crc32 } from "node:zlib";

export const SYN = 1;
export const ACK = 2;
export const FIN = 4;
/** The payload is a list of SACK blocks rather than application data. */
export const SACK = 8;

export const HEADER = 17;
export const MAX_PAYLOAD = 0xffff;
const CHECKSUM_OFFSET = 13;
const KNOWN_FLAGS = SYN | ACK | FIN | SACK;

export interface Packet {
  seq: number;
  ack: number;
  flags: number;
  window: number;
  payload: Buffer;
}

export function encode(p: Packet): Buffer {
  if (p.payload.length > MAX_PAYLOAD) throw new RangeError(`payload too large: ${p.payload.length}`);
  if ((p.flags & ~KNOWN_FLAGS) !== 0) throw new RangeError(`unknown flags: ${p.flags}`);
  const buf = Buffer.alloc(HEADER + p.payload.length);
  buf.writeUInt32BE(p.seq >>> 0, 0);
  buf.writeUInt32BE(p.ack >>> 0, 4);
  buf.writeUInt8(p.flags, 8);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, p.window)), 9);
  buf.writeUInt16BE(p.payload.length, 11);
  p.payload.copy(buf, HEADER);
  buf.writeUInt32BE(crc32(buf), CHECKSUM_OFFSET); // checksum field is still zero here
  return buf;
}

/** Returns null for anything malformed or corrupted, so callers can simply drop it. */
export function decode(buf: Buffer): Packet | null {
  if (buf.length < HEADER) return null;
  const len = buf.readUInt16BE(11);
  if (buf.length !== HEADER + len) return null;
  const flags = buf.readUInt8(8);
  if ((flags & ~KNOWN_FLAGS) !== 0) return null;

  const header = Buffer.from(buf.subarray(0, HEADER));
  header.writeUInt32BE(0, CHECKSUM_OFFSET);
  const sum = crc32(buf.subarray(HEADER), crc32(header));
  if (sum !== buf.readUInt32BE(CHECKSUM_OFFSET)) return null;

  return {
    seq: buf.readUInt32BE(0),
    ack: buf.readUInt32BE(4),
    flags,
    window: buf.readUInt16BE(9),
    payload: buf.subarray(HEADER, HEADER + len),
  };
}

/** A SACK block covers the half-open byte range [start, end). */
export type SackBlock = readonly [start: number, end: number];

export function encodeSack(blocks: readonly SackBlock[]): Buffer {
  const buf = Buffer.alloc(blocks.length * 8);
  blocks.forEach(([start, end], i) => {
    buf.writeUInt32BE(start >>> 0, i * 8);
    buf.writeUInt32BE(end >>> 0, i * 8 + 4);
  });
  return buf;
}

export function decodeSack(buf: Buffer): SackBlock[] {
  const blocks: SackBlock[] = [];
  for (let off = 0; off + 8 <= buf.length; off += 8) {
    blocks.push([buf.readUInt32BE(off), buf.readUInt32BE(off + 4)]);
  }
  return blocks;
}

export function describeFlags(flags: number): string {
  const names: string[] = [];
  if (flags & SYN) names.push("SYN");
  if (flags & ACK) names.push("ACK");
  if (flags & FIN) names.push("FIN");
  if (flags & SACK) names.push("SACK");
  return names.join("|") || "-";
}

// ---------------------------------------------------------------------------
// Sequence-number arithmetic. Sequence numbers are uint32 and wrap around, so
// "a < b" means "a is behind b by less than 2^31" (RFC 1982 serial numbers).
// ---------------------------------------------------------------------------

export const seqAdd = (a: number, n: number): number => (a + n) >>> 0;
/** Signed distance a - b, correct across wraparound. */
export const seqDiff = (a: number, b: number): number => (a - b) | 0;
export const seqLt = (a: number, b: number): boolean => seqDiff(a, b) < 0;
export const seqLte = (a: number, b: number): boolean => seqDiff(a, b) <= 0;
export const seqGt = (a: number, b: number): boolean => seqDiff(a, b) > 0;
export const seqGte = (a: number, b: number): boolean => seqDiff(a, b) >= 0;
