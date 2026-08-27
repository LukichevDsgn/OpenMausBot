import { describe, expect, it } from "vitest";

import {
  migrateWorkspaceCredentials,
  runWorkspaceCredentialMutation,
  workspaceCredentialEnv,
  WORKSPACE_CREDENTIALS,
} from "./workspace-credentials.mjs";

describe("workspace credential migration", () => {
  it("moves every plaintext secret into the store and deletes the field", () => {
    const config = {
      xai: { key: "xai-secret", url: "https://api.example.test/v1" },
      box: { token: "box-secret" },
      tts: { key: "tts-secret", voice: "narrator" },
      imageGen: { key: "image-secret" },
      opencodeGo: { apiKey: "ocg-secret" },
      profile: { name: "Ada" },
    };
    const result = migrateWorkspaceCredentials(config, {});
    expect(result.configChanged).toBe(true);
    expect(result.credentialsChanged).toBe(true);
    expect(result.credentials).toEqual({
      xaiApiKey: "xai-secret",
      boxToken: "box-secret",
      ttsKey: "tts-secret",
      opencodeGoApiKey: "ocg-secret",
      openaiImageApiKey: "image-secret",
    });
    // secrets are DELETED (not blanked) so "" stays meaningful as "cleared";
    // non-secret siblings (endpoint url, chosen voice) stay in the file
    expect(result.config).toEqual({
      xai: { url: "https://api.example.test/v1" },
      box: {},
      tts: { voice: "narrator" },
      imageGen: {},
      opencodeGo: {},
      profile: { name: "Ada" },
    });
    // inputs are never mutated — main.mjs decides which files to rewrite
    expect(config.xai.key).toBe("xai-secret");
  });

  it("is idempotent: a second boot over migrated output changes nothing", () => {
    const first = migrateWorkspaceCredentials(
      { xai: { key: "xai-secret" }, tts: { key: "tts-secret", voice: "narrator" } },
      {},
    );
    const second = migrateWorkspaceCredentials(first.config, first.credentials);
    expect(second.configChanged).toBe(false);
    expect(second.credentialsChanged).toBe(false);
    expect(second.credentials).toEqual(first.credentials);
    expect(second.config).toEqual(first.config);
  });

  it("treats a saved non-empty value as newest intent and overwrites the store", () => {
    // mid-session key change: the server persisted the new key to config.json;
    // the stale stored secret must not win at the next boot
    const result = migrateWorkspaceCredentials(
      { box: { token: "box-NEW" } },
      { boxToken: "box-OLD", xaiApiKey: "xai-keep" },
    );
    expect(result.credentials).toEqual({ boxToken: "box-NEW", xaiApiKey: "xai-keep" });
    expect(result.config.box).toEqual({});
  });

  it("treats an empty saved value as no information and keeps the stored secret", () => {
    // The packaged app tombstones every external-mode save as "" in
    // config.json while the real key goes to credentials.bin — a boot that
    // read "" as "cleared" would delete freshly saved keys on every restart.
    const result = migrateWorkspaceCredentials(
      { xai: { key: "" }, tts: { key: "   " } },
      { xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" },
    );
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual({ xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" });
    // the swept field itself is still removed from the file
    expect(result.config).toEqual({ xai: {}, tts: {} });
    expect(result.configChanged).toBe(true);
  });

  it("keeps the packaged save → restart cycle lossless end to end", () => {
    // first boot migrates the plaintext key in and sweeps the field
    const boot = migrateWorkspaceCredentials({ opencodeGo: { apiKey: "ocg-secret" } }, {});
    expect(boot.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });

    // an external-mode save commits the key to the store and leaves a ""
    // tombstone in config.json; the next boot must not read it as a clear
    const afterTombstone = migrateWorkspaceCredentials(
      { opencodeGo: { apiKey: "" }, profile: { name: "Ada" } },
      { opencodeGoApiKey: "ocg-secret" },
    );
    expect(afterTombstone.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });
    expect(afterTombstone.credentialsChanged).toBe(false);
  });

  it("keeps stored secrets when the field is absent (already migrated)", () => {
    const stored = { xaiApiKey: "xai-keep", boxToken: "box-keep" };
    const result = migrateWorkspaceCredentials({ profile: { name: "Ada" } }, stored);
    expect(result.configChanged).toBe(false);
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual(stored);
  });

  it("leaves non-string junk for the server's schema instead of destroying it", () => {
    const result = migrateWorkspaceCredentials({ xai: { key: 42 }, box: "not-an-object" }, {});
    expect(result.configChanged).toBe(false);
    expect(result.credentialsChanged).toBe(false);
    expect(result.config.xai.key).toBe(42);
  });

  it("moves custom endpoint keys into the dynamic encrypted credential bucket", () => {
    const result = migrateWorkspaceCredentials({
      customEndpoints: {
        openrouter: { id: "openrouter", name: "OpenRouter", apiKey: "or-secret" },
        nvidia: { id: "nvidia", name: "NVIDIA", apiKey: "" },
      },
    }, { customEndpointKeys: { nvidia: "old-secret" } });
    expect(result.credentials).toEqual({ customEndpointKeys: { openrouter: "or-secret" } });
    expect(result.config.customEndpoints.openrouter.apiKey).toBeUndefined();
    expect(result.config.customEndpoints.nvidia.apiKey).toBeUndefined();
  });
});

describe("workspace credential env", () => {
  it("maps each stored secret to exactly its server env var", () => {
    expect(
      workspaceCredentialEnv({
        xaiApiKey: "xai-secret",
        boxToken: "box-secret",
        ttsKey: "tts-secret",
        opencodeGoApiKey: "ocg-secret",
        openaiImageApiKey: "image-secret",
        composioApiKey: "ak_handled-separately",
      }),
    ).toEqual({
      XAI_API_KEY: "xai-secret",
      BOX_TOKEN: "box-secret",
      OMB_TTS_KEY: "tts-secret",
      OPENCODE_API_KEY: "ocg-secret",
      OMB_OPENAI_IMAGE_KEY: "image-secret",
    });
  });

  it("emits nothing for absent or empty secrets", () => {
    expect(workspaceCredentialEnv({})).toEqual({});
    expect(workspaceCredentialEnv({ xaiApiKey: "" })).toEqual({});
    expect(workspaceCredentialEnv(undefined)).toEqual({});
  });

  it("maps dynamic endpoint secrets to isolated env names", () => {
    expect(workspaceCredentialEnv({ customEndpointKeys: { openrouter: "or-secret", nvidia: "nv-secret" } })).toEqual({
      OPENMAUSBOT_ENDPOINT_OPENROUTER_API_KEY: "or-secret",
      OPENMAUSBOT_ENDPOINT_NVIDIA_API_KEY: "nv-secret",
    });
  });

  it("covers every credential the migration table declares", () => {
    const credentials = Object.fromEntries(WORKSPACE_CREDENTIALS.map((c) => [c.name, `v-${c.name}`]));
    const env = workspaceCredentialEnv(credentials);
    expect(Object.keys(env).sort()).toEqual(WORKSPACE_CREDENTIALS.map((c) => c.env).sort());
  });
});

describe("workspace credential mutation transaction", () => {
  const previous = { xaiApiKey: "old-secret" };
  const next = { xaiApiKey: "new-secret" };

  async function run(responseOrError, { failRollback = false } = {}) {
    let memory = structuredClone(previous);
    const writes = [];
    let requests = 0;
    const error = responseOrError instanceof Error ? responseOrError : null;
    try {
      const result = await runWorkspaceCredentialMutation({
        previousCredentials: previous,
        nextCredentials: next,
        writeCredentials: async (credentials) => {
          writes.push(structuredClone(credentials));
          if (failRollback && writes.length === 2) throw new Error("rollback store failure");
        },
        setCredentials: (credentials) => { memory = structuredClone(credentials); },
        request: async () => {
          requests += 1;
          if (error) throw error;
          return typeof responseOrError === "function" ? responseOrError(requests) : responseOrError;
        },
      });
      return { result, error: undefined, memory, writes, requests };
    } catch (caught) {
      return { result: undefined, error: caught, memory, writes, requests };
    }
  }

  it("stores next first and keeps it after a successful server commit", async () => {
    const { result, memory, writes } = await run({ ok: true, status: 200, body: { saved: true } });
    expect(result.response.body).toEqual({ saved: true });
    expect(writes).toEqual([next]);
    expect(memory).toEqual(next);
  });

  it("rolls the encrypted store and memory back for an explicit server rejection", async () => {
    const secret = "reflected-secret-that-must-not-escape";
    const first = await run({ ok: false, status: 400, body: { error: secret, outcome: "rolled_back" } });
    const thrown = first.error;
    expect(thrown?.outcome).toBe("rolled_back");
    expect(String(thrown)).not.toContain(secret);
    expect(first.writes).toEqual([next, previous]);
    expect(first.memory).toEqual(previous);
  });

  it("retries the same operation once after transport loss and commits on success", async () => {
    const { result, requests, writes, memory } = await run((attempt) => {
      if (attempt === 1) throw new Error("temporary transport loss");
      return { ok: true, status: 200, body: { retried: true } };
    });
    expect(requests).toBe(2);
    expect(result.response.body).toEqual({ retried: true });
    expect(writes).toEqual([next]);
    expect(memory).toEqual(next);
  });

  it.each([
    { label: "double transport", response: new Error("transport leaked secret") },
    { label: "ambiguous 500", response: { ok: false, status: 500, body: { error: "server leaked secret" } } },
    { label: "unknown outcome", response: { ok: false, status: 200, outcome: "unknown", body: { error: "server leaked secret" } } },
  ])("keeps next store and memory for $label", async ({ response }) => {
    const first = await run(response);
    const thrown = first.error;
    expect(thrown?.outcome).toBe("unknown");
    expect(String(thrown)).not.toContain("secret");
    expect(first.writes).toEqual([next]);
    expect(first.memory).toEqual(next);
  });

  it("retains newest state and both internal causes when rollback storage fails", async () => {
    const first = await run({ ok: false, status: 409, body: { outcome: "rolled_back", error: "secret" } }, { failRollback: true });
    const thrown = first.error;
    expect(thrown?.outcome).toBe("unknown");
    expect(thrown?.originalCause).toBeInstanceOf(Error);
    expect(thrown?.rollbackCause).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain("secret");
    expect(first.writes).toEqual([next, previous]);
    expect(first.memory).toEqual(next);
  });
});
