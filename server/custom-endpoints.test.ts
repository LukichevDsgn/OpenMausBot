import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CUSTOM_ENDPOINT_DISCOVERY_SETTLE_MS,
  CUSTOM_ENDPOINT_MAX_BODY_BYTES,
  CUSTOM_ENDPOINT_MAX_OPTIONS_PER_ENDPOINT,
  CUSTOM_ENDPOINT_MAX_OPTIONS_TOTAL,
  customEndpointKeyEnv,
  customEndpointModelId,
  decodeCustomEndpointModelId,
  endpointModelsUrl,
  ensureOpenCodeCustomEndpointModel,
  fetchCustomEndpointModels,
  isSafeCustomEndpointBaseUrl,
  parseCustomEndpoint,
  publicCustomEndpoint,
  sanitizeCustomEndpointBaseUrl,
  testCustomEndpoint,
} from "./custom-endpoints.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const endpoint = parseCustomEndpoint({
  id: "openrouter",
  name: "OpenRouter",
  providerId: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1/",
  defaultModel: "z-ai/glm-5.2",
  context: 1_000_000,
  discoverModels: true,
  apiKey: "secret-value",
});

function makeEndpoint(id: string, overrides: Partial<typeof endpoint> = {}) {
  return parseCustomEndpoint({
    id,
    name: id,
    providerId: id,
    baseUrl: `https://example.test/${id}/v1`,
    defaultModel: `saved-${id}`,
    discoverModels: true,
    apiKey: `key-${id}`,
    ...overrides,
  });
}

