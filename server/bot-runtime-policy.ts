/**
 * Persisted per-bot runtime controls. The stored shape is deliberately an
 * override object: absent fields keep the legacy server defaults, while the
 * wire shape is always the complete effective policy.
 */

import { createHash } from "node:crypto";

export type CumulativeTokenPolicyMode = "disabled" | "soft" | "hard";

export interface CumulativeTokenPolicy {
  mode: CumulativeTokenPolicyMode;
  limit: number;
}

export interface BotRuntimePolicy {
  wallClockTimeoutMinutes: number;
  idleTimeoutMinutes: number;
  cancellationGraceSeconds: number;
  retryCap: number;
  maxToolAgentSteps: number;
  delegationConcurrency: number;
  freshSessionEnforcement: boolean;
  handoffByteCap: number;
  cumulativeTokenPolicy: CumulativeTokenPolicy;
}

/** Only explicitly supplied values are persisted in bots.json. */
export interface RuntimePolicyOverrides {
  wallClockTimeoutMinutes?: number;
  idleTimeoutMinutes?: number;
  cancellationGraceSeconds?: number;
  retryCap?: number;
  maxToolAgentSteps?: number;
  delegationConcurrency?: number;
  freshSessionEnforcement?: boolean;
  handoffByteCap?: number;
  cumulativeTokenPolicy?: {
    mode?: CumulativeTokenPolicyMode;
    limit?: number;
  };
}

export type RuntimePolicyPatch = RuntimePolicyOverrides | null;

export const DEFAULT_CUMULATIVE_TOKEN_LIMIT = 1_000_000;

function legacyNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return value || fallback;
}

/** The pre-policy idle watchdog ceiling, kept as the compatibility fallback. */
export function legacyIdleTimeoutMs(): number {
  return Math.max(60_000, legacyNumber("OMB_TURN_STALL_MS", 20 * 60_000));
}

/** The pre-policy supervision grace, kept as the compatibility fallback. */
export function legacyCancellationGraceMs(): number {
  return Math.max(250, legacyNumber("OMB_TURN_STOP_GRACE_MS", 5_000));
}

function boundedCeil(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.ceil(value)));
}

