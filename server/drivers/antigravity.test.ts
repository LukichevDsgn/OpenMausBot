// Antigravity driver contract tests, run against the scripted fake `agy` CLI
// in server/testing/fake-agy-cli.ts: normalize the print-mode stream-json turn
// into canonical events, and report availability from `agy --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly;
// spawnCli resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ANTIGRAVITY_NETWORK_ROUTE_ENV, ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  ANTIGRAVITY_COMPUTER_MCP_KEY,
  ANTIGRAVITY_REVIEW_UNSUPPORTED_REASON,
  ANTIGRAVITY_WORKSPACE_TOOL_CONTRACT,
  AntigravityDriver,
  antigravityProxyUnavailableReason,
  antigravityComputerMcpServer,
  ensureAntigravityComputerMcp,
  isCompletedTaskKillRace,
  isCompletedReceiptScheduleRace,
  readAntigravityModelCatalog,
  STATIC_ANTIGRAVITY_MODELS,
} from "./antigravity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

async function loopbackServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

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

  it("does not advertise approval review because print mode has no safe stdin-only hook", async () => {
    await create();
    expect(instance.reviewPermission).toBeUndefined();
    expect(ANTIGRAVITY_REVIEW_UNSUPPORTED_REASON).toBe(
      "Antigravity print mode accepts prompts only in --print argv; it has no stdin-only JSON review or isolated permission hook",
    );
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

  it("applies Off, TUN, and Proxy to every Antigravity child environment", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-route-"));
    const { server, port } = await loopbackServer();
    const inherited = {
      HTTP_PROXY: "http://inherited-http",
      http_proxy: "http://inherited-http",
      HTTPS_PROXY: "http://inherited-https",
      https_proxy: "http://inherited-https",
      ALL_PROXY: "http://inherited-all",
      all_proxy: "http://inherited-all",
      NO_PROXY: "inherited-no-proxy",
      no_proxy: "inherited-no-proxy",
      GODEBUG: "custom=1,http2client=0,other=2",
    };
    const cases = [
      { route: "off", expectedRoute: "off", expected: inherited },
      { route: "system", expectedRoute: "tun", expected: { GODEBUG: "custom=1,other=2" } },
      {
        route: `proxy|HTTP://127.0.0.1:${port}`,
        expectedRoute: `proxy|http://127.0.0.1:${port}`,
        expected: {
          HTTP_PROXY: `http://127.0.0.1:${port}`,
          http_proxy: `http://127.0.0.1:${port}`,
          HTTPS_PROXY: `http://127.0.0.1:${port}`,
          https_proxy: `http://127.0.0.1:${port}`,
          ALL_PROXY: `http://127.0.0.1:${port}`,
          all_proxy: `http://127.0.0.1:${port}`,
          NO_PROXY: "127.0.0.1,localhost,[::1]",
          no_proxy: "127.0.0.1,localhost,[::1]",
          GODEBUG: "custom=1,other=2,http2client=0",
        },
      },
    ] as const;
    try {
      for (const [index, testCase] of cases.entries()) {
        const dumps = [join(scratch, `${index}-a.json`), join(scratch, `${index}-b.json`)];
        const instances = await Promise.all(dumps.map((dump, childIndex) => AntigravityDriver.create({
          instanceId: `agy-route-${index}-${childIndex}`,
          displayName: undefined,
          environment: {
            ...inherited,
            [ANTIGRAVITY_NETWORK_ROUTE_ENV]: testCase.route,
            FAKE_AGY_DUMP: dump,
          },
          enabled: true,
          config: { cli: FAKE_CLI, fullAuto: false },
        })));
        const recorders = instances.map((instance) => recordEvents(instance.adapter));
        await Promise.all(instances.map((instance, childIndex) =>
          instance.adapter.sendTurn({ threadId: `agy-route-thread-${index}-${childIndex}`, text: "route probe" }),
        ));
        await Promise.all(recorders.map((recorder) => recorder.until((event) => event.type === "turn.completed")));
        for (const dump of dumps) {
          const invocation = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
          expect(invocation.env[ANTIGRAVITY_NETWORK_ROUTE_ENV]).toBe(testCase.expectedRoute);
          for (const [name, value] of Object.entries(testCase.expected)) {
            expect(invocation.env[name] ?? invocation.env[name.toUpperCase()]).toBe(value);
          }
          if (testCase.expectedRoute === "tun") {
            for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
              expect(invocation.env[name] ?? invocation.env[name.toLowerCase()]).toBeUndefined();
            }
          }
        }
        await Promise.all(instances.map((instance) => instance.dispose()));
      }
    } finally {
      await closeServer(server);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("checks a Proxy endpoint before probe/turn spawn", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-dead-proxy-"));
    const dump = join(scratch, "spawn.json");
    const unused = await loopbackServer();
    const deadPort = unused.port;
    await closeServer(unused.server);
    const dead = await AntigravityDriver.create({
      instanceId: "agy-dead-proxy",
      displayName: undefined,
      environment: {
        [ANTIGRAVITY_NETWORK_ROUTE_ENV]: `proxy|http://127.0.0.1:${deadPort}`,
        FAKE_AGY_DUMP: dump,
      },
      enabled: true,
      config: { cli: "definitely-not-a-real-agy-binary", fullAuto: false },
    });
    const recorder = recordEvents(dead.adapter);
    try {
      const expected = `Proxy unavailable: nothing is listening on 127.0.0.1:${deadPort}. Start the proxy or choose TUN/Off.`;
      expect(await dead.snapshot()).toMatchObject({ state: "unavailable", reason: expected });
      await dead.adapter.sendTurn({ threadId: "agy-dead-proxy-turn", text: "must not spawn" });
      await recorder.until((event) => event.type === "turn.completed");
      expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expected });
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "proxy_unavailable" });
      expect(existsSync(dump)).toBe(false);
    } finally {
      await dead.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports protocol default ports for explicit loopback proxy URLs", async () => {
    const ports: number[] = [];
    const unavailable = (route: string) => antigravityProxyUnavailableReason(route, ({ port }) => {
      ports.push(port);
      const socket = new Socket();
      queueMicrotask(() => socket.emit("error", new Error("simulated unavailable proxy")));
      return socket;
    });
    await expect(unavailable("proxy|http://127.0.0.1:80"))
      .resolves.toBe("Proxy unavailable: nothing is listening on 127.0.0.1:80. Start the proxy or choose TUN/Off.");
    await expect(unavailable("proxy|https://127.0.0.1:443"))
      .resolves.toBe("Proxy unavailable: nothing is listening on 127.0.0.1:443. Start the proxy or choose TUN/Off.");
    expect(ports).toEqual([80, 443]);
  });
});

