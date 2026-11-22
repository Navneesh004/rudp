/**
 * A Link is anything that can carry datagrams between two endpoints. The
 * protocol only needs "send these bytes" and "tell me when bytes arrive", which
 * keeps it independent of the real UDP socket (src/udp.ts) and lets tests swap
 * in a simulated lossy link (src/sim/link.ts).
 *
 * Like UDP, a Link may drop, duplicate, reorder or corrupt datagrams.
 */
export interface Link {
  send(datagram: Buffer): void;
  onReceive(handler: (datagram: Buffer) => void): void;
}
