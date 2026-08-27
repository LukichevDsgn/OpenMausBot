// OpenCode Go subscription/API product through the maintained OpenCode CLI's
// ACP stdio interface. The generic protocol runtime lives in core.ts.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { execCli } from "../../procs.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import {
  applyOpenCodeConfigOverlay,
  customEndpointKeyEnv,
  ensureOpenCodeCustomEndpointModel,
  fetchCustomEndpointModels,
  readBoundedJsonResponse,
} from "../../custom-endpoints.ts";

const CATALOG_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_NEW_SESSION_TIMEOUT_MS = 120_000;
export const OPENCODE_PUBLIC_CATALOG_MAX_OPTIONS = 2_048;
export const OPENCODE_PUBLIC_CATALOG_SETTLE_MS = 8_000;
const STATIC_MODELS: ModelCatalog = {
  default: "opencode-go/minimax-m3",
  options: [
    { id: "opencode-go/minimax-m3", label: "Minimax M3" },
    { id: "opencode-go/kimi-k3", label: "Kimi K3" },
    { id: "opencode-go/glm-5.2", label: "GLM 5.2" },
  ],
};

let lastSuccessfulCatalog: ModelCatalog | null = null;
export const OPENCODE_CLI_CACHE_MAX_SCOPES = 16;
const successfulCliCatalogs = new Map<string, ModelCatalog>();

const CLI_SCOPE_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "OPENCODE_DESKTOP_STATE",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_MODELS_FETCH",
] as const;

function authContentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function openCodeCliScopeKey(cli: string, env: Record<string, string | undefined>): string {
  const identity: Record<string, string | null> = { cli };
  for (const key of CLI_SCOPE_ENV_KEYS) identity[key] = env[key] ?? null;
  identity.OPENCODE_AUTH_CONTENT = env.OPENCODE_AUTH_CONTENT === undefined
    ? null
    : authContentDigest(env.OPENCODE_AUTH_CONTENT);
  identity.OPENCODE_CONFIG_CONTENT = env.OPENCODE_CONFIG_CONTENT === undefined
    ? null
    : authContentDigest(env.OPENCODE_CONFIG_CONTENT);
  return JSON.stringify(identity);
}

function cloneCatalog(catalog: ModelCatalog): ModelCatalog {
  return { default: catalog.default, options: catalog.options.map((option) => ({ ...option })) };
}

function rememberCliCatalog(scope: string, catalog: ModelCatalog): ModelCatalog {
  successfulCliCatalogs.delete(scope);
  successfulCliCatalogs.set(scope, cloneCatalog(catalog));
  while (successfulCliCatalogs.size > OPENCODE_CLI_CACHE_MAX_SCOPES) {
    const oldest = successfulCliCatalogs.keys().next().value;
    if (typeof oldest !== "string") break;
    successfulCliCatalogs.delete(oldest);
  }
  return cloneCatalog(catalog);
}

