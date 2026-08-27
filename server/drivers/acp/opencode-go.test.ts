import { describe, expect, it, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import {
  canListOpenCodeModels,
  classifyOpenCodeError,
  createOpenCodeDriver,
  createOpenCodeGoDriver,
  ensureOpenCodeInjectModel,
  fetchOpenCodeCliModels,
  fetchOpenCodeGoModels,
  filterOpenCodeDesktopModels,
  OPENCODE_CLI_CACHE_MAX_SCOPES,
  OPENCODE_PUBLIC_CATALOG_MAX_OPTIONS,
  OPENCODE_PUBLIC_CATALOG_SETTLE_MS,
  openCodeCliScopeKey,
  normalizeLegacyOpenCodeModel,
  parseOpenCodeModelsOutput,
  OPENCODE_NEW_SESSION_TIMEOUT_MS,
  resetOpenCodeGoModelCache,
} from "./opencode-go.ts";
import { CUSTOM_ENDPOINT_MAX_BODY_BYTES } from "../../custom-endpoints.ts";
import type { ModelCatalog } from "../../contracts.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const catalog = (...ids: string[]): ModelCatalog => ({
  default: ids[0]!,
  options: ids.map((id) => ({ id, label: id })),
});

describe("OpenCode Go catalog", () => {
  beforeEach(() => resetOpenCodeGoModelCache());
  it("parses the model catalog exposed by the installed OpenCode CLI", () => {
    const models = parseOpenCodeModelsOutput([
      "tabi/claude-opus-5-thinking",
      "zai-coding-plan/glm-5.2",
      "openrouter/~anthropic/claude-opus-latest",
      "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      "invalid model id",
      "openrouter/model#invalid-variant",
      "",
    ].join("\n"));

    expect(models).toEqual({
      default: "tabi/claude-opus-5-thinking",
      options: [
        { id: "tabi/claude-opus-5-thinking", label: "Tabi · Claude Opus 5 Thinking", custom: true },
        { id: "zai-coding-plan/glm-5.2", label: "Zai Coding Plan · Glm 5 2", custom: true },
        { id: "openrouter/~anthropic/claude-opus-latest", label: "OpenRouter · ~anthropic Claude Opus Latest", custom: true },
        { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", label: "OpenRouter · Nvidia Nemotron 3 Ultra 550b A55b:free", custom: true },
      ],
    });
  });

  it("uses verbose CLI names and keeps provider provenance in labels", () => {
    const models = parseOpenCodeModelsOutput([
      "opencode/x-preview-f-free",
      "{",
      '  "id": "x-preview-f-free",',
      '  "providerID": "opencode",',
      '  "name": "Ox Alpha Free (Unlimited)",',
      '  "options": {}',
      "}",
      "openrouter/stealth/ox-alpha",
      "{",
      '  "id": "stealth/ox-alpha",',
      '  "providerID": "openrouter",',
      '  "name": "Ox Alpha"',
      "}",
    ].join("\n"));

    expect(models?.options).toEqual([
      { id: "opencode/x-preview-f-free", label: "OpenCode Zen · Ox Alpha Free (Unlimited)", custom: true },
      { id: "openrouter/stealth/ox-alpha", label: "OpenRouter · Ox Alpha", custom: true },
    ]);
  });

  it("mirrors explicitly shown desktop models for connected providers only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-desktop-models-"));
    try {
      const appData = join(scratch, "appdata");
      const dataHome = join(scratch, "data");
      const statePath = join(appData, "ai.opencode.desktop", "opencode.global.dat");
      const authPath = join(dataHome, "opencode", "auth.json");
      mkdirSync(dirname(statePath), { recursive: true });
      mkdirSync(dirname(authPath), { recursive: true });
      writeFileSync(authPath, JSON.stringify({
        opencode: { type: "api", key: "zen-key" },
        openrouter: { type: "api", key: "router-key" },
      }));
      writeFileSync(statePath, JSON.stringify({
        model: JSON.stringify({
          user: [
            { providerID: "opencode", modelID: "x-preview-f-free", visibility: "show" },
            { providerID: "openrouter", modelID: "stealth/ox-alpha", visibility: "show" },
            { providerID: "removed-provider", modelID: "stale-model", visibility: "show" },
            { providerID: "openrouter", modelID: "hidden-model", visibility: "hide" },
          ],
        }),
      }));
      const catalog = parseOpenCodeModelsOutput([
        "opencode/x-preview-f-free",
        "openrouter/stealth/ox-alpha",
        "removed-provider/stale-model",
        "openrouter/hidden-model",
      ].join("\n"))!;
      const filtered = filterOpenCodeDesktopModels(catalog, {
        HOME: scratch,
        USERPROFILE: scratch,
        APPDATA: appData,
        XDG_DATA_HOME: dataHome,
      });
      expect(filtered.options.map((option) => option.id)).toEqual([
        "opencode/x-preview-f-free",
        "openrouter/stealth/ox-alpha",
      ]);
      expect(filtered.default).toBe("opencode/x-preview-f-free");
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("keeps the last CLI catalog when a refresh fails", async () => {
    const env = { HOME: "C:\\Users\\test" };
    const first = await fetchOpenCodeCliModels("opencode", env, async () => "zai-coding-plan/glm-5.2\n");
    const fallback = await fetchOpenCodeCliModels("opencode", env, async () => {
      throw new Error("CLI unavailable");
    });

    expect(first?.options[0].id).toBe("zai-coding-plan/glm-5.2");
    expect(fallback?.options[0].id).toBe("zai-coding-plan/glm-5.2");
  });

  it("does not share failed CLI fallbacks across profile, CLI, config, or auth scopes", async () => {
    const base = {
      HOME: "C:\\Users\\openmaus\\home",
      USERPROFILE: "C:\\Users\\openmaus\\profile",
      XDG_DATA_HOME: "C:\\Users\\openmaus\\data",
      XDG_CONFIG_HOME: "C:\\Users\\openmaus\\config",
      APPDATA: "C:\\Users\\openmaus\\appdata",
      LOCALAPPDATA: "C:\\Users\\openmaus\\localappdata",
      OPENCODE_DESKTOP_STATE: "C:\\Users\\openmaus\\desktop.dat",
      OPENCODE_CONFIG: "C:\\Users\\openmaus\\config.json",
      OPENCODE_CONFIG_DIR: "C:\\Users\\openmaus\\config-dir",
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      OPENCODE_DISABLE_MODELS_FETCH: "0",
      OPENCODE_AUTH_CONTENT: "profile-a-auth-secret",
    };
    const dimensions = [
      ["HOME", "profile-b-home"],
      ["USERPROFILE", "profile-b-user"],
      ["XDG_DATA_HOME", "profile-b-data"],
      ["XDG_CONFIG_HOME", "profile-b-config"],
      ["APPDATA", "profile-b-appdata"],
      ["LOCALAPPDATA", "profile-b-localappdata"],
      ["OPENCODE_DESKTOP_STATE", "profile-b-desktop.dat"],
      ["OPENCODE_CONFIG", "profile-b-config.json"],
      ["OPENCODE_CONFIG_DIR", "profile-b-config-dir"],
      ["OPENCODE_DISABLE_PROJECT_CONFIG", "1"],
      ["OPENCODE_DISABLE_MODELS_FETCH", "1"],
      ["OPENCODE_AUTH_CONTENT", "profile-b-auth-secret"],
    ] as const;
    for (const [dimension, value] of dimensions) {
      resetOpenCodeGoModelCache();
      await fetchOpenCodeCliModels("opencode-a", base, async () => "profile-a/model\n");
      const changed = { ...base, [dimension]: value };
      const fallback = await fetchOpenCodeCliModels("opencode-a", changed, async () => {
        throw new Error("refresh failed");
      });
      expect(fallback).toBeNull();
      expect(JSON.stringify(fallback)).not.toContain("profile-a-auth-secret");
    }

    resetOpenCodeGoModelCache();
    await fetchOpenCodeCliModels("opencode-a", base, async () => "profile-a/model\n");
    const otherCli = await fetchOpenCodeCliModels("opencode-b", base, async () => {
      throw new Error("refresh failed");
    });
    expect(otherCli).toBeNull();
  });

  it("separates same-home CLI fallbacks by config-content digest without retaining raw content", async () => {
    const configA = JSON.stringify({ provider: { profile: "a" } });
    const configB = JSON.stringify({ provider: { profile: "b" } });
    const base = {
      HOME: "C:\\Users\\openmaus\\same-home",
      USERPROFILE: "C:\\Users\\openmaus\\same-home",
      OPENCODE_CONFIG_CONTENT: configA,
    };

    const first = await fetchOpenCodeCliModels("opencode", base, async () => "profile-a/model\n");
    const fallbackForDifferentContent = await fetchOpenCodeCliModels(
      "opencode",
      { ...base, OPENCODE_CONFIG_CONTENT: configB },
      async () => {
        throw new Error("refresh failed");
      },
    );
    const fallbackForSameContent = await fetchOpenCodeCliModels("opencode", base, async () => {
      throw new Error("refresh failed");
    });

    const keyA = openCodeCliScopeKey("opencode", base);
    const keyB = openCodeCliScopeKey("opencode", { ...base, OPENCODE_CONFIG_CONTENT: configB });

    expect(first?.options[0].id).toBe("profile-a/model");
    expect(fallbackForDifferentContent).toBeNull();
    expect(fallbackForSameContent?.options[0].id).toBe("profile-a/model");
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain(createHash("sha256").update(configA, "utf8").digest("hex"));
    expect(keyB).toContain(createHash("sha256").update(configB, "utf8").digest("hex"));
    expect(keyA).not.toContain(configA);
    expect(keyA).not.toContain(configB);
    expect(keyB).not.toContain(configA);
    expect(keyB).not.toContain(configB);
  });

  it("evicts the oldest of sixteen CLI scopes deterministically and reset clears all scopes", async () => {
    const envFor = (index: number) => ({
      HOME: `C:\\Users\\openmaus\\scope-${index}`,
      USERPROFILE: `C:\\Users\\openmaus\\scope-${index}`,
    });
    for (let index = 0; index <= OPENCODE_CLI_CACHE_MAX_SCOPES; index++) {
      await fetchOpenCodeCliModels("opencode", envFor(index), async () => `scope-${index}/model\n`);
    }
    const evicted = await fetchOpenCodeCliModels("opencode", envFor(0), async () => {
      throw new Error("evicted");
    });
    const retained = await fetchOpenCodeCliModels("opencode", envFor(1), async () => {
      throw new Error("retained");
    });
    expect(evicted).toBeNull();
    expect(retained?.options[0].id).toBe("scope-1/model");

    resetOpenCodeGoModelCache();
    const afterReset = await fetchOpenCodeCliModels("opencode", envFor(1), async () => {
      throw new Error("reset");
    });
    expect(afterReset).toBeNull();
  });

  it("uses a child-local overlay for local injected models without touching user config", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-opencode-local-overlay-"));
    try {
      const path = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(path), { recursive: true });
      const original = '{"provider":{"legacy":{"options":{"baseURL":"https://legacy.example"}}}}\n';
      writeFileSync(path, original);
      const env: Record<string, string | undefined> = {
        HOME: home,
        USERPROFILE: home,
        UNSLOTH_STUDIO_AUTH_TOKEN: "local-secret",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "child" }),
      };
      const native = ensureOpenCodeInjectModel("unsloth::local-model", env);
      expect(native).toBe("unsloth/local-model");
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(existsSync(path)).toBe(true);
      const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
      expect(overlay.theme).toBe("child");
      expect(overlay.provider.unsloth.options).toMatchObject({
        baseURL: "http://127.0.0.1:8888/v1",
        apiKey: "{env:OPENMAUSBOT_LOCAL_UNSLOTH_API_KEY}",
      });
      expect(overlay.provider.unsloth.models["local-model"]).toBeDefined();
      expect(env.OPENMAUSBOT_LOCAL_UNSLOTH_API_KEY).toBe("local-secret");
      expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("local-secret");

      const malformed: Record<string, string | undefined> = { OPENCODE_CONFIG_CONTENT: "[] local-secret" };
      let errorMessage = "";
      try {
        ensureOpenCodeInjectModel("unsloth::local-model", malformed);
      } catch (error) {
        errorMessage = String(error);
      }
      expect(errorMessage).toContain("OpenCode config content must be a JSON object");
      expect(errorMessage).not.toContain("local-secret");
    } finally {
      await removeTempDir(home);
    }
  });

  it("bounds the fixed public catalog including static defaults", async () => {
    const records = Array.from({ length: 5_000 }, (_, index) => ({ id: `model-${index}` }));
    records.splice(2, 0, { id: "model-0" });
    const catalog = await fetchOpenCodeGoModels(async () =>
      new Response(JSON.stringify({ data: records }), { status: 200 }),
    );
    expect(catalog.options).toHaveLength(OPENCODE_PUBLIC_CATALOG_MAX_OPTIONS);
    expect(catalog.options.slice(0, 3).map((option) => option.id)).toEqual([
      "opencode-go/minimax-m3",
      "opencode-go/kimi-k3",
      "opencode-go/glm-5.2",
    ]);
    expect(catalog.options[3].id).toBe("opencode-go/model-0");
    expect(new Set(catalog.options.map((option) => option.id)).size).toBe(catalog.options.length);
  });

  it("rejects an oversized public catalog body after streamed bytes exceed the cap", async () => {
    const catalog = await fetchOpenCodeGoModels(async () =>
      new Response(new Uint8Array(CUSTOM_ENDPOINT_MAX_BODY_BYTES + 1), {
        status: 200,
        headers: { "content-length": "1" },
      }),
    );
    expect(catalog.options.some((option) => option.id === "opencode-go/late-model")).toBe(false);
    expect(catalog.options.map((option) => option.id)).toEqual([
      "opencode-go/minimax-m3",
      "opencode-go/kimi-k3",
      "opencode-go/glm-5.2",
    ]);
  });

  it("does not let a public catalog result arriving after the deadline poison fallback", async () => {
    vi.useFakeTimers();
    try {
      resetOpenCodeGoModelCache();
      await fetchOpenCodeGoModels(async () =>
        new Response(JSON.stringify([{ id: "before-timeout" }]), { status: 200 }),
      );
      let resolveLate!: (response: Response) => void;
      let aborted = false;
      const lateResponse = new Promise<Response>((resolve) => { resolveLate = resolve; });
      const pending = fetchOpenCodeGoModels(async (_input, init) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; });
        return lateResponse;
      });
      await vi.advanceTimersByTimeAsync(OPENCODE_PUBLIC_CATALOG_SETTLE_MS);
      const timedOut = await pending;
      expect(timedOut.options.some((option) => option.id === "opencode-go/before-timeout")).toBe(true);
      expect(aborted).toBe(true);

      resolveLate(new Response(JSON.stringify([{ id: "late-model" }]), { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();
      const fallback = await fetchOpenCodeGoModels(async () => {
        throw new Error("catalog unavailable");
      });
      expect(fallback.options.some((option) => option.id === "opencode-go/before-timeout")).toBe(true);
      expect(fallback.options.some((option) => option.id === "opencode-go/late-model")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes valid catalog records to provider-qualified model ids", async () => {
    const models = await fetchOpenCodeGoModels(async () =>
      new Response(JSON.stringify({
        data: [
          { id: "minimax-m3", object: "model" },
          { id: "bad id", object: "model" },
          { object: "model" },
        ],
      }), { status: 200 }),
    );

    expect(models.default).toBe("opencode-go/minimax-m3");
    expect(models.options.filter((option) => !option.custom).map((option) => option.id)).toEqual([
      "opencode-go/minimax-m3",
      "opencode-go/kimi-k3",
      "opencode-go/glm-5.2",
    ]);
    expect(models.options.some((option) => option.custom)).toBe(false);
  });
});

