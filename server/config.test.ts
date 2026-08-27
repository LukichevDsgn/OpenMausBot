import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DATA_DIR,
  publicConfigTransactionFailure,
  replaceAppConfig,
  instanceConfigs,
  isValidSshAlias,
  loadConfig,
  parseConfigPatch,
  parseStoredConfig,
  sanitizeStoredCustomEndpointUrls,
  roomTurnTimeoutMinutes,
  stripWorkspaceCredentialEnv,
  runConfigTransaction,
  syncCredentialEnv,
  vpsSshAlias,
  withInstanceCli,
  WORKSPACE_CREDENTIAL_ENV,
  type AppConfig,
} from "./config.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("configuration boundaries", () => {
  it("keeps supported stored settings and drops unrelated top-level data", () => {
    expect(
      parseStoredConfig({
        profile: { name: "Ada", email: "ada@example.com" },
        instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
        unrelated: { secret: "not part of the config contract" },
      }),
    ).toEqual({
      profile: { name: "Ada", email: "ada@example.com" },
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    });
  });

  it("rejects malformed stored instances and API patches", () => {
    expect(() => parseStoredConfig({ instances: { claude: { driver: 42 } } })).toThrow("instances.claude.driver");
    expect(() => parseConfigPatch({ opencodeGo: { apiKey: 42 } })).toThrow("opencodeGo.apiKey");
    expect(() => parseConfigPatch({ nvidia: { apiKey: 42 } })).toThrow("nvidia.apiKey");
    expect(() => parseConfigPatch({ profile: [] })).toThrow("profile");
  });

  it.each([
    "https://user:password@example.test/api",
    "https://example.test/api?token=secret",
    "https://example.test/api#fragment",
    "https://example.test/api?",
    "https://example.test/api#",
  ])("rejects unsafe custom endpoint save input without echoing %s", (baseUrl) => {
    expect(() => parseConfigPatch({
      customEndpoints: {
        unsafe: {
          id: "unsafe",
          name: "Unsafe",
          providerId: "unsafe",
          baseUrl,
          defaultModel: "model",
        },
      },
    })).toThrow();
    try {
      parseConfigPatch({
        customEndpoints: {
          unsafe: {
            id: "unsafe",
            name: "Unsafe",
            providerId: "unsafe",
            baseUrl,
            defaultModel: "model",
          },
        },
      });
    } catch (error) {
      expect(String(error)).not.toContain(baseUrl);
    }
  });

  it("sanitizes legacy endpoint URLs before strict stored-config validation", () => {
    const raw = {
      profile: { name: "Ada" },
      unrelated: { keep: true },
      customEndpoints: {
        first: {
          id: "first",
          name: "First",
          providerId: "first",
          baseUrl: "https://user:password@example.test/api?token=secret#fragment",
          defaultModel: "first-model",
          apiKey: "endpoint-secret",
        },
      },
    };
    const sanitized = sanitizeStoredCustomEndpointUrls(raw);
    expect(sanitized.changed).toBe(true);
    expect((sanitized.value as typeof raw).unrelated).toEqual({ keep: true });
    expect(raw.customEndpoints.first.baseUrl).toContain("user:password");
    expect(parseStoredConfig(raw).customEndpoints?.first).toMatchObject({
      baseUrl: "https://example.test/api",
      apiKey: "endpoint-secret",
    });
  });

  it("loads and atomically migrates multiple legacy endpoints without losing raw metadata", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-config-url-migration-"));
    try {
      const configPath = join(dataDir, "config.json");
      const raw = {
        profile: { name: "Ada" },
        unrelated: { keep: "yes" },
        customEndpoints: {
          first: {
            id: "first",
            name: "First",
            providerId: "first",
            baseUrl: "https://user:password@example.test/api/?token=secret#fragment",
            defaultModel: "first-model",
            useForNewChats: true,
            apiKey: "first-key",
          },
          second: {
            id: "second",
            name: "Second",
            providerId: "second",
            baseUrl: "http://example.test/second?",
            defaultModel: "second-model",
            discoverModels: true,
          },
          safe: {
            id: "safe",
            name: "Safe",
            providerId: "safe",
            baseUrl: "https://safe.example/path%3Fpart%23fragment",
            defaultModel: "safe-model",
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(raw, null, 2));

      const loaded = loadConfig(dataDir);
      expect(loaded.profile).toEqual({ name: "Ada" });
      expect(loaded.customEndpoints?.first).toMatchObject({
        baseUrl: "https://example.test/api",
        apiKey: "first-key",
      });
      expect(loaded.customEndpoints?.second?.baseUrl).toBe("http://example.test/second");
      expect(loaded.customEndpoints?.safe?.baseUrl).toBe("https://safe.example/path%3Fpart%23fragment");

      const migrated = readFileSync(configPath, "utf8");
      expect(migrated).toContain('"unrelated"');
      expect(migrated).toContain('"first-key"');
      expect(migrated).not.toContain("user:password");
      expect(migrated).not.toContain("token=secret");
      expect(migrated).not.toContain("#fragment");

      loadConfig(dataDir);
      expect(readFileSync(configPath, "utf8")).toBe(migrated);
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it("keeps sanitized runtime usable when migration persistence fails and retries later", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-config-url-retry-"));
    try {
      const configPath = join(dataDir, "config.json");
      const raw = {
        customEndpoints: {
          retry: {
            id: "retry",
            name: "Retry",
            providerId: "retry",
            baseUrl: "https://user:password@example.test/retry?token=secret#fragment",
            defaultModel: "retry-model",
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(raw, null, 2));
      const persist = vi.fn(() => {
        throw new Error("simulated disk failure");
      });

      const loaded = loadConfig(dataDir, persist);
      expect(loaded.customEndpoints?.retry?.baseUrl).toBe("https://example.test/retry");
      expect(persist).toHaveBeenCalledOnce();
      expect(readFileSync(configPath, "utf8")).toContain("user:password");

      loadConfig(dataDir);
      expect(readFileSync(configPath, "utf8")).not.toContain("user:password");
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it("accepts only a simple VPS SSH config alias and exposes no credentials", () => {
    expect(isValidSshAlias("production-vps")).toBe(true);
    expect(isValidSshAlias("prod; reboot")).toBe(false);
    expect(() => parseConfigPatch({ vps: { sshAlias: "prod; reboot" } })).toThrow("vps.sshAlias");
    expect(parseConfigPatch({ vps: { sshAlias: "production-vps" } })).toEqual({
      vps: { sshAlias: "production-vps" },
    });
    expect(vpsSshAlias({ vps: { sshAlias: "production-vps" } })).toBe("production-vps");
    expect(vpsSshAlias({ vps: { sshAlias: "-bad" } })).toBeNull();
  });

  it("accepts a persisted global room turn timeout and supplies the legacy default", () => {
    expect(parseStoredConfig({ rooms: { turnTimeoutMinutes: 20 } })).toEqual({
      rooms: { turnTimeoutMinutes: 20 },
    });
    expect(roomTurnTimeoutMinutes({ rooms: { turnTimeoutMinutes: 20 } })).toBe(20);
    expect(roomTurnTimeoutMinutes({})).toBe(5);
  });

  it.each([0, 1.5, 1441, "20", null])(
    "rejects an invalid room turn timeout: %j",
    (turnTimeoutMinutes) => {
      expect(() => parseConfigPatch({ rooms: { turnTimeoutMinutes } })).toThrow(
        "rooms.turnTimeoutMinutes",
      );
    },
  );
});

describe("config transaction boundaries", () => {
  it("commits disk before env and live config", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-config-transaction-success-"));
    try {
      const configPath = join(dataDir, "config.json");
      const originalBytes = Buffer.from('{"profile":{"name":"old"}}\n');
      writeFileSync(configPath, originalBytes);
      const environment: Record<string, string | undefined> = {
        XAI_API_KEY: "old-env",
        OPENMAUSBOT_ENDPOINT_ALPHA_API_KEY: "old-endpoint",
      };
      const live: AppConfig = { profile: { name: "old" }, xai: { key: "old-env" } };
      const order: string[] = [];
      const result = await runConfigTransaction(live, {
        applyDisk: () => {
          order.push("disk");
          writeFileSync(configPath, '{"profile":{"name":"new"}}\n');
        },
        applyEnv: () => {
          order.push("env");
          environment.XAI_API_KEY = "new-env";
          environment.OPENMAUSBOT_ENDPOINT_ALPHA_API_KEY = "new-endpoint";
        },
        readConfig: () => ({ profile: { name: "new" }, xai: { key: "new-env" } }),
        commitConfig: (next) => {
          order.push("cfg");
          replaceAppConfig(live, next);
        },
      }, { dataDir, environment });

      expect(result.outcome).toBe("success");
      expect(order).toEqual(["disk", "env", "cfg"]);
      expect(readFileSync(configPath, "utf8")).toBe('{"profile":{"name":"new"}}\n');
      expect(environment).toMatchObject({ XAI_API_KEY: "new-env", OPENMAUSBOT_ENDPOINT_ALPHA_API_KEY: "new-endpoint" });
      expect(live).toEqual({ profile: { name: "new" }, xai: { key: "new-env" } });
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it("restores exact disk, env, and cfg after an apply failure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-config-transaction-apply-"));
    try {
      const configPath = join(dataDir, "config.json");
      const originalBytes = Buffer.from('{"profile":{"name":"old"}}\r\n');
      writeFileSync(configPath, originalBytes);
      const environment: Record<string, string | undefined> = { XAI_API_KEY: "old-env" };
      const live: AppConfig = { profile: { name: "old" }, xai: { key: "old-env" } };
      const result = await runConfigTransaction(live, {
        applyDisk: () => {
          writeFileSync(configPath, "partial secret\n");
          throw new Error("apply failed with secret");
        },
        applyEnv: () => { environment.XAI_API_KEY = "new-env"; },
        commitConfig: (next) => { replaceAppConfig(live, next); },
      }, { dataDir, environment });

      expect(result.outcome).toBe("rolled_back");
      expect(readFileSync(configPath)).toEqual(originalBytes);
      expect(environment.XAI_API_KEY).toBe("old-env");
      expect(live).toEqual({ profile: { name: "old" }, xai: { key: "old-env" } });
      expect(JSON.stringify(publicConfigTransactionFailure(result.outcome))).not.toContain("secret");
      expect(Object.keys(result)).toEqual(["outcome", "config"]);
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it("rebuilds the old fleet only after a begun reload and reports rollback", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-config-transaction-reload-"));
    try {
      const configPath = join(dataDir, "config.json");
      const originalBytes = Buffer.from('{"profile":{"name":"old"}}');
      writeFileSync(configPath, originalBytes);
      const environment: Record<string, string | undefined> = { XAI_API_KEY: "old-env" };
      const live: AppConfig = { profile: { name: "old" }, xai: { key: "old-env" } };
      const reloads: string[] = [];
      const result = await runConfigTransaction(live, {
        applyDisk: () => writeFileSync(configPath, '{"profile":{"name":"new"}}'),
        applyEnv: () => { environment.XAI_API_KEY = "new-env"; },
        readConfig: () => ({ profile: { name: "new" }, xai: { key: "new-env" } }),
        reload: async (next) => {
          replaceAppConfig(live, next);
          reloads.push(next.profile?.name ?? "");
          if (next.profile?.name === "new") throw new Error("reload failed with secret");
        },
      }, { dataDir, environment });

      expect(result.outcome).toBe("rolled_back");
      expect(reloads).toEqual(["new", "old"]);
      expect(readFileSync(configPath)).toEqual(originalBytes);
      expect(environment.XAI_API_KEY).toBe("old-env");
      expect(live).toEqual({ profile: { name: "old" }, xai: { key: "old-env" } });
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it("replaces optional config keys exactly on rollback and success", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-config-transaction-exact-"));
    try {
      const configPath = join(dataDir, "config.json");
      writeFileSync(configPath, "{}");
      const environment: Record<string, string | undefined> = {};
      const live: AppConfig = { profile: { name: "old" } };
      const snapshot = structuredClone(live);
      const failed = await runConfigTransaction(live, {
        applyDisk: () => writeFileSync(configPath, '{"profile":{"name":"new"}}'),
        readConfig: () => ({
          profile: { name: "new" },
          customEndpoints: {
            added: {
              id: "added",
              name: "Added",
              providerId: "added",
              baseUrl: "https://added.example.test/v1",
              defaultModel: "added-model",
            },
          },
        }),
        reload: async (next) => {
          replaceAppConfig(live, next);
          if (next.customEndpoints) throw new Error("new fleet failed");
        },
      }, { dataDir, environment });

      expect(failed.outcome).toBe("rolled_back");
      expect(live).toEqual(snapshot);
      expect(live.customEndpoints).toBeUndefined();

      replaceAppConfig(live, {
        profile: { name: "stale" },
        customEndpoints: {
          stale: {
            id: "stale",
            name: "Stale",
            providerId: "stale",
            baseUrl: "https://stale.example.test/v1",
            defaultModel: "stale-model",
          },
        },
      });
      const succeeded = await runConfigTransaction(live, {
        applyDisk: () => writeFileSync(configPath, '{"profile":{"name":"final"}}'),
        readConfig: () => ({ profile: { name: "final" } }),
        reload: async (next) => replaceAppConfig(live, next),
      }, { dataDir, environment });

      expect(succeeded.outcome).toBe("success");
      expect(live).toEqual({ profile: { name: "final" } });
      expect(live.customEndpoints).toBeUndefined();
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it("classifies snapshot preflight failure as rolled back without callbacks or leakage", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-config-transaction-preflight-"));
    try {
      const configPath = join(dataDir, "config.json");
      mkdirSync(configPath);
      const live: AppConfig = { profile: { name: "unchanged" } };
      const before = structuredClone(live);
      const calls: string[] = [];
      const result = await runConfigTransaction(live, {
        applyDisk: () => { calls.push("disk"); },
        applyEnv: () => { calls.push("env"); },
        commitConfig: () => { calls.push("commit"); },
        reload: async () => { calls.push("reload"); },
      }, { dataDir, environment: { XAI_API_KEY: "preflight-secret" } });
      const publicFailure = publicConfigTransactionFailure(result.outcome);

      expect(result.outcome).toBe("rolled_back");
      expect(calls).toEqual([]);
      expect(live).toEqual(before);
      expect(publicFailure).toEqual({ error: "configuration transaction failed", outcome: "rolled_back" });
      expect(Object.keys(result)).toEqual(["outcome", "config"]);
      expect(JSON.stringify(result)).not.toContain(dataDir);
      expect(JSON.stringify(result)).not.toContain("preflight-secret");
      expect(JSON.stringify(result)).not.toContain("cause");
      expect(JSON.stringify(publicFailure)).not.toContain(dataDir);
      expect(JSON.stringify(publicFailure)).not.toContain("preflight-secret");
      expect(result.cause).toBeInstanceOf(Error);
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it("reports unknown when exact restoration cannot complete", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-config-transaction-unknown-"));
    try {
      const configPath = join(dataDir, "config.json");
      writeFileSync(configPath, '{"profile":{"name":"old"}}');
      const environment: Record<string, string | undefined> = { XAI_API_KEY: "old-env" };
      const live: AppConfig = { profile: { name: "old" }, xai: { key: "old-env" } };
      const result = await runConfigTransaction(live, {
        applyDisk: () => {
          rmSync(dataDir, { recursive: true, force: true });
          writeFileSync(dataDir, "blocking file");
          throw new Error("apply failed with secret");
        },
        applyEnv: () => { environment.XAI_API_KEY = "new-env"; },
        commitConfig: (next) => { replaceAppConfig(live, next); },
      }, { dataDir, environment });

      expect(result.outcome).toBe("unknown");
      expect(result.rollbackCause).toBeDefined();
      expect(environment.XAI_API_KEY).toBe("old-env");
      expect(live).toEqual({ profile: { name: "old" }, xai: { key: "old-env" } });
      expect(publicConfigTransactionFailure(result.outcome)).toEqual({
        error: "configuration transaction failed",
        outcome: "unknown",
      });
    } finally {
      await removeTempDir(dataDir);
    }
  });
});

describe("default fleet", () => {
  it("ships Qwen and Hermes as custom-only engines", () => {
    const map = instanceConfigs({});
    expect(map.qwen).toEqual({ driver: "qwenAgent", environment: {} });
    expect(map.hermes).toEqual({ driver: "hermesAgent", environment: {} });
  });

  it("ships Cursor as a default-fleet subscription engine", () => {
    const map = instanceConfigs({});
    expect(map.cursor).toEqual({ driver: "cursorAgent", environment: {} });
  });

  it("adds missing custom-only engines onto an existing product fleet", () => {
    const map = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } });
    expect(map.claude.driver).toBe("claudeAgent");
    expect(map.qwen?.driver).toBe("qwenAgent");
    expect(map.hermes?.driver).toBe("hermesAgent");
    expect(map.cursor?.driver).toBe("cursorAgent");
  });

  it("does not expand a one-off shadow fleet", () => {
    const map = instanceConfigs({ instances: { ghost: { driver: "not-a-real-driver" } } });
    expect(Object.keys(map)).toEqual(["ghost"]);
  });

  it("adds the existing OpenCode worker when a custom endpoint is configured", () => {
    const map = instanceConfigs({
      instances: { claude: { driver: "claudeAgent" } },
      customEndpoints: {
        openrouter: {
          id: "openrouter",
          name: "OpenRouter",
          providerId: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          defaultModel: "z-ai/glm-5.2",
          apiKey: "endpoint-secret",
        },
      },
    });
    expect(map.opencodeGo?.driver).toBe("opencodeGo");
    expect(map.opencodeGo?.environment).toEqual({ OPENMAUSBOT_ENDPOINT_OPENROUTER_API_KEY: "endpoint-secret" });
  });
});

describe("Instance CLI override", () => {
  it("sets, replaces, and clears config.cli on a default-fleet instance", () => {
    const cfg: AppConfig = {};
    const set = withInstanceCli(cfg, "claude", "/opt/claude-2.1/bin/claude");
    expect(set.ok).toBe(true);
    expect(set.config.instances!.claude.config).toEqual({ cli: "/opt/claude-2.1/bin/claude" });

    const replaced = withInstanceCli(set.config, "claude", "~/bin/claude");
    expect(replaced.config.instances!.claude.config).toEqual({ cli: "~/bin/claude" });

    const cleared = withInstanceCli(replaced.config, "claude", "");
    expect(cleared.config.instances!.claude.config).toBeUndefined();
  });

  it("preserves sibling config keys when clearing only cli", () => {
    const cfg: AppConfig = {
      instances: { claude: { driver: "claudeAgent", config: { cli: "/x/claude", permissionMode: "bypassPermissions" } } },
    };
    const cleared = withInstanceCli(cfg, "claude", "");
    expect(cleared.config.instances!.claude.config).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("leaves the original config untouched and rejects unknown instances", () => {
    const cfg: AppConfig = { instances: { codex: { driver: "codex" } } };
    const result = withInstanceCli(cfg, "codex", "/new/codex");
    expect(result.config.instances!.codex.config).toEqual({ cli: "/new/codex" });
    expect(cfg.instances!.codex.config).toBeUndefined();

    expect(withInstanceCli(cfg, "nope", "/x").ok).toBe(false);
  });

  it("never persists the credential env instanceConfigs injects", () => {
    // instanceConfigs() copies each credential into its consuming driver's
    // environment for the live fleet; withInstanceCli must strip those pairs
    // back out, or saving a CLI override would copy secrets into the
    // instances section of config.json.
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
      opencodeGo: { apiKey: "SECRET-OCG" },
      instances: {
        claude: { driver: "claudeAgent" },
        grokApi: { driver: "grok" },
        computer: { driver: "boxAgent" },
        opencode: { driver: "opencodeGo" },
      },
    };
    const set = withInstanceCli(cfg, "claude", "/opt/claude");
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
    // user-authored env survives
    const custom = { instances: { claude: { driver: "claudeAgent", environment: { MY_FLAG: "1" } } } };
    const kept = withInstanceCli(custom, "claude", "/x");
    expect(kept.config.instances!.claude.environment).toEqual({ MY_FLAG: "1" });
  });
});

describe("OpenCode Go configuration", () => {
  it("injects the key only into OpenCode Go instances", () => {
    const cfg: AppConfig = {
      opencodeGo: { apiKey: "secret-value" },
      instances: {
        opencode: { driver: "opencodeGo" },
        grok: { driver: "grokAgent" },
      },
    };

    const instances = instanceConfigs(cfg);
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "secret-value" });
    expect(instances.grok.environment).toEqual({});
  });

  it("injects direct aggregator credentials only into Codex instances", () => {
    const cfg: AppConfig = {
      nvidia: { apiKey: "SECRET-NVIDIA" },
      openrouter: { apiKey: "SECRET-OPENROUTER" },
      instances: {
        codex: { driver: "codex" },
        hermes: { driver: "hermesAgent" },
      },
    };
    const instances = instanceConfigs(cfg);
    expect(instances.codex.environment).toEqual({
      OPENMAUSBOT_NVIDIA_API_KEY: "SECRET-NVIDIA",
      OPENMAUSBOT_OPENROUTER_API_KEY: "SECRET-OPENROUTER",
    });
    expect(instances.hermes.environment).toEqual({});
  });
});

describe("credential env narrowing", () => {
  it("injects each credential only into the driver that consumes it", () => {
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
      opencodeGo: { apiKey: "SECRET-OCG" },
      instances: {
        grokApi: { driver: "grok" },
        computer: { driver: "boxAgent" },
        opencode: { driver: "opencodeGo" },
        claude: { driver: "claudeAgent" },
        codex: { driver: "codex" },
      },
    };
    const instances = instanceConfigs(cfg);
    expect(instances.grokApi.environment).toEqual({ XAI_API_KEY: "SECRET-XAI" });
    expect(instances.computer.environment).toEqual({ BOX_TOKEN: "SECRET-BOX" });
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "SECRET-OCG" });
    // engines that bring their own login receive NO workspace credential
    expect(instances.claude.environment).toEqual({});
    expect(instances.codex.environment).toEqual({});
  });

  it("hands no credential to any default-fleet CLI engine except the Computer", () => {
    // the default `grok` instance is the CLI-login grokAgent, not the
    // API-key driver, so a configured xai key reaches nobody by default
    const cfg: AppConfig = { xai: { key: "SECRET-XAI" }, box: { token: "SECRET-BOX" } };
    const instances = instanceConfigs(cfg);
    for (const [id, entry] of Object.entries(instances)) {
      if (id === "computer") expect(entry.environment).toEqual({ BOX_TOKEN: "SECRET-BOX" });
      else expect(entry.environment).toEqual({});
    }
  });

  it("keeps a per-instance environment while layering the credential on top", () => {
    const cfg: AppConfig = {
      box: { token: "SECRET-BOX" },
      instances: { computer: { driver: "boxAgent", environment: { MY_FLAG: "1" } } },
    };
    expect(instanceConfigs(cfg).computer.environment).toEqual({ MY_FLAG: "1", BOX_TOKEN: "SECRET-BOX" });
  });
});

describe("credential env preference", () => {
  const VARS = [
    "XAI_API_KEY",
    "NVIDIA_API_KEY",
    "OPENROUTER_API_KEY",
    "BOX_TOKEN",
    "OPENCODE_API_KEY",
    "OMB_TTS_KEY",
    "COMPOSIO_API_KEY",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });
  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });

  it("prefers env over the config file for every credential", () => {
    // the desktop shell hands secrets to this process as env (from its
    // OS-encrypted store) and leaves the file without them — env must win
    // even over a leftover plaintext value
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
      xai: { key: "file-xai", url: "https://api.example.test/v1" },
      nvidia: { apiKey: "file-nvidia" },
      openrouter: { apiKey: "file-openrouter" },
        box: { token: "file-box" },
        opencodeGo: { apiKey: "file-ocg" },
        tts: { key: "file-tts", voice: "narrator" },
      }),
    );
    process.env.XAI_API_KEY = "env-xai";
    process.env.NVIDIA_API_KEY = "env-nvidia";
    process.env.OPENROUTER_API_KEY = "env-openrouter";
    process.env.BOX_TOKEN = "env-box";
    process.env.OPENCODE_API_KEY = "env-ocg";
    process.env.OMB_TTS_KEY = "env-tts";
    const cfg = loadConfig();
    expect(cfg.xai).toEqual({ key: "env-xai", url: "https://api.example.test/v1" });
    expect(cfg.nvidia).toEqual({ apiKey: "env-nvidia" });
    expect(cfg.openrouter).toEqual({ apiKey: "env-openrouter" });
    expect(cfg.box).toEqual({ token: "env-box" });
    expect(cfg.opencodeGo).toEqual({ apiKey: "env-ocg" });
    expect(cfg.tts).toEqual({ key: "env-tts", voice: "narrator" });
  });

  it("falls back to the config file when the env var is unset (dev mode)", () => {
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({ xai: { key: "file-xai" }, tts: { key: "file-tts" } }),
    );
    const cfg = loadConfig();
    expect(cfg.xai?.key).toBe("file-xai");
    expect(cfg.tts?.key).toBe("file-tts");
  });

  it("treats a blanked file field as absent when env supplies the secret", () => {
    // after migration the desktop shell may leave "" behind (a cleared key
    // that was saved mid-session); the env-injected value must still win
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ xai: { key: "" } }));
    process.env.XAI_API_KEY = "env-xai";
    expect(loadConfig().xai?.key).toBe("env-xai");
  });

  it("syncCredentialEnv keeps process.env in step with a credential save", () => {
    process.env.XAI_API_KEY = "boot-injected";
    process.env.BOX_TOKEN = "boot-injected";
    process.env.COMPOSIO_API_KEY = "boot-injected";
    syncCredentialEnv({
      xai: { key: "just-saved" },
      composio: { apiKey: "ak_just_saved" },
      box: { token: "" },
      profile: { name: "Ada" },
    });
    // a saved value replaces the boot-time one; a cleared value drops it;
    // untouched sections change nothing
    expect(process.env.XAI_API_KEY).toBe("just-saved");
    expect(process.env.COMPOSIO_API_KEY).toBe("ak_just_saved");
    expect(process.env.BOX_TOKEN).toBeUndefined();
    expect(process.env.OMB_TTS_KEY).toBeUndefined();
  });
});

describe("workspace credential env strip", () => {
  it("removes every workspace credential from a child env in place", () => {
    const env = {
      PATH: "/usr/bin",
      MY_FLAG: "1",
      ...Object.fromEntries(WORKSPACE_CREDENTIAL_ENV.map((name) => [name, "secret"])),
    };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", MY_FLAG: "1" });
  });

  it("covers the box token and voice key, which no engine CLI may inherit", () => {
    // these two have no per-driver ACP allowlist entry anywhere — they are
    // consumed in-process (Computer driver / voice module), never by a CLI
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("BOX_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_TTS_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("API_KEY_21ST");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("API_KEY_SECRET");
  });
});
