// Async peer handoff (`delegate_bot`) — pure logic. Each test stands up a
// real Store with throwaway bots, a fake comms-bus (records broadcasts),
// and a runTarget stub that captures the would-be turn so the test can
// assert what would have been dispatched to the harness. The harness itself
// stays out of these — the integration happens in comms.test.ts (the full
// e2e through the agents proxy + fake ACP CLI).
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  drainDelegations,
  pendingDelegationSnapshot,
  queueDelegation,
  _pendingCount,
  _resetPending,
} from "./delegations.ts";
import { peerAllowKey, resolvePeerComms } from "./peer-approval.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

const handoff = (
  objective: string,
  worktree = "D:/Codex/OpenMausBot-custom",
  file = "server/delegations.ts",
  evidence = "initial",
) =>
  `[OBJECTIVE]\n${objective}\n[BASE/WORKTREE]\nBase: main\nWorktree: ${worktree}\n[ALLOWED FILES]\n- ${file}\n[FORBIDDEN SCOPE]\nDo not touch unrelated files, parent history, logs or other worktrees.\n[EXACT CHANGES]\nImplement only the bounded objective using ${evidence} evidence.\n[VERIFICATION]\nRun the focused tests for ${evidence} and report the result.\n[RECEIPT]\nReturn changed files, commands, results and remaining uncertainty.`;

interface BusPair {
  commsBus: CommsBus;
  approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  broadcasts: unknown[];
}

function setupBuses(store: Store): BusPair {
  const broadcasts: unknown[] = [];
  const broadcast = (payload: unknown) => {
    broadcasts.push(payload);
  };
  // the store emits what it writes; the server turns those into frames.
  // Mirror that here so assertions see what a client would.
  store.onChange((change) => {
    if (change.type === "message" || change.type === "message.patch") {
      broadcasts.push({ kind: change.type, threadId: change.threadId, message: change.message });
    }
  });
  const commsBus: CommsBus = { store, broadcast };
  const approvalBus = { store, broadcast };
  return { commsBus, approvalBus, broadcasts };
}

function settleCompletedFakeTask(store: Store, botId: string, threadId: string, eventId: string): void {
  store.markTaskRunning(botId, threadId);
  store.addTaskUsage(botId, threadId, { input: 17, output: 9, costUsd: null });
  store.recordTaskOutcome(botId, threadId, { eventId, state: "completed" });
  store.setHandoffTaskState(botId, threadId, "settled");
  store.setActivity(botId, "idle");
  expect(store.taskByThread(botId, threadId)?.lifecycle).toMatchObject({
    state: "completed",
    terminalReceipt: { eventId, state: "completed" },
  });
  expect(store.taskByThread(botId, threadId)?.handoffControl?.state).toBe("settled");
}

/** Poll until `predicate` returns a truthy value or `timeout` elapses.
 * drainDelegations is fire-and-forget (processOne runs as a Promise) so
 * tests need to wait for its async steps to land. */
