import type { Clock, TimerHandle } from "../clock.js";

interface SimEvent {
  time: number;
  id: number;
  fn: () => void;
  cancelled: boolean;
}

/**
 * Discrete-event clock. Timers are kept in a binary min-heap ordered by
 * (time, insertion order); run() pops them one at a time and jumps virtual
 * time forward, so a transfer that would take minutes over a real 30%-loss
 * link finishes in milliseconds, and the same seed always gives the same run.
 */
export class SimClock implements Clock {
  private t = 0;
  private nextId = 0;
  private readonly heap: SimEvent[] = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const ev: SimEvent = { time: this.t + Math.max(0, ms), id: this.nextId++, fn, cancelled: false };
    this.push(ev);
    return ev;
  }

  clearTimeout(handle: TimerHandle): void {
    if (handle) (handle as SimEvent).cancelled = true;
  }

  get pending(): number {
    return this.heap.filter((e) => !e.cancelled).length;
  }

  /**
   * Run events until `until()` returns true, no events remain, or a limit is hit.
   * Returns the number of events executed.
   */
  run(opts: { until?: () => boolean; maxTime?: number; maxEvents?: number } = {}): number {
    const maxTime = opts.maxTime ?? Number.POSITIVE_INFINITY;
    const maxEvents = opts.maxEvents ?? 10_000_000;
    let n = 0;
    while (this.heap.length > 0 && n < maxEvents) {
      if (opts.until?.()) break;
      const ev = this.pop()!;
      if (ev.cancelled) continue;
      if (ev.time > maxTime) {
        this.push(ev);
        break;
      }
      this.t = ev.time;
      ev.fn();
      n++;
    }
    return n;
  }

  private less(a: SimEvent, b: SimEvent): boolean {
    return a.time < b.time || (a.time === b.time && a.id < b.id);
  }

  private push(ev: SimEvent): void {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  private pop(): SimEvent | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}