describe("Antigravity computer MCP config", () => {
  const configPath = (home: string) => join(home, ".gemini", "config", "mcp_config.json");
  const readConfig = (home: string) => JSON.parse(readFileSync(configPath(home), "utf8"));
  const boxIntegrations = {
    computer: {
      kind: "box" as const,
      boxId: "bx_1",
      token: "box-tok",
      control: { url: "http://127.0.0.1:9/control", token: "ctl-tok" },
    },
  };
  const boxEntry = () => antigravityComputerMcpServer(boxIntegrations)!;

  it("builds the cloud-box spec on the shared computer proxy (never path-resolved locally)", () => {
    expect(antigravityComputerMcpServer(boxIntegrations)).toEqual({
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: "bx_1",
        OGB_BOX_TOKEN: "box-tok",
        OMB_CONTROL_URL: "http://127.0.0.1:9/control",
        OMB_CONTROL_TOKEN: "ctl-tok",
      },
    });
  });

  it("passes a Local VM / VPS stdio connection through unchanged, and yields null without a computer", () => {
    expect(
      antigravityComputerMcpServer({
        localComputer: { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
      }),
    ).toEqual({ command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } });
    expect(antigravityComputerMcpServer({})).toBeNull();
    expect(antigravityComputerMcpServer(undefined)).toBeNull();
  });

  it("upserts only its own key — the user's servers and unknown top-level keys survive", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpcfg-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } },
          futureTopLevelKey: { keep: true },
        }),
      );
      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      let config = readConfig(home);
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      // A later turn on a different computer overwrites the key in place.
      ensureAntigravityComputerMcp(
        { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
        { HOME: home },
      );
      config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY].command).toBe("/opt/cua");
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts fresh from malformed JSON instead of failing the turn", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpbad-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(configPath(home), "{{{ not json");
      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restricts the token-bearing config directory and file to the current user", () => {
    if (process.platform === "win32") return;
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpperms-"));
    try {
      const directory = dirname(configPath(home));
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      writeFileSync(configPath(home), "{}\n", { mode: 0o644 });

      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves concurrent config edits while restoring only its own MCP entry", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpconcurrent-"));
    try {
      const restoreNewFile = ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      const concurrentlyCreated = readConfig(home);
      concurrentlyCreated.mcpServers["external-helper"] = { command: "external-mcp" };
      concurrentlyCreated.futureTopLevelKey = { keep: true };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyCreated));

      restoreNewFile();
      expect(existsSync(configPath(home))).toBe(true);
      let restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(restored.mcpServers["external-helper"]).toEqual({ command: "external-mcp" });
      expect(restored.futureTopLevelKey).toEqual({ keep: true });

      const originalEntry = { command: "user-owned-mcp", args: ["--serve"] };
      writeFileSync(
        configPath(home),
        JSON.stringify({ mcpServers: { [ANTIGRAVITY_COMPUTER_MCP_KEY]: originalEntry } }),
      );
      const restoreExistingEntry = ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      const concurrentlyEdited = readConfig(home);
      concurrentlyEdited.mcpServers["another-helper"] = { command: "another-mcp" };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyEdited));

      restoreExistingEntry();
      restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(originalEntry);
      expect(restored.mcpServers["another-helper"]).toEqual({ command: "another-mcp" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a computer-less turn removes only its own key, and never creates the file just to remove", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcprm-"));
    try {
      // No file at all: removal is a no-op, not an empty file in the user's home.
      ensureAntigravityComputerMcp(null, { HOME: home });
      expect(existsSync(configPath(home))).toBe(false);

      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: {
            "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] },
            [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
          },
        }),
      );
      ensureAntigravityComputerMcp(null, { HOME: home });
      const config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("advertises computerMcp only on full-auto instances, and never localComputerMcp", async () => {
    const fullAuto = await AntigravityDriver.create({
      instanceId: "agy-caps-full",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const acceptEdits = await AntigravityDriver.create({
      instanceId: "agy-caps-safe",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(fullAuto.adapter.capabilities.computerMcp).toBe(true);
      // accept-edits print mode auto-denies tools that would prompt, so a
      // mount there could never fire — the capability must not be offered.
      expect(acceptEdits.adapter.capabilities.computerMcp).toBe(false);
      // The host desktop needs per-action human approval; print mode has no
      // approval channel in any mode.
      expect(fullAuto.adapter.capabilities.localComputerMcp).toBeUndefined();
      expect(acceptEdits.adapter.capabilities.localComputerMcp).toBeUndefined();
    } finally {
      await fullAuto.dispose();
      await acceptEdits.dispose();
    }
  });

  it("uses the spawned CLI's HOME and restores the prior config when the turn exits", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpturn-"));
    const dump = join(home, "mcp-at-spawn.json");
    const original = JSON.stringify({ mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } } });
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(configPath(home), original);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-mcp-turn",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "100", FAKE_AGY_MCP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-mcp-on",
        text: "click things",
        integrations: boxIntegrations,
      });
      // sendTurn resolves after the child is spawned; the write happens
      // synchronously before that spawn, so this IS the spawn-time content.
      const mounted = readConfig(home);
      expect(mounted.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(mounted.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => readFileSync(configPath(home), "utf8")).toBe(original);
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serializes overlapping turns so each child sees only its own computer mount", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcplease-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-first",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "150", FAKE_AGY_MCP_DUMP: firstDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-second",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-first", text: "first", integrations: boxIntegrations });
      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-second", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondSpawned).toBe(false);
      await firstRecorder.until((event) => event.type === "turn.completed");
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps a child that hangs after result, restores the mount, and unblocks the next turn", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpreaper-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-zombie",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_MCP_DUMP: firstDump,
        FAKE_AGY_POST_RESULT_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-zombie",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-zombie", text: "first", integrations: boxIntegrations });
      await firstRecorder.until((event) => event.type === "turn.completed");
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-zombie", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("force-reaps an interrupted child that ignores SIGTERM before result", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpinterrupt-"));
    const readyFile = join(home, "ready");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-interrupted",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
        FAKE_AGY_READY_FILE: readyFile,
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-interrupt",
      displayName: undefined,
      environment: { HOME: home },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-interrupted", text: "first", integrations: boxIntegrations });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => existsSync(readyFile), { timeout: 2_000 }).toBe(true);
      await first.adapter.interruptTurn("t-mcp-interrupted");

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-interrupt", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");
      await expect.poll(() => existsSync(configPath(home)), { timeout: 6_000 }).toBe(false);
    } finally {
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