async function waitFor<T>(predicate: () => T | undefined | false, timeout = 2_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = predicate();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("queueDelegation", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: BusPair["approvalBus"];
  let broadcasts: unknown[];

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
    broadcasts = buses.broadcasts;
  });

  it("rejects a self-delegation without queueing", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: from.id,
      message: handoff("self-talk"),
      depth: 0,
    }, 1);
    expect(result).toBe("self");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the source turn is already at the depth cap", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("next task"),
      depth: 1,
    }, 1);
    expect(result).toBe("too_deep");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the target bot does not exist", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: "ghost",
      message: handoff("where?"),
      depth: 0,
    }, 1);
    expect(result).toBe("no_target");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("resolves a stale target id through the stable worker routing key", () => {
    store.patchBot(target.id, { routingKey: "worker-1" });
    const result = queueDelegation(commsBus, from, {
      toBotId: "old-worker-1-id",
      toRoutingKey: "worker-1",
      message: handoff("route by role"),
      depth: 0,
    }, 1);
    expect(result).toBe("ok");
    expect(store.messagesFor(from.threadId).some((m) => m.tool?.name === "Delegated to @Helper")).toBe(true);
  });

  it("resolves a legacy call that puts the stable key in bot_id", () => {
    const target = store.createBot({ name: "Gemini Worker 1" });
    const source = store.createBot({ name: "Coordinator" });
    const result = queueDelegation(
      commsBus,
      source,
      { toBotId: "worker-1", message: handoff("route by legacy key", "D:/work/legacy-key", "server/legacy.ts"), depth: 0 },
      1,
    );
    expect(result).toBe("ok");
    expect(store.messagesFor(source.threadId).some((message) => message.tool?.name.includes(target.name))).toBe(true);
  });

  it("dispatches through the canonical id after resolving a stale target reference", async () => {
    store.patchBot(target.id, { routingKey: "worker-1" });
    expect(queueDelegation(commsBus, from, {
      toBotId: "old-worker-1-id",
      toRoutingKey: "worker-1",
      message: handoff("dispatch by resolved target", "D:/work/canonical-target", "server/canonical.ts"),
      depth: 0,
    }, 1)).toBe("ok");

    const started: string[] = [];
    drainDelegations(commsBus, approvalBus, from.threadId, async (toBotId) => {
      started.push(toBotId);
    });
    await waitFor(() => started.length === 1 && _pendingCount(from.threadId) === 0);
    expect(started).toEqual([target.id]);
  });

  it("queues, broadcasts, and drops a 'Delegated to @Target' chip on the source thread", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("do this"),
      reason: "followup",
      depth: 0,
    }, 1);
    expect(result).toBe("ok");
    expect(_pendingCount(from.threadId)).toBe(1);

    const chip = store
      .messagesFor(from.threadId)
      .find((m) => m.kind === "activity" && m.tool?.name?.startsWith("Delegated to @"));
    expect(chip?.tool?.name).toBe("Delegated to @Helper: followup");

    // The chip is also broadcast over SSE so chat clients see it without
    // polling /api/bots
    const broadcast = broadcasts.find(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { kind?: string }).kind === "message" &&
        (b as { threadId?: string }).threadId === from.threadId,
    );
    expect(broadcast).toBeTruthy();
  });

  it("projects routing metadata without exposing the delegated task prompt", () => {
    queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("private customer task details"),
      reason: "followup",
      depth: 0,
    }, 1);
    const ownSnapshot = pendingDelegationSnapshot().filter((item) => item.sourceThreadId === from.threadId);
    expect(ownSnapshot).toEqual([
      { sourceThreadId: from.threadId, toBotId: target.id, reason: "followup" },
    ]);
    expect(JSON.stringify(ownSnapshot)).not.toContain("private customer task details");
  });

  it("keys detached routine delegations to their real source thread", async () => {
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    const result = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: handoff("routine follow-up"), depth: 0 },
      1,
      routineTask.threadId,
    );

    expect(result).toBe("ok");
    expect(_pendingCount(routineTask.threadId)).toBe(1);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(
      store.messagesFor(routineTask.threadId).some((m) => m.tool?.name === "Delegated to @Helper"),
    ).toBe(true);
    expect(
      store.messagesFor(from.threadId).some((m) => m.tool?.name === "Delegated to @Helper"),
    ).toBe(false);
  });

  it("rejects conflicting parallel handoffs by worktree scope", () => {
    const secondSource = store.createBot({ name: "Second source" });
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("first scope"), depth: 0 }, 1)).toBe("ok");
    expect(
      queueDelegation(commsBus, secondSource, {
        toBotId: target.id,
        message: handoff("conflicting scope", "D:/Codex/OpenMausBot-custom", "server/other.ts"),
        depth: 0,
      }, 1),
    ).toBe("conflict");
  });

  it("rejects an identical handoff while its first copy is still queued", () => {
    const message = handoff("ARCH-11A-R1 design audit", "D:/work/anti-loop", "server/anti-loop.ts");
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message, depth: 0 }, 1)).toBe("ok");
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message, depth: 0 }, 1)).toBe("duplicate");
    expect(_pendingCount(from.threadId)).toBe(1);
  });

  it("rejects replay while the same fresh task is active and after it settles", async () => {
    const message = handoff("ARCH-11A-R1 design audit", "D:/work/durable-replay", "server/replay.ts");
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message, depth: 0 }, 1)).toBe("ok");
    drainDelegations(commsBus, approvalBus, from.threadId, async () => {
      store.setActivity(target.id, "working");
    });
    await waitFor(() => _pendingCount(from.threadId) === 0);

    expect(queueDelegation(commsBus, from, { toBotId: target.id, message, depth: 0 }, 1)).toBe("duplicate");
    expect(store.activeTask(target.id)?.handoffControl).toMatchObject({ attempt: 1, sourceBotId: from.id });

    const task = store.activeTask(target.id)!;
    store.addTaskUsage(target.id, task.threadId, { input: 0, output: 0, costUsd: null });
    store.setHandoffTaskState(target.id, task.threadId, "settled");
    store.setActivity(target.id, "idle");
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message, depth: 0 }, 1)).toBe("duplicate");
  });

  it("allows the same fresh handoff after restart interrupted it before turn.completed", async () => {
    const message = handoff("ARCH-11A-R1 design audit", "D:/work/interrupted-retry", "server/interrupted.ts");
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message, depth: 0 }, 1)).toBe("ok");
    drainDelegations(commsBus, approvalBus, from.threadId, async () => {
      store.setActivity(target.id, "working");
    });
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(store.activeTask(target.id)?.handoffControl?.state).toBe("active");
    expect(store.activeTask(target.id)?.usage).toBeUndefined();

    _resetPending();
    const restarted = new Store(selection);
    const restartedBuses = setupBuses(restarted);
    const restartedFrom = restarted.bot(from.id)!;
    const restartedTarget = restarted.bot(target.id)!;
    expect(restartedTarget.busy).toBe(false);
    expect(restarted.activeTask(restartedTarget.id)?.handoffControl?.state).toBe("interrupted");
    expect(restarted.activeTask(restartedTarget.id)?.lifecycle).toMatchObject({ state: "unknown" });
    expect(queueDelegation(
      restartedBuses.commsBus,
      restartedFrom,
      { toBotId: restartedTarget.id, message, depth: 0 },
      1,
    )).toBe("ok");
    expect(_pendingCount(restartedFrom.threadId)).toBe(1);
  });

  it("allows one evidence-changing retry, then blocks the workflow stage", async () => {
    const sendAndDrain = async (evidence: string) => {
      const result = queueDelegation(commsBus, from, {
        toBotId: target.id,
        message: handoff("ARCH-11A-R1 design audit", "D:/work/bounded-retry", "server/retry.ts", evidence),
        depth: 0,
      }, 1);
      if (result === "ok") {
        drainDelegations(commsBus, approvalBus, from.threadId, async () => {});
        await waitFor(() => _pendingCount(from.threadId) === 0);
        const task = store.activeTask(target.id)!;
        store.addTaskUsage(target.id, task.threadId, { input: 0, output: 0, costUsd: null });
        store.setHandoffTaskState(target.id, task.threadId, "settled");
      }
      return result;
    };

    expect(await sendAndDrain("baseline")).toBe("ok");
    expect(await sendAndDrain("new-primary-evidence")).toBe("ok");
    expect(await sendAndDrain("third-rephrased-attempt")).toBe("loop_blocked");
    expect(store.tasks(target.id).filter((task) => task.handoffControl).map((task) => task.handoffControl?.attempt)).toEqual([2, 1]);
  });

  it("honors retryCap=0 while keeping an interrupted attempt retryable", async () => {
    const admission = { retryCap: 0, handoffByteCap: 12_000 };
    const first = handoff("ARCH-11A-R1 retry zero", "D:/work/retry-zero", "server/retry-zero.ts", "first");
    expect(queueDelegation(commsBus, from, { toBotId: target.id, message: first, depth: 0 }, 1, from.threadId, admission)).toBe("ok");
    drainDelegations(commsBus, approvalBus, from.threadId, async () => {});
    await waitFor(() => _pendingCount(from.threadId) === 0);
    const task = store.activeTask(target.id)!;
    store.addTaskUsage(target.id, task.threadId, { input: 0, output: 0, costUsd: null });
    store.setHandoffTaskState(target.id, task.threadId, "settled");

    expect(queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("ARCH-11A-R1 retry zero", "D:/work/retry-zero", "server/retry-zero.ts", "new evidence"),
      depth: 0,
    }, 1, from.threadId, admission)).toBe("loop_blocked");

    store.setHandoffTaskState(target.id, task.threadId, "interrupted");
    expect(queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: first,
      depth: 0,
    }, 1, from.threadId, admission)).toBe("ok");
  });

  it("stores a Chief task override and allows one evidence-changing policy retry only", async () => {
    store.setChiefOfStaff(from.id);
    const sendAndSettle = async (steps: number) => {
      const result = queueDelegation(commsBus, from, {
        toBotId: target.id,
        message: handoff("ARCH-11A-R1 runtime correction", "D:/work/runtime-correction", "server/runtime.ts", `steps-${steps}`),
        runtimePolicyOverride: { maxToolAgentSteps: steps },
        depth: 0,
      }, 1, from.threadId, { retryCap: 1, handoffByteCap: 12_000 });
      if (result === "ok") {
        drainDelegations(commsBus, approvalBus, from.threadId, async () => {});
        await waitFor(() => _pendingCount(from.threadId) === 0);
        const task = store.activeTask(target.id)!;
        expect(task.runtimePolicyOverride).toEqual({ maxToolAgentSteps: steps });
        expect(store.bot(target.id)?.runtimePolicyAudit?.at(-1)).toMatchObject({
          change: "task-override",
          outcome: "applied",
          provenance: "delegate-bot",
          afterFingerprint: expect.any(String),
          overrideFingerprint: expect.any(String),
        });
        store.markTaskRunning(target.id, task.threadId);
        store.recordTaskOutcome(target.id, task.threadId, { eventId: `runtime-${steps}`, state: "failed", reason: "runtime limit" });
      }
      return result;
    };

    expect(await sendAndSettle(12)).toBe("ok");
    expect(await sendAndSettle(24)).toBe("ok");
    expect(await sendAndSettle(48)).toBe("loop_blocked");
  });

  it("does not audit an applied override when target dispatch fails", async () => {
    store.setChiefOfStaff(from.id);
    expect(queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("ARCH-11A-R1 failed dispatch override", "D:/work/failed-dispatch", "server/failed.ts"),
      runtimePolicyOverride: { maxToolAgentSteps: 12 },
      depth: 0,
    }, 1, from.threadId, { retryCap: 1, handoffByteCap: 12_000 })).toBe("ok");
    drainDelegations(commsBus, approvalBus, from.threadId, async () => {
      throw new Error("provider dispatch rejected");
    });
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(Boolean(store.bot(target.id)?.runtimePolicyAudit?.some((audit) =>
      audit.change === "task-override" && audit.outcome === "applied",
    ))).toBe(false);
  });

  it("keys the same handoff to the effective target policy for one persistent correction", async () => {
    const message = handoff("ARCH-11A-R1 persistent runtime correction", "D:/work/persistent-runtime", "server/persistent.ts", "same evidence");
    const sendAndSettle = async () => {
      const result = queueDelegation(commsBus, from, { toBotId: target.id, message, depth: 0 }, 1, from.threadId, {
        retryCap: 1,
        handoffByteCap: 12_000,
      });
      if (result === "ok") {
        drainDelegations(commsBus, approvalBus, from.threadId, async () => {});
        await waitFor(() => _pendingCount(from.threadId) === 0);
        const task = store.activeTask(target.id)!;
        store.markTaskRunning(target.id, task.threadId);
        store.recordTaskOutcome(target.id, task.threadId, { eventId: `persistent-${store.tasks(target.id).length}`, state: "completed" });
        store.setHandoffTaskState(target.id, task.threadId, "settled");
      }
      return result;
    };

    expect(await sendAndSettle()).toBe("ok");
    const first = store.activeTask(target.id)!;
    expect(await sendAndSettle()).toBe("duplicate");

    store.patchBot(target.id, { runtimePolicy: { maxToolAgentSteps: 12 } });
    expect(await sendAndSettle()).toBe("ok");
    const second = store.activeTask(target.id)!;
    expect(second.handoffControl?.stageKey).toBe(first.handoffControl?.stageKey);
    expect(second.handoffControl?.evidenceKey).not.toBe(first.handoffControl?.evidenceKey);
    expect(second.handoffControl?.fingerprint).not.toBe(first.handoffControl?.fingerprint);

    store.patchBot(target.id, { runtimePolicy: { maxToolAgentSteps: 24 } });
    expect(await sendAndSettle()).toBe("loop_blocked");
  });

  it("refuses a task override when the user-owned Chief lock is enabled", () => {
    store.setChiefOfStaff(from.id);
    store.patchBot(target.id, { chiefRuntimePolicyLocked: true });
    expect(queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("locked override", "D:/work/locked-override", "server/locked.ts"),
      runtimePolicyOverride: { maxToolAgentSteps: 12 },
      depth: 0,
    }, 1, from.threadId, { retryCap: 1, handoffByteCap: 12_000 })).toBe("runtime_policy_locked");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("allows N successful queues from one admission and rejects N+1", () => {
    let queued = 0;
    const admission = {
      retryCap: 1,
      handoffByteCap: 12_000,
      reserveDelegation: () => {
        if (queued >= 2) return false;
        queued += 1;
        return true;
      },
      releaseDelegation: () => { queued -= 1; },
    };
    expect(queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("fan one", "D:/work/fan-one", "server/fan-one.ts"),
      depth: 0,
    }, 1, from.threadId, admission)).toBe("ok");
    expect(queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("fan two", "D:/work/fan-two", "server/fan-two.ts"),
      depth: 0,
    }, 1, from.threadId, admission)).toBe("ok");
    expect(queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: handoff("fan three", "D:/work/fan-three", "server/fan-three.ts"),
      depth: 0,
    }, 1, from.threadId, admission)).toBe("too_many");
    expect(queued).toBe(2);
    expect(_pendingCount(from.threadId)).toBe(2);
  });
});

