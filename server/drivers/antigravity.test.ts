// Antigravity driver contract tests, run against the scripted fake `agy` CLI
// in server/testing/fake-agy-cli.ts: normalize the print-mode stream-json turn
// into canonical events, and report availability from `agy --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly;
// spawnCli resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  ANTIGRAVITY_WORKSPACE_TOOL_CONTRACT,
  AntigravityDriver,
  isCompletedTaskKillRace,
  isCompletedReceiptScheduleRace,
  readAntigravityModelCatalog,
  STATIC_ANTIGRAVITY_MODELS,
} from "./antigravity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

describe("readAntigravityModelCatalog", () => {
  it("returns the official list when settings are missing", () => {
    expect(readAntigravityModelCatalog({ HOME: join(tmpdir(), "omb-agy-missing-home") })).toEqual(
      STATIC_ANTIGRAVITY_MODELS,
    );
  });

  it("tags extra settings models as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-catalog-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ customModels: [{ id: "local-gemini", displayName: "Local Gemini" }] }),
    );
    try {
      const catalog = readAntigravityModelCatalog({ HOME: home });
      expect(catalog.options.slice(0, STATIC_ANTIGRAVITY_MODELS.options.length)).toEqual(STATIC_ANTIGRAVITY_MODELS.options);
      expect(catalog.options.at(-1)).toEqual({ id: "local-gemini", label: "Local Gemini", custom: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Antigravity decodeConfig", () => {
  it("publishes the official installer for every supported platform", () => {
    expect(AntigravityDriver.install).toMatchObject({
      command: {
        darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        win32: "irm https://antigravity.google/cli/install.ps1 | iex",
      },
    });
  });

  it("defaults to the agy binary and fullAuto on", () => {
    expect(AntigravityDriver.decodeConfig({})).toEqual({ cli: "agy", fullAuto: true });
    expect(AntigravityDriver.decodeConfig(undefined)).toEqual({ cli: "agy", fullAuto: true });
  });
  it("fullAuto defaults to true, only false when explicitly set", () => {
    expect(AntigravityDriver.decodeConfig({}).fullAuto).toBe(true);
    expect(AntigravityDriver.decodeConfig({ fullAuto: false }).fullAuto).toBe(false);
    expect(AntigravityDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
  it("rejects invalid types (throws → shadow snapshot)", () => {
    expect(() => AntigravityDriver.decodeConfig({ cli: 5 })).toThrow(/invalid cli/);
    expect(() => AntigravityDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/invalid fullAuto/);
  });
});

describe("Antigravity turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-test",
      displayName: "Antigravity Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full print-mode turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "gemini-3.1-pro-high" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // tool ACTIVE
      "item.completed", // tool DONE
      "thread.token-usage.updated", // agent_response usage
      "content.delta", // result.response
      "item.completed", // assistant_text
      "thread.token-usage.updated", // result usage
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "antigravityAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as any).sessionId).toBe("conv-fake-123");

    const tool = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "tool")!;
    expect((tool as any).ok).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 105, output: 20 });

    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("done from fake agy");

    const done = recorder.events.at(-1)!;
    // result.usage is the turn total (the per-step figures precede it)
    expect(done).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 105, output: 20 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("respondToRequest resolves `unavailable` — no interactive permission channel, so the caller denies", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-happy", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("injects the workspace tool contract and a long-running turn timeout", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-prompt-"));
    const dump = join(scratch, "turn.json");
    process.env.FAKE_AGY_DUMP = dump;
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-tool-contract", text: "finish the package", model: "gemini-3.7-flash-medium" });
      await recorder.until((e) => e.type === "turn.completed");
      const invocation = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
      const print = invocation.argv.indexOf("--print");
      const timeout = invocation.argv.indexOf("--print-timeout");
      expect(invocation.argv[print + 1]).toContain(ANTIGRAVITY_WORKSPACE_TOOL_CONTRACT);
      expect(invocation.argv[print + 1]).toContain("Never use write_to_file for a workspace path");
      expect(invocation.argv[print + 1]).toContain("WaitMsBeforeAsync to 3600000");
      expect(invocation.argv[print + 1]).toContain('never emit repeated "I will wait" updates');
      expect(invocation.argv[print + 1]).toContain("A run_command step with state DONE is already complete");
      expect(invocation.argv[print + 1]).toContain("isolate that exact case");
      expect(invocation.argv[timeout + 1]).toBe("60m");
    } finally {
      delete process.env.FAKE_AGY_DUMP;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("emits the exact Antigravity result error before terminal failure", async () => {
    process.env.FAKE_AGY_RESULT_ERROR = 'exec: "grep": executable file not found in %PATH%';
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-exact-error", text: "work" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
        message: expect.stringContaining('exec: "grep": executable file not found in %PATH%'),
      });
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "ERROR" });
    } finally {
      delete process.env.FAKE_AGY_RESULT_ERROR;
    }
  });

  it("treats a redundant kill of an already DONE task as a successful cleanup no-op", async () => {
    process.env.FAKE_AGY_RESULT_ERROR =
      'cannot kill task "351348bf-63f8-4008-824e-6d25e5c3cf72/task-52": task is not running (status: DONE)';
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-completed-kill-race", text: "work" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, stopReason: "SUCCESS" });
    } finally {
      delete process.env.FAKE_AGY_RESULT_ERROR;
    }
  });

  it("treats an exact post-receipt schedule conflict as successful cleanup", async () => {
    process.env.FAKE_AGY_RESULT_ERROR =
      'another active schedule task "conversation/task-100" has a conflicting early termination condition "task-98"';
    process.env.FAKE_AGY_RESULT_RESPONSE = "IMPLEMENTATION-RECEIPT\ncommit abc";
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-completed-schedule-race", text: "work" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, stopReason: "SUCCESS" });
    } finally {
      delete process.env.FAKE_AGY_RESULT_ERROR;
      delete process.env.FAKE_AGY_RESULT_RESPONSE;
    }
  });

  it("stops a repeated schedule loop for a run_command task already reported DONE", async () => {
    process.env.FAKE_AGY_REDUNDANT_POLL_LOOP = "1";
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-redundant-poll-loop", text: "work" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
        message: expect.stringContaining("task-7 was already DONE before schedule"),
      });
      expect(recorder.events.at(-1)).toMatchObject({
        type: "turn.completed",
        ok: false,
        stopReason: "redundant_poll_loop",
      });
    } finally {
      delete process.env.FAKE_AGY_REDUNDANT_POLL_LOOP;
    }
  });
});

