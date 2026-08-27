import { describe, expect, it } from "vitest";

import { configStatusFromFrame, initialState, reducer, runtimePolicySignature, type Bot, type Message, type RuntimePolicy } from "./store";

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
      }),
    ).toEqual({
      xai: { configured: true },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
    });
  });
});

describe("runtime policy synchronization signature", () => {
  const policy: RuntimePolicy = {
    wallClockTimeoutMinutes: 0,
    idleTimeoutMinutes: 20,
    cancellationGraceSeconds: 5,
    retryCap: 1,
    maxToolAgentSteps: 100,
    delegationConcurrency: 4,
    freshSessionEnforcement: false,
    handoffByteCap: 12_000,
    cumulativeTokenPolicy: { mode: "soft", limit: 2_000_000 },
  };

  it("ignores object identity but changes for every runtime control value", () => {
    expect(runtimePolicySignature(structuredClone(policy))).toBe(runtimePolicySignature(policy));

    const changedPolicies: RuntimePolicy[] = [
      { ...policy, wallClockTimeoutMinutes: 1 },
      { ...policy, idleTimeoutMinutes: 21 },
      { ...policy, cancellationGraceSeconds: 6 },
      { ...policy, retryCap: 0 },
      { ...policy, maxToolAgentSteps: 101 },
      { ...policy, delegationConcurrency: 3 },
      { ...policy, freshSessionEnforcement: true },
      { ...policy, handoffByteCap: 11_999 },
      { ...policy, cumulativeTokenPolicy: { ...policy.cumulativeTokenPolicy, mode: "hard" } },
      { ...policy, cumulativeTokenPolicy: { ...policy.cumulativeTokenPolicy, limit: 2_000_001 } },
    ];

    for (const changed of changedPolicies) {
      expect(runtimePolicySignature(changed)).not.toBe(runtimePolicySignature(policy));
    }
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
      runtimePolicy: {
        wallClockTimeoutMinutes: 0,
        idleTimeoutMinutes: 20,
        cancellationGraceSeconds: 5,
        retryCap: 0,
        maxToolAgentSteps: 0,
        delegationConcurrency: 2,
        freshSessionEnforcement: true,
        handoffByteCap: 2_048,
        cumulativeTokenPolicy: { mode: "soft", limit: 2_000 },
      },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);
    expect(added.bots[0]?.runtimePolicy).toMatchObject({ retryCap: 0, delegationConcurrency: 2, handoffByteCap: 2_048 });

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});