describe("drainDelegations", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  let runTargetCalls: Array<{
    toBotId: string;
    message: string;
    commsDepth: number;
    sourceThreadId?: string;
    freshThreadId?: string;
  }>;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
    runTargetCalls = [];
  });

  afterEach(() => {
    // Unresolved approval requests carry a 15-min timer that would otherwise
    // keep vitest's event loop alive long after the suite ends. None of the
    // tests above leave one — they all resolve via resolvePeerComms — but
    // double-check by counting the module's pending map: tests that didn't
    // resolve should be re-examined if this ever fires.
    void runTargetCalls;
  });

  it("runs the target's turn via runTarget and mirrors the exchange", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("do this"), depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    const call = runTargetCalls[0]!;
    expect(call.toBotId).toBe(target.id);
    expect(call.commsDepth).toBe(1);
    expect(call.message).toContain("Delegated by @");
    expect(call.message).toContain("do this");

    // Both 1:1 threads picked up their comm chips, attributed to the
    // source/target bot respectively, linking to the same channel.
    const fromChips = store
      .messagesFor(from.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === "Messaged @Helper");
    expect(fromChips).toHaveLength(1);
    const targetChips = store
      .messagesFor(target.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === `Message from @${from.name}`);
    expect(targetChips).toHaveLength(1);
    expect(fromChips[0]?.comm?.groupId).toBe(targetChips[0]?.comm?.groupId);
  });

  it("starts the peer in a fresh task without replaying the source or old peer history", async () => {
    const oldTargetThread = target.threadId;
    store.appendMessage(oldTargetThread, { role: "user", kind: "text", text: "old peer transcript that must not leak" });
    store.appendMessage(oldTargetThread, { role: "bot", kind: "text", text: "old peer answer" });
    store.appendMessage(from.threadId, { role: "user", kind: "text", text: "huge parent history that must not leak" });
    let targetThreadId = "";
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("fresh context"), depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth, sourceThreadId, _channel, freshThreadId) => {
      targetThreadId = freshThreadId ?? "";
      runTargetCalls.push({ toBotId, message, commsDepth, sourceThreadId });
    });
    await waitFor(() => targetThreadId || false);
    expect(targetThreadId).not.toBe(oldTargetThread);
    expect(store.taskByThread(target.id, targetThreadId)?.handoffScope).toMatchObject({
      worktree: "D:/Codex/OpenMausBot-custom",
      allowedFiles: ["server/delegations.ts"],
    });
    const freshMessages = store.messagesFor(targetThreadId);
    expect(freshMessages.some((message) => message.text?.includes("old peer transcript"))).toBe(false);
    expect(freshMessages.some((message) => message.text?.includes("huge parent history"))).toBe(false);
    expect(runTargetCalls.at(-1)?.message).toContain("[OBJECTIVE]");
  });

  it("reuses one persistent routed worker across sequential fresh delegations after a provider change", async () => {
    const providerA: ModelSelection = { instanceId: "claude", model: "fake-model-a" };
    const providerB: ModelSelection = { instanceId: "codex", model: "fake-model-b" };
    const routingKey = "persistent-sequential-worker";
    const oldTargetThreadId = target.threadId;
    const sourceHistory = "source history must not leak into either fresh delegation";
    const oldTargetHistory = "old target history must not leak into either fresh delegation";

    store.patchBot(target.id, { routingKey, modelSelection: providerA });
    store.appendMessage(from.threadId, { role: "user", kind: "text", text: sourceHistory });
    store.appendMessage(oldTargetThreadId, { role: "user", kind: "text", text: oldTargetHistory });
    store.appendMessage(oldTargetThreadId, { role: "bot", kind: "text", text: "old target answer" });

    const dispatchOne = async (staleTargetId: string, message: string) => {
      let enteredResolve!: (call: {
        toBotId: string;
        message: string;
        commsDepth: number;
        sourceThreadId?: string;
        freshThreadId?: string;
      }) => void;
      let returnedResolve!: () => void;
      const entered = new Promise<{
        toBotId: string;
        message: string;
        commsDepth: number;
        sourceThreadId?: string;
        freshThreadId?: string;
      }>((resolve) => {
        enteredResolve = resolve;
      });
      const returned = new Promise<void>((resolve) => {
        returnedResolve = resolve;
      });

      expect(queueDelegation(commsBus, from, {
        toBotId: staleTargetId,
        toRoutingKey: routingKey,
        message,
        depth: 0,
      }, 1)).toBe("ok");
      drainDelegations(commsBus, approvalBus, from.threadId, async (
        toBotId,
        targetMessage,
        commsDepth,
        sourceThreadId,
        _channel,
        freshThreadId,
      ) => {
        const call = { toBotId, message: targetMessage, commsDepth, sourceThreadId, freshThreadId };
        runTargetCalls.push(call);
        enteredResolve(call);
        returnedResolve();
      });

      const call = await entered;
      await returned;
      await Promise.resolve();
      expect(_pendingCount(from.threadId)).toBe(0);
      return call;
    };

    const first = await dispatchOne(
      "stale-target-before-provider-a",
      handoff(
        "sequential fresh delegation one",
        "D:/work/sequential-reuse-one",
        "server/sequential-reuse-one.ts",
        "provider-a-evidence",
      ),
    );
    expect(first.toBotId).toBe(target.id);
    expect(first.freshThreadId).toBeTruthy();
    expect(first.freshThreadId).not.toBe(oldTargetThreadId);
    const firstTask = store.taskByThread(target.id, first.freshThreadId!);
    expect(firstTask).toBeDefined();
    settleCompletedFakeTask(store, target.id, first.freshThreadId!, "a1-sequential-first-completed");
    expect(store.activeTask(target.id)).toMatchObject({
      threadId: first.freshThreadId,
      lifecycle: {
        state: "completed",
        terminalReceipt: { eventId: "a1-sequential-first-completed", state: "completed" },
      },
      handoffControl: { state: "settled" },
    });
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(store.bot(target.id)?.busy).toBe(false);
    expect(store.bot(target.id)?.modelSelection).toEqual(providerA);

    store.patchBot(target.id, { modelSelection: providerB });
    expect(store.bot(target.id)?.id).toBe(target.id);
    expect(store.bot(target.id)?.routingKey).toBe(routingKey);
    expect(store.bot(target.id)?.modelSelection).toEqual(providerB);

    const second = await dispatchOne(
      "stale-target-after-provider-b",
      handoff(
        "sequential fresh delegation two",
        "D:/work/sequential-reuse-two",
        "server/sequential-reuse-two.ts",
        "provider-b-evidence",
      ),
    );
    expect(second.toBotId).toBe(target.id);
    expect(second.freshThreadId).toBeTruthy();
    expect(second.freshThreadId).not.toBe(oldTargetThreadId);
    expect(second.freshThreadId).not.toBe(first.freshThreadId);
    expect(runTargetCalls.map((call) => call.toBotId)).toEqual([target.id, target.id]);
    expect(store.bot(target.id)?.modelSelection).toEqual(providerB);

    for (const threadId of [first.freshThreadId!, second.freshThreadId!]) {
      const messages = store.messagesFor(threadId);
      expect(messages.some((entry) => entry.text?.includes(sourceHistory))).toBe(false);
      expect(messages.some((entry) => entry.text?.includes(oldTargetHistory))).toBe(false);
    }

    const secondTask = store.taskByThread(target.id, second.freshThreadId!);
    expect(secondTask).toBeDefined();
    settleCompletedFakeTask(store, target.id, second.freshThreadId!, "a1-sequential-second-completed");
    expect(store.activeTask(target.id)).toMatchObject({
      threadId: second.freshThreadId,
      lifecycle: {
        state: "completed",
        terminalReceipt: { eventId: "a1-sequential-second-completed", state: "completed" },
      },
      handoffControl: { state: "settled" },
    });
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(store.bot(target.id)?.busy).toBe(false);
  });

  it("launches disjoint concurrent scopes and rejects a third overlapping scope before runTarget", async () => {
    const secondSource = store.createBot({ name: "Second source" });
    const secondTarget = store.createBot({ name: "Second target" });
    const thirdSource = store.createBot({ name: "Third source" });
    const thirdTarget = store.createBot({ name: "Third target" });
    const calls: Array<{
      toBotId: string;
      message: string;
      commsDepth: number;
      sourceThreadId?: string;
      freshThreadId?: string;
    }> = [];
    let enteredResolve!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const returnedSignals: Promise<void>[] = [];
    let released = false;

    const runTarget = async (
      toBotId: string,
      message: string,
      commsDepth: number,
      sourceThreadId?: string,
      _channel?: unknown,
      freshThreadId?: string,
    ) => {
      let returnedResolve!: () => void;
      returnedSignals.push(new Promise<void>((resolve) => {
        returnedResolve = resolve;
      }));
      calls.push({ toBotId, message, commsDepth, sourceThreadId, freshThreadId });
      if (calls.length === 2) enteredResolve();
      await held;
      returnedResolve();
    };

    const firstMessage = handoff(
      "concurrent disjoint delegation one",
      "D:/work/concurrent-disjoint-one",
      "server/concurrent-disjoint-one.ts",
      "concurrent-evidence-one",
    );
    const secondMessage = handoff(
      "concurrent disjoint delegation two",
      "D:/work/concurrent-disjoint-two",
      "server/concurrent-disjoint-two.ts",
      "concurrent-evidence-two",
    );
    const overlappingMessage = handoff(
      "overlapping third delegation",
      "D:/work/concurrent-disjoint-one",
      "server/concurrent-disjoint-overlap.ts",
      "concurrent-overlap-evidence",
    );

    expect(queueDelegation(commsBus, from, { toBotId: target.id, message: firstMessage, depth: 0 }, 1)).toBe("ok");
    expect(queueDelegation(commsBus, secondSource, { toBotId: secondTarget.id, message: secondMessage, depth: 0 }, 1)).toBe("ok");
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    drainDelegations(commsBus, approvalBus, secondSource.threadId, runTarget);

    try {
      await bothEntered;
      expect(released).toBe(false);
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.toBotId).sort()).toEqual([secondTarget.id, target.id].sort());
      expect(calls.every((call) => Boolean(call.freshThreadId))).toBe(true);
      expect(new Set(calls.map((call) => call.freshThreadId)).size).toBe(2);

      expect(queueDelegation(commsBus, thirdSource, {
        toBotId: thirdTarget.id,
        message: overlappingMessage,
        depth: 0,
      }, 1)).toBe("conflict");
      expect(calls).toHaveLength(2);
    } finally {
      released = true;
      release();
      await Promise.all(returnedSignals);
      await Promise.resolve();
      calls.forEach((call, index) => {
        if (call.freshThreadId) {
          settleCompletedFakeTask(store, call.toBotId, call.freshThreadId, `a1-concurrent-${index + 1}-completed`);
        }
      });
      expect(_pendingCount(from.threadId)).toBe(0);
      expect(_pendingCount(secondSource.threadId)).toBe(0);
      expect(_pendingCount(thirdSource.threadId)).toBe(0);
      calls.forEach((call, index) => {
        expect(store.activeTask(call.toBotId)).toMatchObject({
          threadId: call.freshThreadId,
          lifecycle: {
            state: "completed",
            terminalReceipt: { eventId: `a1-concurrent-${index + 1}-completed`, state: "completed" },
          },
          handoffControl: { state: "settled" },
        });
        expect(store.bot(call.toBotId)?.busy).toBe(false);
      });
      expect(store.bot(target.id)?.busy).toBe(false);
      expect(store.bot(secondTarget.id)?.busy).toBe(false);
    }
  });

  it("includes the reason line in the prefixed message when one is given", async () => {
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: handoff("do this"), reason: "next step", depth: 0 },
      1,
    );
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.message).toContain("[Reason: next step]");
  });

  it("drains and mirrors a detached routine delegation on its source thread", async () => {
    const activeThreadId = from.threadId;
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: handoff("routine follow-up"), depth: 0 },
      1,
      routineTask.threadId,
    );

    drainDelegations(
      commsBus,
      approvalBus,
      routineTask.threadId,
      (toBotId, message, commsDepth, sourceThreadId) => {
        runTargetCalls.push({ toBotId, message, commsDepth, sourceThreadId });
      },
    );

    await waitFor(() => runTargetCalls.length === 1 && _pendingCount(routineTask.threadId) === 0);
    expect(_pendingCount(routineTask.threadId)).toBe(0);
    expect(runTargetCalls[0]?.sourceThreadId).toBe(routineTask.threadId);
    expect(
      store.messagesFor(routineTask.threadId).some((m) => m.tool?.name === "Messaged @Helper"),
    ).toBe(true);
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name === "Messaged @Helper"),
    ).toBe(false);
  });

  it("contains a rejected delegation worker and reports it on the source thread", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("do this"), depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, () => {
      throw new Error("target runner exploded");
    });

    const failure = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.tool?.ok === false && m.tool.name.includes("target runner exploded")),
    );
    expect(failure.tool?.name).toContain("delegation failed");
  });

  it("reports an asynchronous target-start rejection on a detached source thread", async () => {
    const activeThreadId = from.threadId;
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: handoff("do this"), depth: 0 },
      1,
      routineTask.threadId,
    );
    drainDelegations(commsBus, approvalBus, routineTask.threadId, () =>
      Promise.reject(new Error("provider disappeared")),
    );

    const failure = await waitFor(() =>
      store
        .messagesFor(routineTask.threadId)
        .find((m) => m.tool?.ok === false && m.tool.name.includes("provider disappeared")),
    );
    expect(failure.tool?.name).toContain("delegation failed");
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name.includes("provider disappeared")),
    ).toBe(false);
  });

  it("skips runTarget and emits a target-not-found chip when the target was deleted", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("do this"), depth: 0 }, 1);
    store.deleteBot(target.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("delegation target not found")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("skips runTarget and emits a 'is busy' chip when the target is currently busy", async () => {
    store.patchBot(target.id, { busy: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("do this"), depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("is busy")),
    );
    expect(chip.tool?.name).toBe("Delegation to @Helper canceled — @Helper is busy");
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("asks for approval when approvePeerComms is on, then runs only on allow", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("do this"), depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    // the source bot's thread shows the options card BEFORE runTarget fires
    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    expect(card.card?.title).toContain("delegate to @Helper");
    expect(card.card?.tool).toBe("delegate_bot");
    expect(card.card?.allowKey).toBe(peerAllowKey("delegate_bot", target.id));
    expect(card.card?.options).toEqual(["Allow", "Deny", "Always allow"]);
    expect(runTargetCalls).toEqual([]);

    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.toBotId).toBe(target.id);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
  });

  it("emits a denial chip and skips runTarget when the user denies", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("do this"), depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    resolvePeerComms(approvalBus, card.card!.requestId!, "deny");

    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("denied by user")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("auto-allows when alwaysAllow already covers the pair (no card pushed)", async () => {
    store.patchBot(from.id, {
      approvePeerComms: true,
      alwaysAllow: [peerAllowKey("delegate_bot", target.id)],
    });
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("do this"), depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
    const card = store
      .messagesFor(from.threadId)
      .find((m) => m.card?.requestId && m.card.tool === "delegate_bot");
    expect(card).toBeUndefined();
  });

  it("no-ops when nothing is queued for the source thread", () => {
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });

  it("no-ops when the source thread no longer resolves to a bot", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: handoff("do this"), depth: 0 }, 1);
    store.deleteBot(from.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { _loadPending, discardDelegations, pendingThreads } from "./delegations.ts";

describe("delegations survive a restart", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let buses: BusPair;
  const file = () => join(DATA_DIR, "delegations.json");

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    buses = setupBuses(store);
  });
  afterEach(() => _resetPending());

  it("writes the queue to disk on queue, and clears it on drain and discard", async () => {
    const queuedMessage = handoff("do this");
    expect(queueDelegation(buses.commsBus, from, { toBotId: target.id, message: queuedMessage, depth: 0 }, 1)).toBe("ok");
    expect(existsSync(file())).toBe(true);
    const onDisk = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown[]>;
    expect(onDisk[from.threadId]).toHaveLength(1);
    expect(onDisk[from.threadId][0]).toMatchObject({ toBotId: target.id, message: queuedMessage });

    discardDelegations(buses.commsBus, from.threadId);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: handoff("again", "D:/Codex/OpenMausBot-custom/again", "server/again.ts"), depth: 0 }, 1);
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();
  });

  it("keeps a handoff durable until its approval and dispatch path settles", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: handoff("wait for dispatch"), depth: 0 }, 1);
    let release!: () => void;
    const dispatchSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async () => {
      started = true;
      await dispatchSettled;
    });

    await waitFor(() => started);
    expect(pendingThreads()).toEqual([from.threadId]);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toHaveLength(1);

    release();
    await waitFor(() => pendingThreads().length === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();
  });

  it("drains work queued by a later settled turn while an earlier handoff is waiting", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: handoff("first"), depth: 0 }, 1);
    let release!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const runTarget = async (_to: string, message: string) => {
      ran.push(message);
      if (message.includes("first")) await firstSettled;
    };
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
    await waitFor(() => ran.length === 1);

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: handoff("second", "D:/Codex/OpenMausBot-custom/second", "server/second.ts"), depth: 0 }, 1);
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
    expect(ran).toHaveLength(1);

    release();
    await waitFor(() => ran.length === 2 && pendingThreads().length === 0);
    expect(ran[1]).toContain("second");
  });

  it("a fresh process loads what the last one queued, and can drain it", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: handoff("left over"), depth: 0 }, 1);
    // "restart": forget memory, reload from disk
    _resetPending();
    expect(pendingThreads()).toEqual([]);
    _loadPending();
    expect(pendingThreads()).toEqual([from.threadId]);
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(ran[0]).toContain("left over");
    expect(pendingThreads()).toEqual([]);
  });

  it("tolerates a missing or corrupt file", () => {
    _resetPending();
    _loadPending(); // no file
    expect(pendingThreads()).toEqual([]);
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file(), "{not json");
    _loadPending();
    expect(pendingThreads()).toEqual([]);
  });
});