export function defaultBotRuntimePolicy(): BotRuntimePolicy {
  return {
    wallClockTimeoutMinutes: 0,
    idleTimeoutMinutes: boundedCeil(legacyIdleTimeoutMs() / 60_000, 1_440),
    cancellationGraceSeconds: boundedCeil(legacyCancellationGraceMs() / 1_000, 120),
    retryCap: 1,
    maxToolAgentSteps: 0,
    delegationConcurrency: 4,
    freshSessionEnforcement: false,
    handoffByteCap: 12_000,
    cumulativeTokenPolicy: {
      mode: "disabled",
      limit: DEFAULT_CUMULATIVE_TOKEN_LIMIT,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function integerInRange(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function zeroOrRange(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${field} must be 0 or an integer between 1 and ${max}`);
  }
  return value as number;
}

function validateOverrides(value: unknown): RuntimePolicyOverrides {
  if (!isRecord(value)) throw new Error("runtimePolicy must be an object or null");
  const allowed = new Set([
    "wallClockTimeoutMinutes",
    "idleTimeoutMinutes",
    "cancellationGraceSeconds",
    "retryCap",
    "maxToolAgentSteps",
    "delegationConcurrency",
    "freshSessionEnforcement",
    "handoffByteCap",
    "cumulativeTokenPolicy",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`runtimePolicy contains unknown key "${unknown}"`);

  const patch: RuntimePolicyOverrides = {};
  if (has(value, "wallClockTimeoutMinutes")) {
    patch.wallClockTimeoutMinutes = zeroOrRange(value.wallClockTimeoutMinutes, "wallClockTimeoutMinutes", 1_440);
  }
  if (has(value, "idleTimeoutMinutes")) {
    patch.idleTimeoutMinutes = integerInRange(value.idleTimeoutMinutes, "idleTimeoutMinutes", 1, 1_440);
  }
  if (has(value, "cancellationGraceSeconds")) {
    patch.cancellationGraceSeconds = integerInRange(value.cancellationGraceSeconds, "cancellationGraceSeconds", 1, 120);
  }
  if (has(value, "retryCap")) {
    patch.retryCap = zeroOrRange(value.retryCap, "retryCap", 1);
  }
  if (has(value, "maxToolAgentSteps")) {
    patch.maxToolAgentSteps = zeroOrRange(value.maxToolAgentSteps, "maxToolAgentSteps", 1_000);
  }
  if (has(value, "delegationConcurrency")) {
    patch.delegationConcurrency = integerInRange(value.delegationConcurrency, "delegationConcurrency", 1, 4);
  }
  if (has(value, "freshSessionEnforcement")) {
    if (typeof value.freshSessionEnforcement !== "boolean") {
      throw new Error("freshSessionEnforcement must be a boolean");
    }
    patch.freshSessionEnforcement = value.freshSessionEnforcement;
  }
  if (has(value, "handoffByteCap")) {
    patch.handoffByteCap = integerInRange(value.handoffByteCap, "handoffByteCap", 1_024, 12_000);
  }
  if (has(value, "cumulativeTokenPolicy")) {
    const token = value.cumulativeTokenPolicy;
    if (!isRecord(token)) throw new Error("cumulativeTokenPolicy must be an object");
    const tokenAllowed = new Set(["mode", "limit"]);
    const tokenUnknown = Object.keys(token).find((key) => !tokenAllowed.has(key));
    if (tokenUnknown) throw new Error(`cumulativeTokenPolicy contains unknown key "${tokenUnknown}"`);
    const tokenPatch: NonNullable<RuntimePolicyOverrides["cumulativeTokenPolicy"]> = {};
    if (has(token, "mode")) {
      if (token.mode !== "disabled" && token.mode !== "soft" && token.mode !== "hard") {
        throw new Error("cumulativeTokenPolicy.mode must be disabled, soft, or hard");
      }
      tokenPatch.mode = token.mode;
    }
    if (has(token, "limit")) {
      tokenPatch.limit = integerInRange(token.limit, "cumulativeTokenPolicy.limit", 1_000, 10_000_000);
    }
    patch.cumulativeTokenPolicy = tokenPatch;
  }
  return patch;
}

/** Validate a PATCH value. undefined means the API did not send the field. */
export function validateRuntimePolicyPatch(value: unknown): RuntimePolicyPatch | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return validateOverrides(value);
}

function validOverrideNumber(value: unknown, min: number, max: number, allowZero: boolean): value is number {
  return Number.isInteger(value) && (allowZero ? (value as number) === 0 || (value as number) >= min : (value as number) >= min) && (value as number) <= max;
}

function copyOverrides(value: RuntimePolicyOverrides | undefined): RuntimePolicyOverrides {
  const out: RuntimePolicyOverrides = {};
  if (value && validOverrideNumber(value.wallClockTimeoutMinutes, 1, 1_440, true)) {
    out.wallClockTimeoutMinutes = value.wallClockTimeoutMinutes;
  }
  if (value && validOverrideNumber(value.idleTimeoutMinutes, 1, 1_440, false)) {
    out.idleTimeoutMinutes = value.idleTimeoutMinutes;
  }
  if (value && validOverrideNumber(value.cancellationGraceSeconds, 1, 120, false)) {
    out.cancellationGraceSeconds = value.cancellationGraceSeconds;
  }
  if (value && validOverrideNumber(value.retryCap, 1, 1, true)) {
    out.retryCap = value.retryCap;
  }
  if (value && validOverrideNumber(value.maxToolAgentSteps, 1, 1_000, true)) {
    out.maxToolAgentSteps = value.maxToolAgentSteps;
  }
  if (value && validOverrideNumber(value.delegationConcurrency, 1, 4, false)) {
    out.delegationConcurrency = value.delegationConcurrency;
  }
  if (value && typeof value.freshSessionEnforcement === "boolean") {
    out.freshSessionEnforcement = value.freshSessionEnforcement;
  }
  if (value && validOverrideNumber(value.handoffByteCap, 1_024, 12_000, false)) {
    out.handoffByteCap = value.handoffByteCap;
  }
  if (value?.cumulativeTokenPolicy) {
    const token: NonNullable<RuntimePolicyOverrides["cumulativeTokenPolicy"]> = {};
    if (value.cumulativeTokenPolicy.mode === "disabled" || value.cumulativeTokenPolicy.mode === "soft" || value.cumulativeTokenPolicy.mode === "hard") {
      token.mode = value.cumulativeTokenPolicy.mode;
    }
    if (validOverrideNumber(value.cumulativeTokenPolicy.limit, 1_000, 10_000_000, false)) {
      token.limit = value.cumulativeTokenPolicy.limit;
    }
    if (token.mode !== undefined || token.limit !== undefined) out.cumulativeTokenPolicy = token;
  }
  return out;
}

/**
 * Admission-only timing snapshot. The wire policy is intentionally expressed
 * in integer UI units, but absent overrides must retain the legacy server's
 * exact millisecond behavior. This value is never persisted or exposed.
 */
export interface RuntimePolicyTiming {
  idleMs: number;
  graceMs: number;
}

export function runtimePolicyTiming(overrides?: RuntimePolicyOverrides): RuntimePolicyTiming {
  const explicit = copyOverrides(overrides);
  return {
    idleMs: explicit.idleTimeoutMinutes !== undefined
      ? explicit.idleTimeoutMinutes * 60_000
      : legacyIdleTimeoutMs(),
    graceMs: explicit.cancellationGraceSeconds !== undefined
      ? explicit.cancellationGraceSeconds * 1_000
      : legacyCancellationGraceMs(),
  };
}

/** Deterministically merge a validated partial patch into explicit storage. */
export function mergeRuntimePolicy(
  previous: RuntimePolicyOverrides | undefined,
  patch: RuntimePolicyPatch | undefined,
): RuntimePolicyOverrides | undefined {
  if (patch === undefined) return copyOverrides(previous);
  if (patch === null) return undefined;
  const prior = copyOverrides(previous);
  const next: RuntimePolicyOverrides = {};
  if (prior.wallClockTimeoutMinutes !== undefined || patch.wallClockTimeoutMinutes !== undefined) {
    next.wallClockTimeoutMinutes = patch.wallClockTimeoutMinutes ?? prior.wallClockTimeoutMinutes;
  }
  if (prior.idleTimeoutMinutes !== undefined || patch.idleTimeoutMinutes !== undefined) {
    next.idleTimeoutMinutes = patch.idleTimeoutMinutes ?? prior.idleTimeoutMinutes;
  }
  if (prior.cancellationGraceSeconds !== undefined || patch.cancellationGraceSeconds !== undefined) {
    next.cancellationGraceSeconds = patch.cancellationGraceSeconds ?? prior.cancellationGraceSeconds;
  }
  if (prior.retryCap !== undefined || patch.retryCap !== undefined) {
    next.retryCap = patch.retryCap ?? prior.retryCap;
  }
  if (prior.maxToolAgentSteps !== undefined || patch.maxToolAgentSteps !== undefined) {
    next.maxToolAgentSteps = patch.maxToolAgentSteps ?? prior.maxToolAgentSteps;
  }
  if (prior.delegationConcurrency !== undefined || patch.delegationConcurrency !== undefined) {
    next.delegationConcurrency = patch.delegationConcurrency ?? prior.delegationConcurrency;
  }
  if (prior.freshSessionEnforcement !== undefined || patch.freshSessionEnforcement !== undefined) {
    next.freshSessionEnforcement = patch.freshSessionEnforcement ?? prior.freshSessionEnforcement;
  }
  if (prior.handoffByteCap !== undefined || patch.handoffByteCap !== undefined) {
    next.handoffByteCap = patch.handoffByteCap ?? prior.handoffByteCap;
  }
  if (prior.cumulativeTokenPolicy || patch.cumulativeTokenPolicy) {
    const priorToken = prior.cumulativeTokenPolicy;
    const patchToken = patch.cumulativeTokenPolicy;
    const token: NonNullable<RuntimePolicyOverrides["cumulativeTokenPolicy"]> = {};
    if (priorToken?.mode !== undefined || patchToken?.mode !== undefined) token.mode = patchToken?.mode ?? priorToken?.mode;
    if (priorToken?.limit !== undefined || patchToken?.limit !== undefined) token.limit = patchToken?.limit ?? priorToken?.limit;
    next.cumulativeTokenPolicy = token;
  }
  return Object.keys(next).length ? next : undefined;
}

export function effectiveBotRuntimePolicy(overrides?: RuntimePolicyOverrides): BotRuntimePolicy {
  const defaults = defaultBotRuntimePolicy();
  const explicit = copyOverrides(overrides);
  return {
    wallClockTimeoutMinutes: explicit.wallClockTimeoutMinutes ?? defaults.wallClockTimeoutMinutes,
    idleTimeoutMinutes: explicit.idleTimeoutMinutes ?? defaults.idleTimeoutMinutes,
    cancellationGraceSeconds: explicit.cancellationGraceSeconds ?? defaults.cancellationGraceSeconds,
    retryCap: explicit.retryCap ?? defaults.retryCap,
    maxToolAgentSteps: explicit.maxToolAgentSteps ?? defaults.maxToolAgentSteps,
    delegationConcurrency: explicit.delegationConcurrency ?? defaults.delegationConcurrency,
    freshSessionEnforcement: explicit.freshSessionEnforcement ?? defaults.freshSessionEnforcement,
    handoffByteCap: explicit.handoffByteCap ?? defaults.handoffByteCap,
    cumulativeTokenPolicy: {
      mode: explicit.cumulativeTokenPolicy?.mode ?? defaults.cumulativeTokenPolicy.mode,
      limit: explicit.cumulativeTokenPolicy?.limit ?? defaults.cumulativeTokenPolicy.limit,
    },
  };
}

export interface RuntimePolicyAuditEntry {
  id: string;
  at: number;
  targetBotId: string;
  actorBotId: string;
  actorThreadId: string;
  change: "persistent-patch" | "task-override" | "lock-change";
  outcome: "applied" | "refused";
  reason: string;
  provenance: "chief-of-staff-tool" | "delegate-bot" | "human-settings";
  beforeFingerprint?: string;
  afterFingerprint?: string;
  overrideFingerprint?: string;
}

/** Effective policy for one task. Task overrides are applied after the bot's
 * persisted defaults and never write back to that bot record. */
export function effectiveTaskRuntimePolicy(
  botOverrides: RuntimePolicyOverrides | undefined,
  taskOverride: RuntimePolicyOverrides | undefined,
): BotRuntimePolicy {
  return effectiveBotRuntimePolicy(mergeRuntimePolicy(botOverrides, taskOverride));
}

/** Stable, secret-free evidence for an immutable admission snapshot. */
export function runtimePolicyFingerprint(policy: BotRuntimePolicy): string {
  const vector = [
    policy.wallClockTimeoutMinutes,
    policy.idleTimeoutMinutes,
    policy.cancellationGraceSeconds,
    policy.retryCap,
    policy.maxToolAgentSteps,
    policy.delegationConcurrency,
    policy.freshSessionEnforcement,
    policy.handoffByteCap,
    policy.cumulativeTokenPolicy.mode,
    policy.cumulativeTokenPolicy.limit,
  ];
  return createHash("sha256").update(JSON.stringify(vector), "utf8").digest("hex");
}

/** Stable evidence for the explicit task override, without retaining raw
 * tool arguments in anti-loop identity or audit metadata. */
export function runtimePolicyOverrideFingerprint(overrides?: RuntimePolicyOverrides): string | undefined {
  if (!overrides) return undefined;
  const vector = [
    overrides.wallClockTimeoutMinutes,
    overrides.idleTimeoutMinutes,
    overrides.cancellationGraceSeconds,
    overrides.retryCap,
    overrides.maxToolAgentSteps,
    overrides.delegationConcurrency,
    overrides.freshSessionEnforcement,
    overrides.handoffByteCap,
    overrides.cumulativeTokenPolicy?.mode,
    overrides.cumulativeTokenPolicy?.limit,
  ];
  return createHash("sha256").update(JSON.stringify(vector), "utf8").digest("hex");
}
