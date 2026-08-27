// Stall-watchdog contract: activity keeps a turn alive indefinitely, human
// approvals pause the clock, silence past the ceiling stalls exactly once.
import { afterEach, describe, expect, it, vi } from "vitest";

import { runtimePolicyTiming } from "./bot-runtime-policy.ts";
import { TurnWatchdog, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;

function rig() {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    checkMs: 60_000,
    onStall: (turn) => stalls.push(turn),
    now: () => now,
  });
  return { dog, stalls, tick: (ms: number) => (now += ms) };
}

describe("TurnWatchdog", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stalls a silent turn once, and only once", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1", botId: "bot1" })]);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(dog.watching("t1")).toBe(false);
  });

  it("any event on the thread resets the clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    for (let i = 0; i < 10; i++) {
      tick(STALL - 1);
      dog.touch("t1");
    }
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("never stalls a turn waiting on a human, however long they take", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    // the answer restarts the clock rather than inheriting the wait
    dog.setWaitingOnHuman("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("a settled turn is forgotten", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.settle("t1");
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("re-watching a thread replaces the previous turn", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.watch("t1", "bot2");
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(STALL);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ botId: "bot2" })]);
  });

  it("captures the per-turn idle limit at admission", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("short", "bot1", 2_000);
    tick(1_999);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "short", idleMs: 2_000 })]);
  });

  it("applies the exact non-unit legacy idle fallback", () => {
    vi.stubEnv("OMB_TURN_STALL_MS", "90000");
    const timing = runtimePolicyTiming();
    const { dog, stalls, tick } = rig();
    dog.watch("legacy", "bot1", timing.idleMs);
    tick(89_999);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "legacy", idleMs: 90_000 })]);
  });
});