function labelForModel(id: string): string {
  return id
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resetOpenCodeGoModelCache() {
  lastSuccessfulCatalog = null;
  successfulCliCatalogs.clear();
}

function cliModelLabel(id: string): string {
  const [provider, ...parts] = id.split("/");
  const model = (parts.length ? parts.join("/") : id)
    .split(/[-_.\/]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const providerLabel = provider === "opencode"
    ? "OpenCode Zen"
    : provider === "openrouter"
      ? "OpenRouter"
      : labelForModel(provider);
  return `${providerLabel} · ${model}`;
}

export function parseOpenCodeModelsOutput(output: string): ModelCatalog | null {
  const lines = output.split(/\r?\n/g);
  const labels = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    const id = lines[index].trim();
    // OpenCode splits a model reference at the first slash. The model portion
    // may itself contain slashes (OpenRouter uses provider/vendor/model), plus
    // aliases such as `~anthropic` and variants such as `model:free`.
    if (!/^[a-z0-9][a-z0-9._-]*\/[^\s#]+$/i.test(id)) continue;
    let label = cliModelLabel(id);
    if (lines[index + 1]?.trim() === "{") {
      const block: string[] = [];
      let depth = 0;
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const line = lines[cursor];
        block.push(line);
        depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (depth !== 0) continue;
        try {
          const record = JSON.parse(block.join("\n")) as { name?: unknown };
          if (typeof record.name === "string" && record.name.trim()) {
            const provider = id.slice(0, id.indexOf("/"));
            const providerLabel = provider === "opencode"
              ? "OpenCode Zen"
              : provider === "openrouter"
                ? "OpenRouter"
                : labelForModel(provider);
            label = `${providerLabel} · ${record.name.trim()}`;
          }
        } catch {
          // A malformed verbose record still leaves the qualified fallback label.
        }
        index = cursor;
        break;
      }
    }
    labels.set(id, label);
  }
  if (!labels.size) return null;
  const options = [...labels].map(([id, label]) => ({ id, label, custom: true }));
  return { default: options[0].id, options };
}

type OpenCodeModelsRunner = (cli: string, env: Record<string, string | undefined>) => Promise<string>;

const runOpenCodeModels: OpenCodeModelsRunner = (cli, env) => new Promise((resolve, reject) => {
  execCli(cli, ["models", "--verbose"], {
    env,
    timeout: 12_000,
    maxBuffer: 16 * 1024 * 1024,
  }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

export async function fetchOpenCodeCliModels(
  cli: string,
  env: Record<string, string | undefined>,
  runner: OpenCodeModelsRunner = runOpenCodeModels,
): Promise<ModelCatalog | null> {
  const scope = openCodeCliScopeKey(cli, env);
  try {
    const parsed = parseOpenCodeModelsOutput(await runner(cli, env));
    if (!parsed) throw new Error("OpenCode CLI returned no models");
    const catalog = filterOpenCodeDesktopModels(parsed, env);
    return rememberCliCatalog(scope, catalog);
  } catch {
    const fallback = successfulCliCatalogs.get(scope);
    return fallback ? cloneCatalog(fallback) : null;
  }
}

export async function fetchOpenCodeGoModels(fetcher: typeof fetch = fetch): Promise<ModelCatalog> {
  const controller = new AbortController();
  let timedOut = false;
  let settle: (catalog: ModelCatalog | null) => void = () => undefined;
  const deadline = new Promise<ModelCatalog | null>((resolve) => {
    settle = resolve;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    settle(null);
  }, OPENCODE_PUBLIC_CATALOG_SETTLE_MS);
  timeout.unref?.();

  const request = Promise.resolve().then(async (): Promise<ModelCatalog | null> => {
    const response = await fetcher(CATALOG_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await readBoundedJsonResponse(response);
    const records = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : [];
    const ids = records
      .map((record) => record && typeof record === "object" ? (record as { id?: unknown }).id : undefined)
      .filter((id): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(id));
    if (!ids.length || timedOut) return null;
    const options = STATIC_MODELS.options.map((option) => ({ ...option }));
    const seen = new Set(options.map((option) => option.id));
    for (const id of ids) {
      if (options.length >= OPENCODE_PUBLIC_CATALOG_MAX_OPTIONS) break;
      const full = `opencode-go/${id}`;
      if (seen.has(full)) continue;
      seen.add(full);
      options.push({ id: full, label: labelForModel(id), custom: true });
    }
    const catalog = { default: STATIC_MODELS.default, options } satisfies ModelCatalog;
    if (timedOut) return null;
    lastSuccessfulCatalog = cloneCatalog(catalog);
    return cloneCatalog(catalog);
  }).catch(() => null);

  try {
    const result = await Promise.race([request, deadline]);
    return result ?? cloneCatalog(lastSuccessfulCatalog ?? STATIC_MODELS);
  } finally {
    clearTimeout(timeout);
  }
}

const stripForeignProviderKeys = (env: Record<string, string | undefined>) => {
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
  ]) delete env[key];
};

/** Configure an openai-compatible provider in the child-local overlay. */
export function ensureOpenCodeInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const native = `${inject.host}/${inject.model}`;
  const envKey = host.codexEnvKey
    ?? `OPENMAUSBOT_LOCAL_${host.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  env[envKey] = hostApiKey(host, env);
  applyOpenCodeConfigOverlay(env, {
    provider: {
      [inject.host]: {
        npm: "@ai-sdk/openai-compatible",
        name: host.label,
        options: {
          baseURL: host.baseUrl,
          apiKey: `{env:${envKey}}`,
        },
        models: {
          [inject.model]: { name: `${inject.model} (${host.label})` },
        },
      },
    },
  });
  return native;
}

/** Every path the OpenCode CLI may keep auth.json at.
 *
 * The CLI is xdg-flavoured on EVERY platform — `opencode auth list` on macOS
 * prints `~/.local/share/opencode/auth.json`, and that is where real logins
 * land. The platform-conventional locations are kept as fallbacks in case a
 * future CLI moves there, but the xdg path must come first: checking only
 * Library/Application Support on macOS is exactly the bug that made the app
 * demand a sign-in from users who were already signed in. */
function storedAuthPaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : "",
  ].filter(Boolean);
  return [...new Set(roots)].map((root) => join(root, "opencode", "auth.json"));
}

function authEntryUsable(auth: unknown): boolean {
  if (!auth || typeof auth !== "object") return false;
  const entry = auth as { key?: unknown; access?: unknown; refresh?: unknown };
  return Boolean(entry.key || entry.access || entry.refresh);
}

/** True when an auth.json entry looks like a usable OpenCode login.
 *
 * The CLI writes `{type:"api", key}` for pasted keys and
 * `{type:"oauth", access, refresh}` for browser sign-ins — demanding `key`
 * alone rejects every OAuth login. Desktop-connected providers such as
 * `zai-coding-plan`, `tabi`, and `tabitoken` are valid too: the CLI reads
 * these same credentials when it runs `opencode models` or `opencode acp`. */
function usableAuthEntry(parsed: Record<string, unknown>): boolean {
  return Object.values(parsed).some(authEntryUsable);
}

function storedAuthProviderIds(env: Record<string, string | undefined>): Set<string> {
  const providers = new Set<string>();
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const path of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(path, "utf8"));
    } catch {
      // Missing auth storage simply contributes no connected providers.
    }
  }
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [provider, auth] of Object.entries(parsed)) {
        if (authEntryUsable(auth)) providers.add(provider);
      }
    } catch {
      // Ignore stale or partially written auth files.
    }
  }
  return providers;
}

function desktopStatePaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  return [...new Set([
    env.OPENCODE_DESKTOP_STATE,
    env.APPDATA ? join(env.APPDATA, "ai.opencode.desktop", "opencode.global.dat") : "",
    join(home, "Library", "Application Support", "ai.opencode.desktop", "opencode.global.dat"),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "ai.opencode.desktop", "opencode.global.dat"),
  ].filter((value): value is string => Boolean(value)))];
}

/** The desktop picker persists explicit show/hide choices separately from the
 * CLI's global models.dev catalog. Keep only explicitly shown models belonging
 * to providers that are still connected; stale choices from removed provider
 * accounts must not leak back into OpenMausBot. */
function desktopVisibleModelIds(env: Record<string, string | undefined>): Set<string> | null {
  const connected = storedAuthProviderIds(env);
  for (const path of desktopStatePaths(env)) {
    try {
      const outer = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown };
      const state = typeof outer.model === "string" ? JSON.parse(outer.model) : outer.model;
      const user = state && typeof state === "object" && Array.isArray((state as { user?: unknown }).user)
        ? (state as { user: unknown[] }).user
        : [];
      const shown = new Set<string>();
      for (const value of user) {
        if (!value || typeof value !== "object") continue;
        const entry = value as { providerID?: unknown; modelID?: unknown; visibility?: unknown };
        if (entry.visibility !== "show" || typeof entry.providerID !== "string" || typeof entry.modelID !== "string") continue;
        if (connected.size && !connected.has(entry.providerID)) continue;
        shown.add(`${entry.providerID}/${entry.modelID}`);
      }
      if (shown.size) return shown;
    } catch {
      // Desktop is optional; a missing/corrupt state file falls back to CLI.
    }
  }
  return null;
}

export function filterOpenCodeDesktopModels(
  catalog: ModelCatalog,
  env: Record<string, string | undefined>,
): ModelCatalog {
  const visible = desktopVisibleModelIds(env);
  if (!visible) return catalog;
  const options = catalog.options.filter((option) => visible.has(option.id));
  if (!options.length) return catalog;
  return {
    default: visible.has(catalog.default) ? catalog.default : options[0].id,
    options,
  };
}

function hasStoredOpenCodeAuth(env: Record<string, string | undefined>) {
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const path of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(path, "utf8"));
    } catch {
      // A missing or unreadable file simply means there is no ambient login.
    }
  }
  return candidates.some((raw) => {
    try {
      return usableAuthEntry(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

const support = (fetcher: typeof fetch): AcpSupport => ({
  driverKind: "opencodeGo",
  displayName: "OpenCode Go",
  models: STATIC_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode-go.acp",
  loginNote:
    "OpenCode is not signed in — run `opencode auth login` and pick OpenCode, or add an OPENCODE_API_KEY in OpenMausBot settings",
  install: {
    command: {
      darwin: "npm install -g opencode-ai",
      linux: "npm install -g opencode-ai",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
    needsNode: true,
  },
  spawnArgs: () => ["acp"],
  // OpenCode 1.17.x performs provider discovery and starts every requested
  // MCP server before answering session/new. A measured Windows cold start
  // with the normal agents + composio payload takes ~75s, so the generic 30s
  // ACP timeout aborts a healthy process before either provider is called.
  newSessionTimeoutMs: OPENCODE_NEW_SESSION_TIMEOUT_MS,
  credentialEnv: ["OPENCODE_API_KEY"],
  selectModel: { configId: "model" },
  resolveTurnModel: (model, env, config) => {
    if (!model) return model;
    const custom = ensureOpenCodeCustomEndpointModel(model, config?.customEndpoints ?? [], env);
    return custom === model ? ensureOpenCodeInjectModel(model, env) : custom;
  },
  transformEnv: (env, config, sourceEnv) => {
    stripForeignProviderKeys(env);
    for (const endpoint of config.customEndpoints ?? []) {
      const envKey = customEndpointKeyEnv(endpoint.id);
      const key = sourceEnv?.[envKey] || endpoint.apiKey;
      if (key) env[envKey] = key;
    }
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env, config) => Boolean(env.OPENCODE_API_KEY)
    || (config.customEndpoints ?? []).some((endpoint) => Boolean(env[customEndpointKeyEnv(endpoint.id)]))
    || hasStoredOpenCodeAuth(env),
  classifyError: classifyOpenCodeGoError,
  resolveModels: async (environment, config) => {
    const base = await mergeLocalInject(await fetchOpenCodeGoModels(fetcher), environment, fetcher);
    const live = await fetchOpenCodeCliModels(config.cli, environment);
    const source = live ?? base;
    const custom = await fetchCustomEndpointModels(config.customEndpoints ?? [], environment, fetcher);
    const seen = new Set(source.options.map((option) => option.id));
    return {
      default: custom.default || source.default,
      options: [
        ...source.options,
        ...custom.options.filter((option) => !seen.has(option.id)),
      ],
    };
  },
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

export function classifyOpenCodeGoError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = value.code;
  if (code === -32000) return "invalid_credentials";
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") return "invalid_credentials";
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  return undefined;
}

export function createOpenCodeGoDriver(fetcher: typeof fetch = fetch) {
  return createAcpDriver(support(fetcher));
}

export const OpenCodeGoDriver = createOpenCodeGoDriver();