describe("custom OpenAI-compatible endpoints", () => {
  it("encodes and decodes provider/model picker ids without losing slashes", () => {
    const id = customEndpointModelId("openrouter", "z-ai/glm-5.2");
    expect(id).toBe("endpoint::openrouter::z-ai%2Fglm-5.2");
    expect(decodeCustomEndpointModelId(id)).toEqual({ endpointId: "openrouter", modelId: "z-ai/glm-5.2" });
  });

  it.each([
    "https://user:password@example.test/api",
    "https://example.test/api?token=secret",
    "https://example.test/api#fragment",
    "https://example.test/api?",
    "https://example.test/api#",
  ])("rejects unsafe new endpoint base URL %s without echoing it", (baseUrl) => {
    expect(() => parseCustomEndpoint({ ...endpoint, baseUrl })).toThrow();
    try {
      parseCustomEndpoint({ ...endpoint, baseUrl });
    } catch (error) {
      expect(String(error)).not.toContain(baseUrl);
    }
  });

  it("keeps percent-encoded delimiters in a safe pathname and normalizes only its trailing slash", () => {
    const parsed = parseCustomEndpoint({
      ...endpoint,
      baseUrl: "  https://example.test/api%3Ftoken%23fragment/  ",
    });
    expect(parsed.baseUrl).toBe("https://example.test/api%3Ftoken%23fragment");
    expect(isSafeCustomEndpointBaseUrl(parsed.baseUrl)).toBe(true);
    expect(sanitizeCustomEndpointBaseUrl(parsed.baseUrl)).toBe(parsed.baseUrl);
  });

  it("sanitizes forged legacy URLs for public, probe, and child overlay paths", async () => {
    const unsafeBaseUrl = "https://legacy-user:legacy-pass@example.test/api?token=legacy-secret#fragment";
    const forged = { ...endpoint, baseUrl: unsafeBaseUrl } as typeof endpoint;
    const publicEndpoint = publicCustomEndpoint(forged, { [customEndpointKeyEnv("openrouter")]: "endpoint-secret" });
    expect(publicEndpoint.baseUrl).toBe("https://example.test/api");
    expect(JSON.stringify(publicEndpoint)).not.toContain("legacy-user");
    expect(JSON.stringify(publicEndpoint)).not.toContain("legacy-secret");
    expect(endpointModelsUrl(forged)).toBe("https://example.test/api/models");

    const requestedUrls: string[] = [];
    const probe = await testCustomEndpoint(forged, "probe-secret", async (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: forged.defaultModel }] }), { status: 200 });
    });
    expect(requestedUrls).toEqual(["https://example.test/api/models"]);
    expect(probe).toEqual({ ok: true, status: 200, models: 1, includesDefault: true });
    expect(JSON.stringify(probe)).not.toContain("legacy-secret");

    const env: Record<string, string | undefined> = {};
    const native = ensureOpenCodeCustomEndpointModel(
      "endpoint::openrouter::z-ai%2Fglm-5.2",
      [forged],
      env,
    );
    const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(native).toBe("openrouter/z-ai/glm-5.2");
    expect(overlay.provider.openrouter.options.baseURL).toBe("https://example.test/api");
    expect(JSON.stringify(overlay)).not.toContain("legacy-user");
    expect(JSON.stringify(overlay)).not.toContain("legacy-secret");
  });

  it("discovers models with the endpoint key and keeps the default bounded", async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const catalog = await fetchCustomEndpointModels(
      [{ ...endpoint, apiKey: undefined }],
      { [customEndpointKeyEnv("openrouter")]: "secret-value" },
      async (input, init) => {
        calls.push({ url: String(input), authorization: String((init?.headers as Record<string, string>).authorization) });
        return new Response(JSON.stringify({ data: [{ id: "z-ai/glm-5.2" }, { id: "qwen/qwen3-coder" }] }), { status: 200 });
      },
    );
    expect(calls).toEqual([{ url: "https://openrouter.ai/api/v1/models", authorization: "Bearer secret-value" }]);
    expect(catalog.options.map((option) => option.id)).toEqual([
      "endpoint::openrouter::z-ai%2Fglm-5.2",
      "endpoint::openrouter::qwen%2Fqwen3-coder",
    ]);
    expect(publicCustomEndpoint({ ...endpoint, apiKey: undefined }, { [customEndpointKeyEnv("openrouter")]: "secret-value" }).configured).toBe(true);
  });

  it("uses a child-local overlay and leaves user OpenCode config byte-identical", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-custom-endpoint-"));
    try {
      const path = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(join(home, ".config", "opencode"), { recursive: true });
      const original = JSON.stringify({
        theme: "legacy",
        provider: { legacy: { options: { baseURL: "https://legacy.example" } } },
      }, null, 2) + "\n";
      writeFileSync(path, original);
      const env = {
        HOME: home,
        USERPROFILE: home,
        [customEndpointKeyEnv("openrouter")]: "secret-value",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          theme: "child",
          provider: { unrelated: { models: { keep: { name: "Keep" } } } },
        }),
      };
      const native = ensureOpenCodeCustomEndpointModel(
        "endpoint::openrouter::z-ai%2Fglm-5.2",
        [{ ...endpoint, apiKey: undefined }],
        env,
      );
      expect(native).toBe("openrouter/z-ai/glm-5.2");
      expect(readFileSync(path, "utf8")).toBe(original);
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
      expect(config.theme).toBe("child");
      expect(config.provider.unrelated.models.keep.name).toBe("Keep");
      expect(config.provider.openrouter.options).toMatchObject({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "{env:OPENMAUSBOT_ENDPOINT_OPENROUTER_API_KEY}",
      });
      expect(config.provider.openrouter.models["z-ai/glm-5.2"].limit).toEqual({ context: 1_000_000 });
      expect(env[customEndpointKeyEnv("openrouter")]).toBe("secret-value");
      expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("secret-value");

      const freshHome = mkdtempSync(join(tmpdir(), "omb-custom-endpoint-empty-"));
      try {
        const freshPath = join(freshHome, ".config", "opencode", "opencode.json");
        const freshEnv = { HOME: freshHome, USERPROFILE: freshHome };
        ensureOpenCodeCustomEndpointModel(
          "endpoint::openrouter::z-ai%2Fglm-5.2",
          [{ ...endpoint, apiKey: undefined }],
          freshEnv,
        );
        expect(existsSync(freshPath)).toBe(false);
      } finally {
        await removeTempDir(freshHome);
      }
    } finally {
      await removeTempDir(home);
    }
  });

  it("fails closed on malformed or non-object child config content without echoing it", () => {
    for (const raw of ["not-json secret-value", "null", "[]"]) {
      const env = { OPENCODE_CONFIG_CONTENT: raw };
      expect(() => ensureOpenCodeCustomEndpointModel(
        "endpoint::openrouter::z-ai%2Fglm-5.2",
        [{ ...endpoint, apiKey: undefined }],
        env,
      )).toThrow("OpenCode config content must be a JSON object");
      expect(env.OPENCODE_CONFIG_CONTENT).toBe(raw);
    }
  });

  it("keeps concurrent child overlays independent", async () => {
    const envA: Record<string, string | undefined> = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { keepA: {} } }) };
    const envB: Record<string, string | undefined> = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { keepB: {} } }) };
    await Promise.all([
      Promise.resolve(ensureOpenCodeCustomEndpointModel(
        "endpoint::openrouter::z-ai%2Fglm-5.2",
        [{ ...endpoint, apiKey: "secret-a" }],
        envA,
      )),
      Promise.resolve(ensureOpenCodeCustomEndpointModel(
        "endpoint::openrouter::qwen%2Fqwen3-coder",
        [{ ...endpoint, apiKey: "secret-b", defaultModel: "qwen/qwen3-coder" }],
        envB,
      )),
    ]);
    const overlayA = JSON.parse(envA.OPENCODE_CONFIG_CONTENT!);
    const overlayB = JSON.parse(envB.OPENCODE_CONFIG_CONTENT!);
    expect(overlayA.provider.keepA).toBeDefined();
    expect(overlayA.provider.openrouter.models["z-ai/glm-5.2"]).toBeDefined();
    expect(overlayA.provider.openrouter.models["qwen/qwen3-coder"]).toBeUndefined();
    expect(overlayB.provider.keepB).toBeDefined();
    expect(overlayB.provider.openrouter.models["qwen/qwen3-coder"]).toBeDefined();
    expect(overlayB.provider.openrouter.models["z-ai/glm-5.2"]).toBeUndefined();
    expect(envA.OPENCODE_CONFIG_CONTENT).not.toContain("secret-a");
    expect(envA.OPENCODE_CONFIG_CONTENT).not.toContain("secret-b");
    expect(envB.OPENCODE_CONFIG_CONTENT).not.toContain("secret-a");
    expect(envB.OPENCODE_CONFIG_CONTENT).not.toContain("secret-b");
    expect(envA[customEndpointKeyEnv("openrouter")]).toBe("secret-a");
    expect(envB[customEndpointKeyEnv("openrouter")]).toBe("secret-b");
  });

  it("reports an upstream HTTP failure without sending a chat request", async () => {
    const result = await testCustomEndpoint(endpoint, "secret-value", async (input) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/models");
      return new Response(JSON.stringify({ error: { message: "model unavailable secret-value https://unsafe.example" } }), { status: 410 });
    });
    expect(result).toEqual({ ok: false, status: 410, message: "Custom endpoint returned HTTP 410" });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("unsafe.example");
  });

  it("rejects actual streamed bodies over 8 MiB even with a false or absent length", async () => {
    for (const headers of [{ "content-length": "1" }, {}]) {
      const result = await testCustomEndpoint(endpoint, "secret-value", async () =>
        new Response(new Uint8Array(CUSTOM_ENDPOINT_MAX_BODY_BYTES + 1), { status: 200, headers }),
      );
      expect(result).toEqual({ ok: false, message: "Custom endpoint response exceeded 8 MiB" });
    }
  });

  it("bounds one endpoint and the total custom catalog deterministically", async () => {
    const capped = makeEndpoint("capped", { defaultModel: "saved-default" });
    const catalog = await fetchCustomEndpointModels(
      [capped],
      {},
      async () => new Response(JSON.stringify({ data: Array.from({ length: 5_000 }, (_, index) => ({ id: `model-${index}` })) }), { status: 200 }),
    );
    expect(catalog.options).toHaveLength(CUSTOM_ENDPOINT_MAX_OPTIONS_PER_ENDPOINT);
    expect(catalog.options[0].id).toBe(customEndpointModelId("capped", "saved-default"));

    const endpoints = ["one", "two", "three"].map((id) => makeEndpoint(id));
    const total = await fetchCustomEndpointModels(endpoints, {}, async (input) => {
      const id = String(input).split("/")[3];
      return new Response(JSON.stringify({ data: Array.from({ length: 2_048 }, (_, index) => ({ id: `${id}-model-${index}` })) }), { status: 200 });
    });
    expect(total.options).toHaveLength(CUSTOM_ENDPOINT_MAX_OPTIONS_TOTAL);
    expect(total.options.every((option) => option.id.includes("endpoint::one::") || option.id.includes("endpoint::two::"))).toBe(true);
  });

  it("runs only eight live discoveries and keeps later saved defaults", async () => {
    const endpoints = Array.from({ length: 10 }, (_, index) => makeEndpoint(`slot-${index}`));
    let calls = 0;
    const catalog = await fetchCustomEndpointModels(endpoints, {}, async (input) => {
      calls += 1;
      const id = String(input).split("/")[3];
      return new Response(JSON.stringify({ data: [{ id: `live-${id}` }] }), { status: 200 });
    });
    expect(calls).toBe(8);
    for (const endpoint of endpoints.slice(0, 8)) {
      expect(catalog.options.some((option) => option.id === customEndpointModelId(endpoint.id, `live-${endpoint.id}`))).toBe(true);
    }
    for (const endpoint of endpoints.slice(8)) {
      expect(catalog.options.some((option) => option.id === customEndpointModelId(endpoint.id, endpoint.defaultModel))).toBe(true);
      expect(catalog.options.some((option) => option.id === customEndpointModelId(endpoint.id, `live-${endpoint.id}`))).toBe(false);
    }
  });

  it("merges out-of-order discovery results in endpoint order and preserves the selected default", async () => {
    const first = makeEndpoint("first");
    const second = makeEndpoint("second", { useForNewChats: true });
    let releaseFirst!: (response: Response) => void;
    let releaseSecond!: (response: Response) => void;
    let started = 0;
    let allStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => { allStarted = resolve; });
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    const secondResponse = new Promise<Response>((resolve) => { releaseSecond = resolve; });
    const pending = fetchCustomEndpointModels([first, second], {}, async (input) => {
      started += 1;
      if (started === 2) allStarted();
      return String(input).includes("/first/") ? firstResponse : secondResponse;
    });
    await startedPromise;
    releaseSecond(new Response(JSON.stringify({ data: [{ id: "second-live" }] }), { status: 200 }));
    releaseFirst(new Response(JSON.stringify({ data: [{ id: "first-live" }] }), { status: 200 }));
    const catalog = await pending;
    expect(catalog.options.map((option) => option.id)).toEqual([
      customEndpointModelId("first", first.defaultModel),
      customEndpointModelId("first", "first-live"),
      customEndpointModelId("second", second.defaultModel),
      customEndpointModelId("second", "second-live"),
    ]);
    expect(catalog.default).toBe(customEndpointModelId("second", second.defaultModel));
  });

  it("settles a fetcher that ignores AbortSignal at the independent five-second boundary", async () => {
    vi.useFakeTimers();
    try {
      const endpointForTimeout = makeEndpoint("never");
      let aborted = false;
      const pending = fetchCustomEndpointModels([endpointForTimeout], {}, async (_input, init) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; });
        return await new Promise<Response>(() => undefined);
      });
      await vi.advanceTimersByTimeAsync(CUSTOM_ENDPOINT_DISCOVERY_SETTLE_MS);
      const catalog = await pending;
      expect(aborted).toBe(true);
      expect(catalog.options.map((option) => option.id)).toEqual([
        customEndpointModelId("never", endpointForTimeout.defaultModel),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates one failed or oversized endpoint and drops reflected keys", async () => {
    const oversized = makeEndpoint("oversized");
    const healthy = makeEndpoint("healthy", { useForNewChats: true });
    const catalog = await fetchCustomEndpointModels([oversized, healthy], {}, async (input) => {
      if (String(input).includes("oversized")) {
        return new Response(new Uint8Array(CUSTOM_ENDPOINT_MAX_BODY_BYTES + 1), { status: 200, headers: { "content-length": "1" } });
      }
      return new Response(JSON.stringify({ data: [
        { id: "healthy-model" },
        { id: "contains-key-healthy" },
      ] }), { status: 200 });
    });
    expect(catalog.options.map((option) => option.id)).toEqual([
      customEndpointModelId("oversized", oversized.defaultModel),
      customEndpointModelId("healthy", healthy.defaultModel),
      customEndpointModelId("healthy", "healthy-model"),
    ]);
    expect(catalog.default).toBe(customEndpointModelId("healthy", healthy.defaultModel));
  });

  it("does not expose thrown secrets or URLs from a probe", async () => {
    const result = await testCustomEndpoint(endpoint, "secret-value", async () => {
      throw new Error("secret-value https://unsafe.example/path");
    });
    expect(result).toEqual({ ok: false, message: "Custom endpoint probe failed" });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("unsafe.example");
  });

  it("does not read an upstream error body while preserving only its status", async () => {
    const result = await testCustomEndpoint(endpoint, "secret-value", async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      get body() {
        throw new Error("upstream body must not be read");
      },
    } as unknown as Response));
    expect(result).toEqual({ ok: false, status: 401, message: "Custom endpoint returned HTTP 401" });
  });
});
