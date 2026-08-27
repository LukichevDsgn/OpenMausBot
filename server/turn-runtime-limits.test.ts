import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotRuntimePolicy } from "./bot-runtime-policy.ts";
import { TurnRuntimeLimits, type TurnRuntimeLimitEvent } from "./turn-runtime-limits.ts";

const policy = (overrides: Partial<BotRuntimePolicy> = {}): BotRuntimePolicy => ({
  wallClockTimeoutMinutes: 0,
  idleTimeoutMinutes: 20,
  cancellationGraceSeconds: 5,
  retryCap: 1,
  maxToolAgentSteps: 0,
  delegationConcurrency: 4,
  freshSessionEnforcement: false,
  handoffByteCap: 12_000,
  cumulativeTokenPolicy: { mode: "disabled", limit: 1_000 },
  ...overrides,
});

describe("TurnRuntimeLimits", () => {
  afterEach(() => vi.useRealTimers());

  it("fires a wall limit once and clears the timer on settle", () => {
    vi.useFakeTimers();
    const hard: TurnRuntimeLimitEvent[] = [];
    const limits = new TurnRuntimeLimits();
    expect(limits.begin("thread", policy({ wallClockTimeoutMinutes: 1 }), {
      onHardStop: (event) => hard.push(event),
      onSoftTokenWarning: () => {},
    })).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(hard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(hard).toMatchObject([{ kind: "wall-clock", limit: 1 }]);
    vi.advanceTimersByTime(120_000);
    expect(hard).toHaveLength(1);
    expect(limits.settle("thread")).toBe(true);
    expect(limits.settle("thread")).toBe(false);
  });

  it("counts unique canonical tool ids and stops only on N+1", () => {
    const hard: TurnRuntimeLimitEvent[] = [];
    const limits = new TurnRuntimeLimits();
    limits.begin("thread", policy({ maxToolAgentSteps: 2 }), {
      onHardStop: (event) => hard.push(event),
      onSoftTokenWarning: () => {},
    });
    expect(limits.recordToolStarted("thread", "step-1")).toBe(true);
    expect(limits.recordToolStarted("thread", "step-1")).toBe(false);
    expect(limits.recordToolStarted("thread", "step-2")).toBe(true);
    expect(hard).toHaveLength(0);
    expect(limits.recordToolStarted("thread", "step-3")).toBe(true);
    expect(hard).toMatchObject([{ kind: "tool-agent-steps", observed: 3, limit: 2 }]);
    expect(limits.recordToolStarted("thread", "step-4")).toBe(true);
    expect(hard).toHaveLength(1);
    expect(limits.snapshot("thread")).toMatchObject({ steps: 4 });
  });

  it("keeps disabled tokens inert, warns once in soft mode, and stops once in hard mode", () => {
    const disabledHard: TurnRuntimeLimitEvent[] = [];
    const disabled = new TurnRuntimeLimits();
    disabled.begin("disabled", policy(), {
      onHardStop: (event) => disabledHard.push(event),
      onSoftTokenWarning: () => { throw new Error("disabled warning"); },
    });
    disabled.recordTokenSample("disabled", 900, 900);
    expect(disabledHard).toEqual([]);

    const disabledSteps: TurnRuntimeLimitEvent[] = [];
    const noSteps = new TurnRuntimeLimits();
    noSteps.begin("no-steps", policy(), {
      onHardStop: (event) => disabledSteps.push(event),
      onSoftTokenWarning: () => {},
    });
    noSteps.recordToolStarted("no-steps", "step-1");
    noSteps.recordToolStarted("no-steps", "step-2");
    expect(disabledSteps).toEqual([]);

    const soft: TurnRuntimeLimitEvent[] = [];
    const softLimits = new TurnRuntimeLimits();
    softLimits.begin("soft", policy({ cumulativeTokenPolicy: { mode: "soft", limit: 1_000 } }), {
      onHardStop: (event) => soft.push(event),
      onSoftTokenWarning: (event) => soft.push(event),
    });
    softLimits.recordTokenSample("soft", 700, 400);
    softLimits.recordTokenSample("soft", 600, 500);
    softLimits.recordTokenSample("soft", 900, 900);
    expect(soft).toHaveLength(1);
    expect(soft[0]).toMatchObject({ kind: "cumulative-tokens", observed: 1_100, limit: 1_000 });

    const hard: TurnRuntimeLimitEvent[] = [];
    const hardLimits = new TurnRuntimeLimits();
    hardLimits.begin("hard", policy({ cumulativeTokenPolicy: { mode: "hard", limit: 1_000 } }), {
      onHardStop: (event) => hard.push(event),
      onSoftTokenWarning: () => {},
    });
    hardLimits.recordTokenSample("hard", 700, 400);
    hardLimits.recordTokenSample("hard", 600, 500);
    hardLimits.recordTokenSample("hard", 900, 900);
    expect(hard).toHaveLength(1);
    expect(hard[0]).toMatchObject({ observed: 1_100 });
    expect(hardLimits.snapshot("hard")).toMatchObject({ maximumReportedTokens: 1_800 });
  });

  it("wins a stop race once and allows a fresh generation after cleanup", () => {
    const hard: TurnRuntimeLimitEvent[] = [];
    const limits = new TurnRuntimeLimits();
    limits.begin("thread", policy({ maxToolAgentSteps: 1 }), {
      onHardStop: (event) => hard.push(event),
      onSoftTokenWarning: () => {},
    });
    limits.recordToolStarted("thread", "step-1");
    limits.recordToolStarted("thread", "step-2");
    limits.markStopRequested("thread");
    limits.recordTokenSample("thread", 10_000, 10_000);
    expect(hard).toHaveLength(1);
    expect(limits.settle("thread")).toBe(true);
    expect(limits.begin("thread", policy(), { onHardStop: () => {}, onSoftTokenWarning: () => {} })).toBe(true);
  });

  it("does not emit a late soft warning after an explicit stop owns the race", () => {
    const warnings: TurnRuntimeLimitEvent[] = [];
    const limits = new TurnRuntimeLimits();
    limits.begin("thread", policy({ cumulativeTokenPolicy: { mode: "soft", limit: 1_000 } }), {
      onHardStop: () => {},
      onSoftTokenWarning: (event) => warnings.push(event),
    });
    limits.markStopRequested("thread");
    limits.recordTokenSample("thread", 900, 200);
    expect(warnings).toEqual([]);
  });

  it("keeps an immutable defensive policy snapshot and cleans its delegation budget", () => {
    const limits = new TurnRuntimeLimits();
    const admitted = policy({ retryCap: 0, delegationConcurrency: 2, handoffByteCap: 2_048 });
    expect(limits.begin("source", admitted, { onHardStop: () => {}, onSoftTokenWarning: () => {} })).toBe(true);

    admitted.retryCap = 1;
    admitted.cumulativeTokenPolicy.limit = 9_999;
    const first = limits.policySnapshot("source")!;
    expect(first).toMatchObject({ retryCap: 0, delegationConcurrency: 2, handoffByteCap: 2_048 });
    first.retryCap = 1;
    first.cumulativeTokenPolicy.limit = 77;
    expect(limits.policySnapshot("source")).toMatchObject({ retryCap: 0, cumulativeTokenPolicy: { limit: 1_000 } });

    expect(limits.reserveDelegation("source")).toBe(true);
    expect(limits.reserveDelegation("source")).toBe(true);
    expect(limits.reserveDelegation("source")).toBe(false);
    expect(limits.releaseDelegation("source")).toBe(true);
    expect(limits.reserveDelegation("source")).toBe(true);
    expect(limits.settle("source")).toBe(true);
    expect(limits.policySnapshot("source")).toBeNull();
    expect(limits.reserveDelegation("source")).toBe(false);
  });
});
