/**
 * Time source for the protocol. Production code uses the real clock; tests use
 * SimClock (src/sim/clock.ts) so a whole lossy transfer runs deterministically
 * in virtual time, in milliseconds of CPU rather than minutes of waiting.
 */
export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds, monotonic. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
