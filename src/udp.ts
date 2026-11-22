/**
 * Real-network glue: a Link backed by a Node dgram (UDP) socket, plus
 * connect()/listen() helpers that resolve once the handshake completes.
 */
import dgram from "node:dgram";
import { lookup } from "node:dns/promises";
import type { AddressInfo } from "node:net";
import { Connection, type ConnectionOptions } from "./connection.js";
import type { Link } from "./link.js";

export interface Remote {
  address: string;
  port: number;
}

/**
 * A UDP socket talking to exactly one peer. A server-side link starts with no
 * peer and locks on to the first address that sends it a datagram, which is
 * why this implementation supports one connection per port.
 */
export class UdpLink implements Link {
  private handler: ((d: Buffer) => void) | undefined;

  constructor(
    readonly socket: dgram.Socket,
    private remote?: Remote,
  ) {
    socket.on("message", (msg, rinfo) => {
      if (!this.remote) this.remote = { address: rinfo.address, port: rinfo.port };
      else if (rinfo.address !== this.remote.address || rinfo.port !== this.remote.port) return;
      this.handler?.(msg);
    });
    // ICMP "port unreachable" surfaces as ECONNREFUSED/ECONNRESET on some
    // platforms; to an unreliable transport that is just another lost packet.
    socket.on("error", () => {});
  }

  get peer(): Remote | undefined {
    return this.remote;
  }

  onReceive(handler: (d: Buffer) => void): void {
    this.handler = handler;
  }

  send(datagram: Buffer): void {
    if (!this.remote) return;
    this.socket.send(datagram, this.remote.port, this.remote.address, () => {});
  }
}

export type UdpOptions = Omit<ConnectionOptions, "link" | "clock">;

const SOCKET_BUFFER = 8 << 20;

function tuneBuffers(socket: dgram.Socket): void {
  try {
    socket.setRecvBufferSize(SOCKET_BUFFER);
    socket.setSendBufferSize(SOCKET_BUFFER);
  } catch {
    // The OS may cap buffer sizes; the defaults still work, just with more drops.
  }
}

function bind(socket: dgram.Socket, port: number, address?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, address, () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

/** Open a connection to host:port. Resolves after the three-way handshake. */
export async function connect(host: string, port: number, opts: UdpOptions = {}): Promise<Connection> {
  const { address, family } = await lookup(host);
  const socket = dgram.createSocket(family === 6 ? "udp6" : "udp4");
  await bind(socket, 0);
  tuneBuffers(socket);
  const conn = new Connection({ ...opts, link: new UdpLink(socket, { address, port }) });
  conn.once("close", () => socket.close());
  return new Promise((resolve, reject) => {
    const onClose = (err?: Error) => reject(err ?? new Error("connection closed during handshake"));
    conn.once("close", onClose);
    conn.once("connect", () => {
      conn.off("close", onClose);
      resolve(conn);
    });
    conn.connect();
  });
}

export interface Listener {
  connection: Connection;
  address: AddressInfo;
}

/**
 * Listen for one incoming connection on `port` (0 picks a free port). The
 * returned connection is in LISTEN state; wait for its "connect" event.
 */
export async function listen(port: number, opts: UdpOptions & { host?: string } = {}): Promise<Listener> {
  const { host, ...connOpts } = opts;
  const socket = dgram.createSocket(host?.includes(":") ? "udp6" : "udp4");
  await bind(socket, port, host);
  tuneBuffers(socket);
  const connection = new Connection({ ...connOpts, link: new UdpLink(socket) });
  connection.once("close", () => socket.close());
  connection.listen();
  return { connection, address: socket.address() };
}
