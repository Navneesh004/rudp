import { describe, expect, it } from "vitest";
import { IllegalTransitionError, StateMachine, type State } from "../src/state.js";

function walk(path: State[]): StateMachine {
  const sm = new StateMachine();
  for (const s of path) sm.transition(s);
  return sm;
}

describe("state machine", () => {
  it("allows the client path", () => {
    const sm = walk(["SYN_SENT", "ESTABLISHED", "FIN_WAIT", "TIME_WAIT", "CLOSED"]);
    expect(sm.history).toEqual(["CLOSED", "SYN_SENT", "ESTABLISHED", "FIN_WAIT", "TIME_WAIT", "CLOSED"]);
  });

  it("allows the server path", () => {
    const sm = walk(["LISTEN", "SYN_RECEIVED", "ESTABLISHED", "CLOSE_WAIT", "LAST_ACK", "CLOSED"]);
    expect(sm.state).toBe("CLOSED");
  });

  it("allows aborting from any open state", () => {
    expect(walk(["SYN_SENT", "CLOSED"]).state).toBe("CLOSED");
    expect(walk(["LISTEN", "SYN_RECEIVED", "CLOSED"]).state).toBe("CLOSED");
  });

  it.each<[State[], State]>([
    [[], "ESTABLISHED"],
    [[], "FIN_WAIT"],
    [["SYN_SENT"], "SYN_RECEIVED"],
    [["LISTEN"], "ESTABLISHED"],
    [["SYN_SENT", "ESTABLISHED"], "LAST_ACK"],
    [["SYN_SENT", "ESTABLISHED", "FIN_WAIT"], "ESTABLISHED"],
  ])("rejects illegal transition after %j to %s", (path, to) => {
    const sm = walk(path);
    expect(() => sm.transition(to)).toThrow(IllegalTransitionError);
    expect(sm.state).toBe(path.at(-1) ?? "CLOSED"); // unchanged
  });

  it("reports transitions to the listener", () => {
    const seen: string[] = [];
    const sm = new StateMachine((from, to) => seen.push(`${from}->${to}`));
    sm.transition("LISTEN");
    expect(seen).toEqual(["CLOSED->LISTEN"]);
    expect(sm.is("LISTEN", "CLOSED")).toBe(true);
  });
});
