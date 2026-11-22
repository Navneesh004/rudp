/** Small helpers shared by the command-line programs. */
import { MODE_NAMES, type Mode } from "../window.js";

export const MB = 1e6;

export function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

export function parsePort(s: string | undefined): number {
  const port = Number(s);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port: ${s}`, 2);
  return port;
}

export function parseIntOption(name: string, s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number`, 2);
  return n;
}

export function parseMode(s: string | undefined): Mode {
  const mode = (s ?? "sr") as Mode;
  if (!(mode in MODE_NAMES)) fail(`--mode must be one of: ${Object.keys(MODE_NAMES).join(", ")}`, 2);
  return mode;
}

export const formatBytes = (n: number): string =>
  n >= MB ? `${(n / MB).toFixed(2)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`;

/** Print an aligned "label  value" table. */
export function printTable(title: string, rows: [string, string][]): void {
  const width = Math.max(...rows.map(([k]) => k.length));
  process.stdout.write(`${title}\n`);
  for (const [k, v] of rows) process.stdout.write(`  ${k.padEnd(width)}  ${v}\n`);
}
