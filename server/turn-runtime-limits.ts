import type { BotRuntimePolicy } from "./bot-runtime-policy.ts";

export type TurnRuntimeLimitKind = "wall-clock" | "tool-agent-steps" | "cumulative-tokens";

export interface TurnRuntimeLimitEvent {
  kind: TurnRuntimeLimitKind;
  reason: string;
  observed?: number;
  limit?: number;
}

export interface TurnRuntimeLimitOptions {
  wallClockTimeoutMinutes?: number;
  onHardStop: (event: TurnRuntimeLimitEvent) => void;
  onSoftTokenWarning: (event: TurnRuntimeLimitEvent) => void;
}

interface ActiveTurnLimits {
  threadId: string;
  policy: BotRuntimePolicy;
  wallTimer?: ReturnType<typeof setTimeout>;
  itemIds: Set<string>;
  maximumReportedTokens: number;
  softWarningIssued: boolean;
  hardStopIssued: boolean;
  successfulDelegations: number;
  options: TurnRuntimeLimitOptions;
}

function defensivePolicy(policy: BotRuntimePolicy): BotRuntimePolicy {
  return {
    ...policy,
    cumulativeTokenPolicy: { ...policy.cumulativeTokenPolicy },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

/**
 * Owns limits that are neither provider lifecycle nor activity state. One
 * entry is created at admission and removed only by terminal/UNKNOWN or
 * dispatch-failure cleanup. Every hard limit invokes one callback at most.
 */
export class TurnRuntimeLimits {
  private readonly turns = new Map<string, ActiveTurnLimits>();

  begin(threadId: string, policy: BotRuntimePolicy, options: TurnRuntimeLimitOptions): boolean {
    if (this.turns.has(threadId)) return false;
    const entry: ActiveTurnLimits = {
      threadId,
      policy: defensivePolicy(policy),
      itemIds: new Set<string>(),
      maximumReportedTokens: 0,
      softWarningIssued: false,
      hardStopIssued: false,
      successfulDelegations: 0,
      options,
    };
    this.turns.set(threadId, entry);
    const wallMinutes = options.wallClockTimeoutMinutes ?? policy.wallClockTimeoutMinutes;
    if (wallMinutes > 0) {
      const wallMs = positiveInteger(wallMinutes, 1) * 60_000;
      entry.wallTimer = setTimeout(() => {
        this.hardStop(entry, {
          kind: "wall-clock",
          observed: wallMinutes,
          limit: wallMinutes,
          reason: `wall-clock timeout of ${wallMinutes} minute${wallMinutes === 1 ? "" : "s"} reached`,
        });
      }, wallMs);
      entry.wallTimer.unref?.();
    }
    return true;
  }

  /** Count canonical item.started tool ids. Duplicate ids are one step. */
  recordToolStarted(threadId: string, itemId?: string): boolean {
    const entry = this.turns.get(threadId);
    const normalized = itemId?.trim();
    if (!entry || !normalized || entry.itemIds.has(normalized)) return false;
    entry.itemIds.add(normalized);
    const limit = entry.policy.maxToolAgentSteps;
    if (limit > 0 && entry.itemIds.size > limit) {
      this.hardStop(entry, {
        kind: "tool-agent-steps",
        observed: entry.itemIds.size,
        limit,
        reason: `tool/agent step limit ${limit} exceeded on attempted step ${entry.itemIds.size}`,
      });
    }
    return true;
  }

  /** Providers report cumulative current-turn samples; never sum frames. */
  recordTokenSample(threadId: string, input: number, output: number): number | null {
    const entry = this.turns.get(threadId);
    if (!entry) return null;
    const cleanInput = Number.isFinite(input) ? Math.max(0, Math.trunc(input)) : 0;
    const cleanOutput = Number.isFinite(output) ? Math.max(0, Math.trunc(output)) : 0;
    const sample = cleanInput + cleanOutput;
    entry.maximumReportedTokens = Math.max(entry.maximumReportedTokens, sample);
    if (entry.hardStopIssued) return entry.maximumReportedTokens;
    const tokenPolicy = entry.policy.cumulativeTokenPolicy;
    if (tokenPolicy.mode === "disabled" || sample <= tokenPolicy.limit) return entry.maximumReportedTokens;
    const event: TurnRuntimeLimitEvent = {
      kind: "cumulative-tokens",
      observed: sample,
      limit: tokenPolicy.limit,
      reason: `cumulative current-turn token sample ${sample} exceeded limit ${tokenPolicy.limit}`,
    };
    if (tokenPolicy.mode === "soft") {
      if (!entry.softWarningIssued) {
        entry.softWarningIssued = true;
        entry.options.onSoftTokenWarning(event);
      }
    } else {
      this.hardStop(entry, event);
    }
    return entry.maximumReportedTokens;
  }

  /** A user/provider stop already owns the race; suppress later limit callbacks. */
  markStopRequested(threadId: string): void {
    const entry = this.turns.get(threadId);
    if (entry) entry.hardStopIssued = true;
  }

  settle(threadId: string): boolean {
    const entry = this.turns.get(threadId);
    if (!entry) return false;
    if (entry.wallTimer) clearTimeout(entry.wallTimer);
    entry.wallTimer = undefined;
    this.turns.delete(threadId);
    return true;
  }

  active(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  /** Return only a defensive copy of the immutable policy captured at admission. */
  policySnapshot(threadId: string): BotRuntimePolicy | null {
    const entry = this.turns.get(threadId);
    return entry ? defensivePolicy(entry.policy) : null;
  }

  /** Reserve one successful outgoing delegation for the admitted source turn. */
  reserveDelegation(threadId: string): boolean {
    const entry = this.turns.get(threadId);
    if (!entry || entry.successfulDelegations >= entry.policy.delegationConcurrency) return false;
    entry.successfulDelegations += 1;
    return true;
  }

  /** Roll back a reservation when a later queue guard rejects the handoff. */
  releaseDelegation(threadId: string): boolean {
    const entry = this.turns.get(threadId);
    if (!entry || entry.successfulDelegations <= 0) return false;
    entry.successfulDelegations -= 1;
    return true;
  }

  snapshot(threadId: string): { steps: number; maximumReportedTokens: number } | null {
    const entry = this.turns.get(threadId);
    return entry
      ? { steps: entry.itemIds.size, maximumReportedTokens: entry.maximumReportedTokens }
      : null;
  }

  private hardStop(entry: ActiveTurnLimits, event: TurnRuntimeLimitEvent): void {
    if (this.turns.get(entry.threadId) !== entry || entry.hardStopIssued) return;
    entry.hardStopIssued = true;
    entry.options.onHardStop(event);
  }
}
