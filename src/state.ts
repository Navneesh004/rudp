/**
 * Connection state machine, modelled on TCP (RFC 9293 §3.3.2), trimmed to the
 * states this protocol needs.
 *
 *   client:  CLOSED → SYN_SENT → ESTABLISHED → FIN_WAIT → TIME_WAIT → CLOSED
 *   server:  CLOSED → LISTEN → SYN_RECEIVED → ESTABLISHED → CLOSE_WAIT → LAST_ACK → CLOSED
 *
 * Whichever side calls end() first takes the "active close" path (FIN_WAIT,
 * TIME_WAIT); the other side takes the "passive close" path (CLOSE_WAIT, LAST_ACK).
 * Any state may drop straight to CLOSED on abort or timeout.
 */
export type State =
  | "CLOSED"
  | "LISTEN"
  | "SYN_SENT"
  | "SYN_RECEIVED"
  | "ESTABLISHED"
  | "FIN_WAIT"
  | "CLOSE_WAIT"
  | "LAST_ACK"
  | "TIME_WAIT";

export const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  CLOSED: ["LISTEN", "SYN_SENT"],
  LISTEN: ["SYN_RECEIVED", "CLOSED"],
  SYN_SENT: ["ESTABLISHED", "CLOSED"],
  SYN_RECEIVED: ["ESTABLISHED", "CLOSED"],
  ESTABLISHED: ["FIN_WAIT", "CLOSE_WAIT", "CLOSED"],
  FIN_WAIT: ["TIME_WAIT", "CLOSED"],
  CLOSE_WAIT: ["LAST_ACK", "CLOSED"],
  LAST_ACK: ["CLOSED"],
  TIME_WAIT: ["CLOSED"],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: State,
    readonly to: State,
  ) {
    super(`illegal state transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class StateMachine {
  private current: State = "CLOSED";
  readonly history: State[] = ["CLOSED"];

  constructor(private readonly onChange?: (from: State, to: State) => void) {}

  get state(): State {
    return this.current;
  }

  is(...states: State[]): boolean {
    return states.includes(this.current);
  }

  canTransition(to: State): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  transition(to: State): void {
    const from = this.current;
    if (!this.canTransition(to)) throw new IllegalTransitionError(from, to);
    this.current = to;
    this.history.push(to);
    this.onChange?.(from, to);
  }
}
