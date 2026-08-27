// Async peer handoff (delegate_bot).
//
// A bot that finishes one task can hand the NEXT task to a peer without
// blocking its own turn — the source bot's turn.completed fires after it
// settles, and the queued delegation runs then. The peer gets a fresh
// depth-1 turn (depth cap still blocks A→B→C chains, see index.ts).
//
// Visiblity rides on the same comms-visibility helpers ask_bot uses
// (channel mirror + 1:1 chips) so a delegated exchange looks like an
// exchanged one. The optional approval gate (A2) is checked at drain
// time, never at queue time, because the user might have just turned
// approvePeerComms on between queueing and draining.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { parseHandoff, scopesConflict, type ParsedHandoff } from "./handoff.ts";
import {
  effectiveTaskRuntimePolicy,
  runtimePolicyFingerprint,
  runtimePolicyOverrideFingerprint,
  validateRuntimePolicyPatch,
  type RuntimePolicyOverrides,
} from "./bot-runtime-policy.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  /** Stable fallback when a roster was produced by an older/restarted app. */
  toRoutingKey?: string;
  /** Compatibility fallback for older agents that know only the display name. */
  toBotName?: string;
  message: string;
  reason?: string;
  /** Optional one-task policy. Only a Chief may set it, and a user lock can
   * refuse it without blocking ordinary delegation. */
  runtimePolicyOverride?: RuntimePolicyOverrides;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`, which equals MAX_COMMS_DEPTH
   * (= 1) for a user turn — so the peer has no agents integration, and
   * recursive delegation is structurally impossible. */
  depth: number;
}

interface PendingDelegationItem extends DelegationItem {
  /** Stable acknowledgement key for crash-safe removal from the queue. */
  id: string;
  handoff: ParsedHandoff;
  sourceBotId: string;
  stageKey: string;
  evidenceKey: string;
  fingerprint: string;
  attempt: number;
}

/** Captured by the harness from the source turn's admission snapshot. The
 * proxy never supplies these values and queueDelegation never derives them
 * from request data. */
export interface DelegationAdmission {
  retryCap: number;
  handoffByteCap: number;
  reserveDelegation?: () => boolean;
  releaseDelegation?: () => void;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many" | "invalid_handoff" | "invalid_runtime_policy" | "runtime_policy_locked" | "runtime_policy_chief_only" | "conflict" | "duplicate" | "loop_blocked";

/** Per source-thread queue. Persisted to delegations.json on every change
 * and reloaded at boot: a handoff queued right before a restart runs after
 * it. (Provider PERMISSIONS still die with the process — nobody can answer
 * for an unattended bot — but queued work is not a permission; the target
 * and approvePeerComms are re-checked at drain time as always.) */
const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const drainingThreads = new Set<string>();
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");
export const MAX_STAGE_ATTEMPTS = 2;

function normalized(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\s+/gu, " ").toLocaleLowerCase();
}

function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n\u241f\n"), "utf8").digest("hex");
}

function objectiveStage(objective: string): string {
  // Stable issue/package ids survive harmless prose changes such as
  // "fresh", "retry" and "clarification". Without one, use the bounded
  // objective itself rather than guessing semantic equivalence.
  return objective.match(/\b(?:[a-z][a-z0-9]*-\d+[a-z0-9-]*|[a-z]\d+(?:-[a-z0-9]+)*)\b/iu)?.[0]
    ?? objective;
}

function handoffControl(
  sourceBotId: string,
  targetBotId: string,
  handoff: ParsedHandoff,
  targetPolicy?: RuntimePolicyOverrides,
  runtimePolicyOverride?: RuntimePolicyOverrides,
) {
  const files = [...handoff.scope.allowedFiles].map(normalized).sort();
  const stageKey = digest([
    sourceBotId,
    targetBotId,
    normalized(handoff.scope.base),
    normalized(handoff.scope.worktree),
    files.join("\n"),
    normalized(objectiveStage(handoff.objective)),
  ]);
  const evidenceKey = digest([
    normalized(handoff.scope.base),
    normalized(handoff.exactChanges),
    normalized(handoff.verification),
    runtimePolicyOverrideFingerprint(runtimePolicyOverride) ?? "none",
    targetPolicy
      ? runtimePolicyFingerprint(effectiveTaskRuntimePolicy(targetPolicy, runtimePolicyOverride))
      : "legacy-policy-unknown",
  ]);
  return { stageKey, evidenceKey, fingerprint: digest([stageKey, evidenceKey]) };
}

function savePending(): void {
  try {
    writeFileAtomic(DELEGATIONS_FILE, JSON.stringify(Object.fromEntries(pendingDelegations), null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist queue", error);
  }
}

/** Load what a previous process left queued. Missing or corrupt → empty. */
export function _loadPending(): void {
  pendingDelegations.clear();
  try {
    const raw = JSON.parse(readFileSync(DELEGATIONS_FILE, "utf8")) as Record<string, unknown>;
    const loadedScopes: ParsedHandoff[] = [];
    for (const [threadId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const items = list.flatMap((value): PendingDelegationItem[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<PendingDelegationItem>;
        if (
          typeof item.toBotId !== "string" ||
          typeof item.message !== "string" ||
          !Number.isFinite(item.depth)
        ) return [];
        const parsed = parseHandoff(item.message, typeof item.reason === "string" ? item.reason : undefined);
        if (!parsed.ok) return [];
        let runtimePolicyOverride: RuntimePolicyOverrides | undefined;
        if (item.runtimePolicyOverride !== undefined) {
          try {
            const validated = validateRuntimePolicyPatch(item.runtimePolicyOverride);
            if (!validated || typeof validated !== "object") return [];
            runtimePolicyOverride = validated;
          } catch {
            return [];
          }
        }
        if (loadedScopes.some((loaded) => scopesConflict(loaded.scope, parsed.handoff.scope))) return [];
        loadedScopes.push(parsed.handoff);
        const sourceBotId = typeof item.sourceBotId === "string" && item.sourceBotId ? item.sourceBotId : threadId;
        const computed = handoffControl(sourceBotId, item.toBotId, parsed.handoff, undefined, runtimePolicyOverride);
        return [{
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          toBotId: item.toBotId,
          ...(typeof item.toRoutingKey === "string" ? { toRoutingKey: item.toRoutingKey } : {}),
          ...(typeof item.toBotName === "string" ? { toBotName: item.toBotName } : {}),
          message: item.message,
          ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
          ...(runtimePolicyOverride ? { runtimePolicyOverride } : {}),
          depth: Math.max(0, Math.trunc(item.depth!)),
          handoff: parsed.handoff,
          sourceBotId,
          stageKey: typeof item.stageKey === "string" && item.stageKey ? item.stageKey : computed.stageKey,
          evidenceKey: typeof item.evidenceKey === "string" && item.evidenceKey ? item.evidenceKey : computed.evidenceKey,
          fingerprint: typeof item.fingerprint === "string" && item.fingerprint ? item.fingerprint : computed.fingerprint,
          attempt: Number.isFinite(item.attempt) ? Math.max(1, Math.trunc(item.attempt!)) : 1,
        }];
      });
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {
    /* fresh install, or unreadable — start empty */
  }
}

/** Source threads with something queued — what a boot drain iterates. */
export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

/** Read-only metadata for the local Team Map. Task prompts stay private;
 * the UI only needs to know who handed work to whom and the optional label. */
export function pendingDelegationSnapshot(): Array<{
  sourceThreadId: string;
  toBotId: string;
  reason?: string;
}> {
  return [...pendingDelegations.entries()].flatMap(([sourceThreadId, items]) =>
    items.map((item) => ({
      sourceThreadId,
      toBotId: item.toBotId,
      ...(item.reason ? { reason: item.reason } : {}),
    })),
  );
}

/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
export const MAX_QUEUED_PER_THREAD = 4;

/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  sourceThreadId = from.threadId,
  admission?: DelegationAdmission,
): QueueResult {
  if (item.toBotId === from.id) return "self";
  if (item.depth >= maxDepth) return "too_deep";
  const parsed = parseHandoff(item.message, item.reason, admission?.handoffByteCap);
  if (!parsed.ok) return "invalid_handoff";
  const target = bus.store.resolveBotReference(item.toBotId, item.toRoutingKey, item.toBotName);
  if (!target) return "no_target";
  let runtimePolicyOverride: RuntimePolicyOverrides | undefined;
  if (item.runtimePolicyOverride !== undefined) {
    try {
      const validated = validateRuntimePolicyPatch(item.runtimePolicyOverride);
      if (!validated || typeof validated !== "object") return "invalid_runtime_policy";
      runtimePolicyOverride = validated;
    } catch {
      return "invalid_runtime_policy";
    }
    if (!from.chiefOfStaff) return "runtime_policy_chief_only";
    if (target.chiefRuntimePolicyLocked === true) return "runtime_policy_locked";
  }
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  const control = handoffControl(from.id, target.id, parsed.handoff, target.runtimePolicy, runtimePolicyOverride);
  const allPending = [...pendingDelegations.values()].flat();
  if (
    bus.store.hasHandoffFingerprint(target.id, control.fingerprint) ||
    allPending.some((queued) => queued.fingerprint === control.fingerprint)
  ) return "duplicate";
  const attempts = bus.store.handoffStageAttempts(target.id, from.id, control.stageKey)
    + allPending.filter((queued) => queued.sourceBotId === from.id && queued.stageKey === control.stageKey).length;
  const retryCap = Number.isInteger(admission?.retryCap)
    ? Math.max(0, Math.min(1, admission!.retryCap))
    : MAX_STAGE_ATTEMPTS - 1;
  if (attempts >= 1 + retryCap) return "loop_blocked";
  if (bus.store.hasActiveHandoffConflict(parsed.handoff.scope)) return "conflict";
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (list.length >= MAX_QUEUED_PER_THREAD) return "too_many";
  if (Array.from(pendingDelegations.values()).some((items) => items.some((queued) => scopesConflict(queued.handoff.scope, parsed.handoff.scope)))) {
    return "conflict";
  }
  const reserved = admission?.reserveDelegation?.() ?? false;
  if (admission?.reserveDelegation && !reserved) return "too_many";
  try {
    list.push({
      ...item,
      ...(runtimePolicyOverride ? { runtimePolicyOverride } : {}),
      id: newId(),
      handoff: parsed.handoff,
      sourceBotId: from.id,
      ...control,
      attempt: attempts + 1,
    });
    pendingDelegations.set(sourceThreadId, list);
    savePending();
    const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: label },
    });
    return "ok";
  } catch (error) {
    if (reserved) admission?.releaseDelegation?.();
    throw error;
  }
}

/** Drain queued delegations for a source thread (called on its
 * turn.completed). Each item is processed independently: a deny, a busy
 * target, or an error in one does not stop the rest. The actual start
 * of the target turn is delegated to `runTarget` so delegations.ts
 * stays free of harness-level concerns (commsDepth is the only thing
 * the caller needs). */
export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel?: GroupRecord,
    targetThreadId?: string,
  ) => void | Promise<void>,
): void {
  if (drainingThreads.has(threadId)) return;
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const from = bus.store.botByThread(threadId);
  if (!from) {
    pendingDelegations.delete(threadId);
    savePending();
    return;
  }
  const snapshot = [...list];
  drainingThreads.add(threadId);
  void (async () => {
    for (const item of snapshot) {
      try {
        await processOne(bus, approvalBus, from, threadId, item, runTarget);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        try {
          bus.store.appendMessage(threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `error: delegation failed — ${why.slice(0, 120)}`, ok: false },
          });
        } catch (reportError) {
          console.error("delegation failed and could not be reported", reportError);
        }
      } finally {
        acknowledgeDelegation(threadId, item.id);
      }
    }
  })().finally(() => {
    drainingThreads.delete(threadId);
    // A later turn may have queued and settled while this thread was
    // waiting for approval. Its items were not in our snapshot, so start a
    // fresh drain instead of leaving them parked until another restart.
    if (pendingDelegations.get(threadId)?.length) {
      drainDelegations(bus, approvalBus, threadId, runTarget);
    }
  });
}

/** Remove one terminal handoff only after approval/dispatch has settled. */
function acknowledgeDelegation(threadId: string, itemId: string): void {
  const current = pendingDelegations.get(threadId);
  if (!current) return;
  const remaining = current.filter((item) => item.id !== itemId);
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
}

/** Drop a thread's queued handoffs without running them, telling the user
 * they were dropped. Used when the queueing turn failed or was interrupted. */
export function discardDelegations(bus: CommsBus, threadId: string): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  pendingDelegations.delete(threadId);
  savePending();
  const from = bus.store.botByThread(threadId);
  if (!from) return;
  bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
  });
}

async function processOne(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  from: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel?: GroupRecord,
    targetThreadId?: string,
  ) => void | Promise<void>,
): Promise<void> {
  let sender = from;
  let target = bus.store.resolveBotReference(item.toBotId, item.toRoutingKey, item.toBotName);
  if (!target) {
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: delegation target not found — id=${item.toBotId}${item.toRoutingKey ? ` key=${item.toRoutingKey}` : ""}`, ok: false },
    });
    return;
  }
  if (target.busy) {
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled — @${target.name} is busy`, ok: false },
    });
    return;
  }
  if (item.runtimePolicyOverride && (!sender.chiefOfStaff || target.chiefRuntimePolicyLocked === true)) {
    const reason = target.chiefRuntimePolicyLocked === true
      ? "target has Chief runtime policy control locked by the user"
      : "only a section Chief of Staff may set a task runtime policy override";
    bus.store.recordRuntimePolicyAudit(target.id, {
      actorBotId: sender.id,
      actorThreadId: sourceThreadId,
      change: "task-override",
      outcome: "refused",
      reason,
      provenance: "delegate-bot",
      overrideFingerprint: runtimePolicyOverrideFingerprint(item.runtimePolicyOverride),
    });
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled — ${reason}`, ok: false },
    });
    return;
  }
  if (sender.approvePeerComms) {
    const verdict = await requestPeerApproval(
      approvalBus,
      sender,
      target,
      item.message,
      "delegate_bot",
      sourceThreadId,
    );
    if (verdict !== "allow") {
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${target.name} denied by user`, ok: false },
      });
      return;
    }
    // The approval could have been sitting for up to 15 minutes. Everything
    // checked above is a stale snapshot now: re-read both bots and re-check
    // busy, or an allow can start a second turn on a bot that is mid-turn —
    // and mirror a "Messaged @X" chip for an exchange that never happens.
    const current = bus.store.resolveBotReference(item.toBotId, item.toRoutingKey, item.toBotName);
    const currentSender = bus.store.bot(from.id);
    if (!current || !currentSender || !bus.store.taskByThread(currentSender.id, sourceThreadId)) return;
    if (current.busy) {
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${current.name} canceled — @${current.name} is busy`, ok: false },
      });
      return;
    }
    sender = currentSender;
    target = current;
  }
  if (item.runtimePolicyOverride && (!sender.chiefOfStaff || target.chiefRuntimePolicyLocked === true)) {
    const reason = target.chiefRuntimePolicyLocked === true
      ? "target has Chief runtime policy control locked by the user"
      : "only a section Chief of Staff may set a task runtime policy override";
    bus.store.recordRuntimePolicyAudit(target.id, {
      actorBotId: sender.id,
      actorThreadId: sourceThreadId,
      change: "task-override",
      outcome: "refused",
      reason,
      provenance: "delegate-bot",
      overrideFingerprint: runtimePolicyOverrideFingerprint(item.runtimePolicyOverride),
    });
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled — ${reason}`, ok: false },
    });
    return;
  }
  if (bus.store.hasActiveHandoffConflict(item.handoff.scope)) {
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled — worktree or file scope is already active`, ok: false },
    });
    return;
  }
  // A handoff is a new unit of work. Give the target a fresh transcript and
  // provider session before mirroring the request, while ask_bot remains a
  // conversational exchange in the target's current task.
  const taskTitle = item.handoff.objective.trim().slice(0, 80) || item.reason?.trim().slice(0, 80) || "Delegated task";
  const task = bus.store.createTask(target.id, taskTitle, true, item.handoff.scope, {
    sourceBotId: item.sourceBotId,
    stageKey: item.stageKey,
    evidenceKey: item.evidenceKey,
    fingerprint: item.fingerprint,
    attempt: item.attempt,
  }, item.runtimePolicyOverride);
  if (!task) {
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: delegation to @${target.name} failed — could not create a fresh task`, ok: false },
    });
    return;
  }
  const channel = getOrCreateChannel(bus.store, sender, target);
  mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId, task.threadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${sender.name}, another bot in this OpenMausBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  // `resolveBotReference` may have found the worker through its stable
  // routing key or name while `item.toBotId` is a stale UUID from an older
  // roster. Start the turn with the canonical live record we just resolved;
  // passing the original reference here reintroduced `no such bot` after a
  // delegation had already been accepted into the queue.
  try {
    await runTarget(target.id, prefixed, item.depth + 1, sourceThreadId, channel, task.threadId);
    if (item.runtimePolicyOverride) {
      const admittedTask = bus.store.taskByThread(target.id, task.threadId);
      const effectiveFingerprint = admittedTask?.runtimePolicyFingerprint ?? runtimePolicyFingerprint(
        effectiveTaskRuntimePolicy(target.runtimePolicy, item.runtimePolicyOverride),
      );
      bus.store.recordRuntimePolicyAudit(target.id, {
        actorBotId: sender.id,
        actorThreadId: sourceThreadId,
        change: "task-override",
        outcome: "applied",
        reason: "one-task Chief runtime policy override admitted",
        provenance: "delegate-bot",
        afterFingerprint: effectiveFingerprint,
        overrideFingerprint: runtimePolicyOverrideFingerprint(item.runtimePolicyOverride),
      });
    }
  } catch (error) {
    // Dispatch failed before a provider turn could settle. This task has no
    // receipt and therefore cannot become durable replay evidence.
    bus.store.setHandoffTaskState(target.id, task.threadId, "interrupted");
    throw error;
  }
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
  drainingThreads.clear();
}
