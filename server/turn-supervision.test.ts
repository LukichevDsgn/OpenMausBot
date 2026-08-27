import { afterEach, describe, expect, it, vi } from "vitest";

import { runtimePolicyTiming } from "./bot-runtime-policy.ts";
import { TurnSupervision, type UnknownTurn } from "./turn-supervision.ts";

describe("TurnSupervision", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("accepts one matching terminal event and rejects duplicates and late events", async () => {
    const unknown: unknown[] = [];
    const supervision = new TurnSupervision({ graceMs: 50, onUnknown: (turn) => unknown.push(turn) });
    const interrupt = vi.fn();

    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "provider-turn-1")).toBe(true);
    await expect(supervision.requestStop("bot", "thread", "cancel", interrupt)).resolves.toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);

    expect(supervision.observeTerminal("bot", "thread", "provider-turn-1")).toMatchObject({
      accepted: true,
      intent: "cancel",
      turnId: "provider-turn-1",
    });
    expect(supervision.observeTerminal("bot", "thread", "provider-turn-1")).toMatchObject({ accepted: false });
    expect(supervision.isLate("bot", "thread", "provider-turn-1")).toBe(true);
    expect(unknown).toEqual([]);
  });

  it("settles a timeout as UNKNOWN exactly once when the provider gives no outcome", async () => {
    vi.useFakeTimers();
    const unknown: UnknownTurn[] = [];
    const supervision = new TurnSupervision({ graceMs: 100, onUnknown: (turn) => unknown.push(turn) });

    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "provider-turn-2")).toBe(true);
    await supervision.requestStop("bot", "thread", "timeout", () => undefined);
    vi.advanceTimersByTime(99);
    expect(unknown).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({
      botId: "bot",
      threadId: "thread",
      turnId: "provider-turn-2",
      intent: "timeout",
      reason: expect.stringContaining("did not confirm timeout cancellation"),
    });
    expect(supervision.observeTerminal("bot", "thread", "provider-turn-2")).toMatchObject({ accepted: false });
  });

  it("captures cancellation grace per admitted turn", async () => {
    vi.useFakeTimers();
    const unknown: UnknownTurn[] = [];
    const supervision = new TurnSupervision({ graceMs: 100, onUnknown: (turn) => unknown.push(turn) });

    expect(supervision.begin("bot", "thread", 10)).toBe(true);
    await supervision.requestStop("bot", "thread", "cancel", () => undefined);
    vi.advanceTimersByTime(9);
    expect(unknown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ intent: "cancel", reason: expect.stringContaining("explicit cancellation") });
  });

  it("lets a same-deadline provider terminal settle before the UNKNOWN fallback", async () => {
    vi.useFakeTimers();
    const unknown: UnknownTurn[] = [];
    const supervision = new TurnSupervision({ graceMs: 5_000, onUnknown: (turn) => unknown.push(turn) });
    let terminal: ReturnType<TurnSupervision["observeTerminal"]> | undefined;

    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "provider-turn-cancel")).toBe(true);
    await supervision.requestStop("bot", "thread", "cancel", () => {
      setTimeout(() => {
        terminal = supervision.observeTerminal("bot", "thread", "provider-turn-cancel");
      }, 5_000);
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(terminal).toMatchObject({ accepted: true, intent: "cancel" });
    expect(unknown).toEqual([]);
    expect(supervision.has("bot", "thread")).toBe(false);
  });

  it("applies the exact non-unit legacy grace fallback", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OMB_TURN_STOP_GRACE_MS", "250");
    const timing = runtimePolicyTiming();
    const unknown: UnknownTurn[] = [];
    const supervision = new TurnSupervision({ graceMs: 100, onUnknown: (turn) => unknown.push(turn) });

    expect(supervision.begin("bot", "thread", timing.graceMs)).toBe(true);
    await supervision.requestStop("bot", "thread", "cancel", () => undefined);
    vi.advanceTimersByTime(249);
    expect(unknown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(unknown).toHaveLength(1);
  });

  it("does not let an old provider turn bind or complete a new generation", () => {
    const unknown: unknown[] = [];
    const supervision = new TurnSupervision({ graceMs: 50, onUnknown: (turn) => unknown.push(turn) });

    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "old-turn")).toBe(true);
    expect(supervision.observeTerminal("bot", "thread", "old-turn")).toMatchObject({ accepted: true });

    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "old-turn")).toBe(false);
    expect(supervision.isCurrent("bot", "thread", "old-turn")).toBe(false);
    expect(supervision.observeTerminal("bot", "thread", "old-turn")).toMatchObject({ accepted: false });
    expect(supervision.bind("bot", "thread", "new-turn")).toBe(true);
    expect(supervision.observeTerminal("bot", "thread", "new-turn")).toMatchObject({ accepted: true });
    expect(unknown).toEqual([]);
  });

  it("keeps every retired id rejectable after more than sixteen sequential turns", () => {
    const supervision = new TurnSupervision({ graceMs: 50, onUnknown: () => {} });

    for (let i = 1; i <= 17; i += 1) {
      const turnId = `turn-${i}`;
      expect(supervision.begin("bot", "thread")).toBe(true);
      expect(supervision.bind("bot", "thread", turnId)).toBe(true);
      expect(supervision.observeTerminal("bot", "thread", turnId)).toMatchObject({ accepted: true, turnId });
    }

    // Generation 18 is the next task. An old turn.started must not bind it,
    // and its late terminal must not settle or rewrite the current task.
    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "turn-1")).toBe(false);
    expect(supervision.isCurrent("bot", "thread", "turn-1")).toBe(false);
    expect(supervision.observeTerminal("bot", "thread", "turn-1")).toMatchObject({ accepted: false });
    expect(supervision.bind("bot", "thread", "turn-18")).toBe(true);
    expect(supervision.observeTerminal("bot", "thread", "turn-18")).toMatchObject({ accepted: true });
  });

  it("releases retired ids only after the provider lifecycle boundary", () => {
    const supervision = new TurnSupervision({ graceMs: 50, onUnknown: () => {} });

    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "reused-turn")).toBe(true);
    expect(supervision.observeTerminal("bot", "thread", "reused-turn")).toMatchObject({ accepted: true });
    expect(supervision.isLate("bot", "thread", "reused-turn")).toBe(true);

    // The test boundary represents EventBus.detachAll() followed by
    // ProviderRegistry.disposeAll(); only then may a new provider fleet reuse
    // an id without allowing an event from the old fleet through.
    supervision.resetProviderLifecycle();
    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "reused-turn")).toBe(true);
    expect(supervision.observeTerminal("bot", "thread", "reused-turn")).toMatchObject({ accepted: true });
  });

  it("remembers a launch failure's provider id before a later generation", () => {
    const supervision = new TurnSupervision({ graceMs: 50, onUnknown: () => {} });

    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "failed-turn")).toBe(true);
    expect(supervision.finishWithoutProvider("bot", "thread")).toBe(true);
    expect(supervision.begin("bot", "thread")).toBe(true);
    expect(supervision.bind("bot", "thread", "failed-turn")).toBe(false);
    expect(supervision.observeTerminal("bot", "thread", "failed-turn")).toMatchObject({ accepted: false });
  });

  it("treats a rejected interrupt as unproven and still reaches the bounded fallback", async () => {
    vi.useFakeTimers();
    const unknown: UnknownTurn[] = [];
    const supervision = new TurnSupervision({ graceMs: 25, onUnknown: (turn) => unknown.push(turn) });

    supervision.begin("bot", "thread");
    const interrupt = vi.fn(() => Promise.reject(new Error("transport down")));
    await supervision.requestStop("bot", "thread", "cancel", interrupt);
    vi.advanceTimersByTime(25);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ intent: "cancel", eventId: "supervision:1:cancel" });
  });

  it("settles fake lifecycle and supervision together on restart", () => {
    let busy = true;
    const receipts: UnknownTurn[] = [];
    const supervision = new TurnSupervision({
      graceMs: 50,
      onUnknown: (turn) => {
        receipts.push(turn);
        busy = false;
      },
    });

    supervision.begin("bot", "thread");
    supervision.bind("bot", "thread", "restart-turn");
    expect(supervision.forceUnknown(
      "bot",
      "thread",
      "server restarted before a terminal provider event was observed",
      "restart",
    )).toBe(true);

    expect(supervision.has("bot", "thread")).toBe(false);
    expect(busy).toBe(false);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ intent: "restart", turnId: "restart-turn" });
    expect(supervision.observeTerminal("bot", "thread", "restart-turn")).toMatchObject({ accepted: false });
  });
});