describe("OpenCode catalog", () => {
  it("parses Zen, Go, third-party, and local models using exact CLI slugs", () => {
    const models = parseOpenCodeModelsOutput([
      "openrouter/vendor/model-v2",
      JSON.stringify({ name: "Vendor Model", status: "active" }, null, 2),
      "opencode/x-preview-f-free",
      JSON.stringify({ name: "Ox Alpha Free", status: "active", limit: { context: 1_000_000 } }, null, 2),
      "opencode-go/minimax-m3",
      JSON.stringify({ name: "MiniMax M3", status: "active" }, null, 2),
      "ollama/qwen3",
      JSON.stringify({ name: "Qwen 3", api: { url: "http://127.0.0.1:11434/v1" } }, null, 2),
      "lmstudio/qwen3-ipv6",
      JSON.stringify({ name: "Qwen 3 IPv6", api: { url: "http://[::1]:1234/v1" } }, null, 2),
      "opencode/retired",
      JSON.stringify({ name: "Retired", status: "deprecated" }, null, 2),
    ].join("\n"));

    expect(models?.default).toBe("opencode/x-preview-f-free");
    expect(models?.options).toEqual([
      expect.objectContaining({ id: "openrouter/vendor/model-v2", label: "OpenRouter · Vendor Model" }),
      expect.objectContaining({
        id: "opencode/x-preview-f-free",
        label: "Zen · Ox Alpha Free",
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({ id: "opencode-go/minimax-m3", label: "Go · MiniMax M3" }),
      expect.objectContaining({ id: "ollama/qwen3", custom: true, loaded: true }),
      expect.objectContaining({ id: "lmstudio/qwen3-ipv6", custom: true, loaded: true }),
    ]);
  });

  it("caches the anonymous model probe across authentication checks", async () => {
    const runModels = vi.fn(async () => "opencode/x-preview-f-free\n");

    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);
    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);

    expect(runModels).toHaveBeenCalledOnce();
  });

  it("accepts header-only output from older CLIs and rejects malformed lines", () => {
    const models = parseOpenCodeModelsOutput([
      "Available models",
      "opencode/x-preview-f-free",
      "bad model/with space",
      "openrouter/anthropic/claude-sonnet-5",
    ].join("\n"));

    expect(models?.options.map((option) => option.id)).toEqual([
      "opencode/x-preview-f-free",
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });

  it("refreshes the same instance catalog on each explicit refresh", async () => {
    let calls = 0;
    const driver = createOpenCodeDriver(async () => {
      calls += 1;
      const id = calls === 1
        ? "opencode/x-preview-f-free"
        : calls === 2
          ? "opencode-go/extra-two"
          : "openrouter/vendor/extra-three";
      return catalog(id);
    });
    const instance = await driver.create({
      instanceId: "opencode-refresh",
      displayName: "OpenCode",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });

    // Catalog discovery is optional metadata and is refreshed explicitly so
    // provider boot remains non-blocking; the first refresh consumes the
    // injected loader's first catalog.
    await instance.refreshModels?.();
    expect(instance.models.default).toBe("opencode/x-preview-f-free");
    expect(instance.models.options.some((option) => option.custom)).toBe(false);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "opencode-go/extra-two" && !option.custom)).toBe(true);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "openrouter/vendor/extra-three" && !option.custom)).toBe(true);
    await instance.dispose();
  });

  it("refreshes the historical Go catalog through its injected fetcher", async () => {
    let calls = 0;
    const driver = createOpenCodeGoDriver(async () => {
      calls += 1;
      const id = calls === 1 ? "extra-one" : "extra-two";
      return new Response(JSON.stringify([{ id }]), { status: 200 });
    });
    const instance = await driver.create({
      instanceId: "opencode-go-refresh",
      displayName: "OpenCode Go",
      environment: { OPENCODE_API_KEY: "test-key" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(instance.models.default).toBe("opencode-go/minimax-m3");
      await instance.refreshModels?.();
      expect(instance.models.options.some((option) => option.id === "opencode-go/extra-one" && option.custom)).toBe(true);
      await instance.refreshModels?.();
      expect(instance.models.options.some((option) => option.id === "opencode-go/extra-two" && option.custom)).toBe(true);
    } finally {
      await instance.dispose();
    }
  });

  it("keeps the driver optional and declares the OpenCode CLI setup", () => {
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    expect(driver.driverKind).toBe("opencodeGo");
    expect(driver.metadata.displayName).toBe("OpenCode");
    expect(driver.decodeConfig(undefined)).toEqual({ cli: "opencode", fullAuto: false, workspace: undefined });
    expect(driver.install?.docsUrl).toContain("opencode.ai");
    expect(OPENCODE_NEW_SESSION_TIMEOUT_MS).toBe(120_000);
    expect(driver.install?.signInCommand).toBe("opencode auth login");
  });

  it("migrates the retired Ox preview id without changing current ids", () => {
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", {})).toBe(
      "opencode/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", { OPENCODE_API_KEY: "configured" })).toBe(
      "opencode-go/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode/gpt-5.6-sol", {})).toBe("opencode/gpt-5.6-sol");
  });

  it("recognizes an OpenCode Go login stored by the CLI", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-auth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("finds the CLI's login at ~/.local/share on every platform, macOS included", async () => {
    // `opencode auth list` prints ~/.local/share/opencode/auth.json on macOS —
    // the CLI is xdg-flavoured everywhere. Looking only in Library/Application
    // Support is the bug that told signed-in users to sign in. No XDG override
    // here on purpose: this is the exact real-world shape.
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-home-"));
    const authDir = join(scratch, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-home-auth",
      displayName: "OpenCode",
      environment: { HOME: scratch, USERPROFILE: scratch, XDG_DATA_HOME: "", OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("recognizes an existing OpenCode Zen login", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-oauth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "acc-token", refresh: "ref-token" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-oauth-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("treats OpenCode's anonymous free catalog as runnable without a saved key", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-free-"));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-free",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("runs a Zen model through ACP using the exact discovered id", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-zen-only-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "api", key: "zen-only-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-zen-only",
      displayName: "OpenCode",
      environment: {
        XDG_DATA_HOME: scratch,
        OPENCODE_API_KEY: "",
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-zen-only",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "session.started", model: "opencode/x-preview-f-free" }),
      ]));
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("classifies ACP's standard authentication error", () => {
    expect(classifyOpenCodeError({ code: -32000 })).toBe("invalid_credentials");
  });

  it("keeps the OpenCode key in the child environment only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-go-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
      const instance = await driver.create({
        instanceId: "opencode-go",
        displayName: "OpenCode",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          OPENAI_API_KEY: "wrong-provider-secret",
          ANTHROPIC_API_KEY: "wrong-provider-secret",
          FAKE_ACP_DUMP: dump,
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      await instance.snapshot();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_API_KEY).toBe("secret-value");
      expect(child.env.OPENAI_API_KEY).toBeUndefined();
      expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("accepts credentials for a provider connected from OpenCode Desktop", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-provider-auth-"));
    const authDir = join(scratch, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "zai-coding-plan": { type: "api", key: "stored-provider-secret" },
    }));
    const driver = createOpenCodeGoDriver(async () => new Response("[]", { status: 200 }));
    const instance = await driver.create({
      instanceId: "opencode-desktop-provider-auth",
      displayName: "OpenCode",
      environment: { HOME: scratch, USERPROFILE: scratch, XDG_DATA_HOME: "", OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("routes a custom endpoint model through a child overlay without touching user config", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-endpoint-"));
    try {
      const dump = join(scratch, "endpoint-env.json");
      const driver = createOpenCodeGoDriver(async () => new Response("[]", { status: 200 }));
      const instance = await driver.create({
        instanceId: "opencode-custom-endpoint",
        displayName: "OpenCode custom endpoint",
        environment: {
          HOME: scratch,
          USERPROFILE: scratch,
          OPENMAUSBOT_ENDPOINT_OPENROUTER_API_KEY: "endpoint-secret",
          FAKE_ACP_DUMP: dump,
          FAKE_ACP_MODELS: "openrouter/z-ai/glm-5.2",
        },
        enabled: true,
        config: {
          cli: FAKE_CLI,
          fullAuto: false,
          customEndpoints: [{
            id: "openrouter",
            name: "OpenRouter",
            providerId: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            defaultModel: "z-ai/glm-5.2",
            discoverModels: false,
          }],
        },
      });
      await instance.refreshModels?.();
      expect(instance.models.options.some((option) => option.id === "endpoint::openrouter::z-ai%2Fglm-5.2")).toBe(true);
      const completed = new Promise<void>((resolve) => {
        const off = instance.adapter.onEvent((event) => {
          if (event.type !== "turn.completed") return;
          off();
          resolve();
        });
      });
      await instance.adapter.sendTurn({
        threadId: "custom-endpoint-thread",
        text: "hello",
        model: "endpoint::openrouter::z-ai%2Fglm-5.2",
      });
      await completed;
      await instance.dispose();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENMAUSBOT_ENDPOINT_OPENROUTER_API_KEY).toBe("endpoint-secret");
      expect(existsSync(join(scratch, ".config", "opencode", "opencode.json"))).toBe(false);
    } finally {
      await removeTempDir(scratch);
    }
  });
});