describe("isCompletedTaskKillRace", () => {
  it("accepts only the exact DONE cleanup race with a non-empty response", () => {
    const error = 'cannot kill task "conversation/task-52": task is not running (status: DONE)';
    expect(isCompletedTaskKillRace(error, "receipt")).toBe(true);
    expect(isCompletedTaskKillRace(error, "")).toBe(false);
    expect(isCompletedTaskKillRace(error.replace("DONE", "RUNNING"), "receipt")).toBe(false);
    expect(isCompletedTaskKillRace('exec: "grep": executable file not found', "receipt")).toBe(false);
  });
});

describe("isCompletedReceiptScheduleRace", () => {
  it("requires the exact schedule conflict and a terminal receipt", () => {
    const error = 'another active schedule task "conversation/task-100" has a conflicting early termination condition "task-98"';
    expect(isCompletedReceiptScheduleRace(error, "IMPLEMENTATION-RECEIPT\ncommit abc")).toBe(true);
    expect(isCompletedReceiptScheduleRace(error, "still working")).toBe(false);
    expect(isCompletedReceiptScheduleRace(error.replace("schedule", "shell"), "AUDIT-RECEIPT\nACCEPT")).toBe(false);
  });
});

describe("Antigravity snapshot", () => {
  it("reports available with the CLI version against the fake", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("1.1.12");
    // agy auth is keyring-backed with no reliable file marker, so the snapshot
    // must NOT claim signed-in from a mere directory — authenticated stays unset.
    expect((snap as any).authenticated).toBeUndefined();
    await instance.dispose();
  });

  it("a missing binary is unavailable", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "agy-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-agy-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toContain("isn't installed");
    expect(snap.setup).toBe(true);
    await instance.dispose();
  });

  it("retries one transient version failure instead of reporting the CLI missing", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-version-retry-"));
    const marker = join(scratch, "failed-once");
    process.env.FAKE_AGY_VERSION_FAIL_ONCE = marker;
    const instance = await AntigravityDriver.create({
      instanceId: "agy-version-retry",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "available", version: "1.1.12" });
      expect(existsSync(marker)).toBe(true);
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_VERSION_FAIL_ONCE;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not label a runnable CLI with a persistent probe error as not installed", async () => {
    process.env.FAKE_AGY_VERSION_ALWAYS_FAIL = "1";
    const instance = await AntigravityDriver.create({
      instanceId: "agy-version-failure",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      const snap = await instance.snapshot();
      expect(snap.state).toBe("unavailable");
      expect(snap.reason).toContain("spawn failed");
      expect(snap.reason).not.toContain("isn't installed");
      expect(snap.setup).toBe(false);
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_VERSION_ALWAYS_FAIL;
    }
  });

  it("strips workspace credentials from snapshot and helper children", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-env-"));
    const dump = join(scratch, "dump.json");
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "OPENCODE_API_KEY", "OMB_TTS_KEY"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.FAKE_AGY_DUMP = dump;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;
    const instance = await AntigravityDriver.create({
      instanceId: "agy-env",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await instance.snapshot();
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();

      await instance.generateText?.("summarize safely");
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_DUMP;
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
