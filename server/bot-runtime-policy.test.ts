import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CUMULATIVE_TOKEN_LIMIT,
  defaultBotRuntimePolicy,
  effectiveBotRuntimePolicy,
  mergeRuntimePolicy,
  effectiveTaskRuntimePolicy,
  runtimePolicyFingerprint,
  runtimePolicyOverrideFingerprint,
  runtimePolicyTiming,
  validateRuntimePolicyPatch,
} from "./bot-runtime-policy.ts";

describe("bot runtime policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps absent policy compatible with the legacy defaults", () => {
    expect(defaultBotRuntimePolicy()).toEqual({
      wallClockTimeoutMinutes: 0,
      idleTimeoutMinutes: 20,
      cancellationGraceSeconds: 5,
      retryCap: 1,
      maxToolAgentSteps: 0,
      delegationConcurrency: 4,
      freshSessionEnforcement: false,
      handoffByteCap: 12_000,
      cumulativeTokenPolicy: { mode: "disabled", limit: DEFAULT_CUMULATIVE_TOKEN_LIMIT },
    });
    expect(effectiveBotRuntimePolicy()).toEqual(defaultBotRuntimePolicy());
  });

  it("validates a partial nested update and merges it in schema order", () => {
    const patch = validateRuntimePolicyPatch({
      cumulativeTokenPolicy: { limit: 2_000 },
      retryCap: 0,
      delegationConcurrency: 2,
      handoffByteCap: 4_096,
      maxToolAgentSteps: 12,
    });
    expect(mergeRuntimePolicy({
      wallClockTimeoutMinutes: 7,
      cumulativeTokenPolicy: { mode: "soft", limit: 1_500 },
    }, patch)).toEqual({
      wallClockTimeoutMinutes: 7,
      retryCap: 0,
      delegationConcurrency: 2,
      handoffByteCap: 4_096,
      maxToolAgentSteps: 12,
      cumulativeTokenPolicy: { mode: "soft", limit: 2_000 },
    });
    expect(effectiveBotRuntimePolicy({
      wallClockTimeoutMinutes: 7,
      retryCap: 0,
      delegationConcurrency: 2,
      handoffByteCap: 4_096,
      cumulativeTokenPolicy: { mode: "soft", limit: 2_000 },
    })).toMatchObject({
      wallClockTimeoutMinutes: 7,
      idleTimeoutMinutes: 20,
      cumulativeTokenPolicy: { mode: "soft", limit: 2_000 },
    });
  });

  it("rejects unknown keys, wrong types, and every out-of-range value", () => {
    expect(() => validateRuntimePolicyPatch({ unknown: 1 })).toThrow(/unknown key/);
    expect(() => validateRuntimePolicyPatch({ idleTimeoutMinutes: 0 })).toThrow(/idleTimeoutMinutes/);
    expect(() => validateRuntimePolicyPatch({ wallClockTimeoutMinutes: 1.5 })).toThrow(/wallClockTimeoutMinutes/);
    expect(() => validateRuntimePolicyPatch({ cancellationGraceSeconds: 121 })).toThrow(/cancellationGraceSeconds/);
    expect(() => validateRuntimePolicyPatch({ retryCap: 2 })).toThrow(/retryCap/);
    expect(() => validateRuntimePolicyPatch({ delegationConcurrency: 0 })).toThrow(/delegationConcurrency/);
    expect(() => validateRuntimePolicyPatch({ delegationConcurrency: 5 })).toThrow(/delegationConcurrency/);
    expect(() => validateRuntimePolicyPatch({ handoffByteCap: 1_023 })).toThrow(/handoffByteCap/);
    expect(() => validateRuntimePolicyPatch({ handoffByteCap: 12_001 })).toThrow(/handoffByteCap/);
    expect(() => validateRuntimePolicyPatch({ maxToolAgentSteps: -1 })).toThrow(/maxToolAgentSteps/);
    expect(() => validateRuntimePolicyPatch({ freshSessionEnforcement: "yes" })).toThrow(/freshSessionEnforcement/);
    expect(() => validateRuntimePolicyPatch({ cumulativeTokenPolicy: { mode: "loud" } })).toThrow(/mode/);
    expect(() => validateRuntimePolicyPatch({ cumulativeTokenPolicy: { limit: 999 } })).toThrow(/limit/);
    expect(() => validateRuntimePolicyPatch({ cumulativeTokenPolicy: { extra: true } })).toThrow(/unknown key/);
  });

  it("resets to defaults without persisting an effective copy", () => {
    expect(mergeRuntimePolicy({ idleTimeoutMinutes: 9, freshSessionEnforcement: true }, null)).toBeUndefined();
    expect(validateRuntimePolicyPatch(undefined)).toBeUndefined();
    expect(validateRuntimePolicyPatch(null)).toBeNull();
  });

  it("preserves exact legacy milliseconds and snapshots explicit conversions", () => {
    vi.stubEnv("OMB_TURN_STALL_MS", "90000");
    vi.stubEnv("OMB_TURN_STOP_GRACE_MS", "250");
    const legacy = runtimePolicyTiming();
    expect(legacy).toEqual({ idleMs: 90_000, graceMs: 250 });

    // Environment changes after admission cannot retime the captured turn.
    vi.stubEnv("OMB_TURN_STALL_MS", "180000");
    vi.stubEnv("OMB_TURN_STOP_GRACE_MS", "9000");
    expect(legacy).toEqual({ idleMs: 90_000, graceMs: 250 });
    expect(runtimePolicyTiming({ idleTimeoutMinutes: 2, cancellationGraceSeconds: 3 })).toEqual({
      idleMs: 120_000,
      graceMs: 3_000,
    });
  });

  it("merges a task override after bot defaults and creates stable evidence", () => {
    const botDefaults = { retryCap: 0, idleTimeoutMinutes: 30, maxToolAgentSteps: 10 };
    const override = { idleTimeoutMinutes: 5, cumulativeTokenPolicy: { mode: "soft" as const, limit: 2_000 } };
    const effective = effectiveTaskRuntimePolicy(botDefaults, override);
    expect(effective).toMatchObject({ retryCap: 0, idleTimeoutMinutes: 5, maxToolAgentSteps: 10 });
    expect(effective.cumulativeTokenPolicy).toEqual({ mode: "soft", limit: 2_000 });
    expect(runtimePolicyFingerprint(effective)).toBe(runtimePolicyFingerprint(structuredClone(effective)));
    expect(runtimePolicyOverrideFingerprint(override)).toBe(runtimePolicyOverrideFingerprint(structuredClone(override)));
    expect(runtimePolicyOverrideFingerprint(override)).not.toBe(runtimePolicyOverrideFingerprint({ ...override, idleTimeoutMinutes: 6 }));
  });
});
