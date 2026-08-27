// OpenCode through the maintained OpenCode CLI's ACP stdio interface. The
// generic protocol runtime lives in core.ts; this adapter owns only model
// discovery, auth scoping, and child-local provider configuration.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const MODEL_PROBE_TTL_MS = 30_000;
const modelProbeCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

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

function contentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function openCodeCliScopeKey(
  cli: string,
  env: Record<string, string | undefined>,
): string {
  const identity: Record<string, string | null> = { cli };
  for (const key of CLI_SCOPE_ENV_KEYS) identity[key] = env[key] ?? null;
  identity.OPENCODE_AUTH_CONTENT = env.OPENCODE_AUTH_CONTENT === undefined
    ? null
    : contentDigest(env.OPENCODE_AUTH_CONTENT);
  identity.OPENCODE_CONFIG_CONTENT = env.OPENCODE_CONFIG_CONTENT === undefined
    ? null
    : contentDigest(env.OPENCODE_CONFIG_CONTENT);
  return JSON.stringify(identity);
}

function cloneCatalog(catalog: ModelCatalog): ModelCatalog {
  return {
    default: catalog.default,
    options: catalog.options.map((option) => ({ ...option })),
  };
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

function providerLabel(provider: string, record?: Record<string, unknown>): string {
  if (provider === "opencode") return typeof record?.providerID === "string" ? "OpenCode Zen" : "Zen";
  if (provider === "opencode-go") return "Go";
  if (provider === "openrouter") return "OpenRouter";
  return labelForModel(provider);
}

function modelLabel(id: string, record?: Record<string, unknown>): string {
  const separator = id.indexOf("/");
  const provider = id.slice(0, separator);
  const model = id.slice(separator + 1);
  const name = typeof record?.name === "string" && record.name.trim()
    ? record.name.trim()
    : model
      .split(/[-_.\/]+/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  return `${providerLabel(provider, record)} · ${name}`;
}

function validModelSlug(value: string): boolean {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1 || /\s/u.test(value)) return false;
  return [...value].every((character) => (character.codePointAt(0) ?? 0) > 0x1f)
    && !value.includes("#");
}

function localModelRecord(record: Record<string, unknown>): boolean {
  const api = record.api && typeof record.api === "object" && !Array.isArray(record.api)
    ? record.api as Record<string, unknown>
    : {};
  if (typeof api.url !== "string") return false;
  try {
    const host = new URL(api.url).hostname.replace(/^\[|\]$/gu, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function resetOpenCodeGoModelCache() {
  lastSuccessfulCatalog = null;
  successfulCliCatalogs.clear();
  modelProbeCache.clear();
}

/** Parse `opencode models --verbose`, while accepting older header-only output. */
export function parseOpenCodeModelsOutput(output: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let pendingId: string | null = null;
  let jsonLines: string[] = [];

  const flush = () => {
    if (!pendingId || seen.has(pendingId)) return;
    const raw = jsonLines.join("\n").trim();
    let record: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        // Header-only/partially written CLI output still has a useful id.
      }
    }
    if (record.status === "deprecated") return;
    seen.add(pendingId);
    const limit = record.limit && typeof record.limit === "object" && !Array.isArray(record.limit)
      ? record.limit as Record<string, unknown>
      : {};
    const contextWindow = typeof limit.context === "number"
      && Number.isFinite(limit.context)
      && limit.context > 0
      ? Math.floor(limit.context)
      : undefined;
    options.push({
      id: pendingId,
      label: modelLabel(pendingId, record),
      custom: true,
      ...(localModelRecord(record) ? { loaded: true } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  };

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (line === trimmed && validModelSlug(trimmed)) {
      flush();
      pendingId = trimmed;
      jsonLines = [];
      continue;
    }
    if (pendingId) jsonLines.push(line);
  }
  flush();

  if (!options.length) return null;
  const preferred = options.find((option) => option.id === "opencode/x-preview-f-free")
    ?? options.find((option) => option.id === STATIC_MODELS.default);
  return { default: (preferred ?? options[0]!).id, options };
}

export type OpenCodeModelsRunner = (
  cli: string,
  env: Record<string, string | undefined>,
  verbose?: boolean,
) => Promise<string>;

const runOpenCodeModels: OpenCodeModelsRunner = (cli, env, verbose = true) => new Promise((resolve, reject) => {
  execCli(cli, ["models", ...(verbose ? ["--verbose"] : [])], {
    env,
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr?.trim() || error.message, { cause: error }));
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
    return rememberCliCatalog(scope, filterOpenCodeDesktopModels(parsed, env));
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

/** True when a local OpenCode auth entry contains a usable API/OAuth token. */
function authEntryUsable(auth: unknown): boolean {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  const entry = auth as { key?: unknown; access?: unknown; refresh?: unknown };
  return Boolean(entry.key || entry.access || entry.refresh);
}

function usableAuthEntry(parsed: Record<string, unknown>): boolean {
  return Object.values(parsed).some(authEntryUsable);
}

/** Every path the OpenCode CLI may keep auth.json at. */
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

function storedAuthProviderIds(env: Record<string, string | undefined>): Set<string> {
  const providers = new Set<string>();
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const file of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(file, "utf8"));
    } catch {
      // Missing auth storage contributes no connected providers.
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

function desktopVisibleModelIds(env: Record<string, string | undefined>): Set<string> | null {
  const connected = storedAuthProviderIds(env);
  for (const file of desktopStatePaths(env)) {
    try {
      const outer = JSON.parse(readFileSync(file, "utf8")) as { model?: unknown };
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
      // Desktop is optional; a missing/corrupt file falls back to CLI.
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

function hasStoredOpenCodeAuth(env: Record<string, string | undefined>): boolean {
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const file of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(file, "utf8"));
    } catch {
      // Missing storage is unauthenticated, not an error.
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

export async function canListOpenCodeModels(
  env: Record<string, string | undefined>,
  cli: string,
  runModels: OpenCodeModelsRunner = runOpenCodeModels,
): Promise<boolean> {
  const scope = openCodeCliScopeKey(cli, env);
  const cached = modelProbeCache.get(scope);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    result: Promise.resolve(false),
  };
  entry.result = runModels(cli, env, false)
    .then((stdout) => stdout.split(/\r?\n/u).some((line) => validModelSlug(line.trim())))
    .catch(() => false)
    .finally(() => {
      entry.expiresAt = Date.now() + MODEL_PROBE_TTL_MS;
    });
  modelProbeCache.set(scope, entry);
  return entry.result;
}

export function normalizeLegacyOpenCodeModel(
  model: string,
  env: Record<string, string | undefined>,
): string {
  if (model !== "opencode-go/ox-alpha-free") return model;
  return env.OPENCODE_API_KEY
    ? "opencode-go/x-preview-f-free"
    : "opencode/x-preview-f-free";
}

export type OpenCodeCatalogLoader = (
  environment: Record<string, string | undefined>,
  cli: string,
) => Promise<ModelCatalog>;

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

type CatalogStrategy = {
  loadCatalog: OpenCodeCatalogLoader;
  fetcher: typeof fetch;
  goCatalog: boolean;
};

const support = ({ loadCatalog, fetcher, goCatalog }: CatalogStrategy): AcpSupport => ({
  driverKind: "opencodeGo",
  // Keep the historical driver kind so existing bots and instance config do
  // not break; the product name/catalog expand to the maintained OpenCode CLI.
  displayName: "OpenCode",
  models: STATIC_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  loginNote:
    "OpenCode has no usable models — run `opencode auth login` or connect a provider in the OpenCode app",
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
  newSessionTimeoutMs: OPENCODE_NEW_SESSION_TIMEOUT_MS,
  credentialEnv: ["OPENCODE_API_KEY"],
  selectModel: { configId: "model" },
  resolveTurnModel: (model, env, config) => {
    if (!model) return model;
    const normalized = normalizeLegacyOpenCodeModel(model, env);
    const custom = ensureOpenCodeCustomEndpointModel(normalized, config?.customEndpoints ?? [], env);
    return custom === normalized ? ensureOpenCodeInjectModel(normalized, env) : custom;
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
  requireAuthenticationBeforeSpawn: true,
  isAuthenticated: async (env, config) => (
    Boolean(env.OPENCODE_API_KEY)
    || (config.customEndpoints ?? []).some((endpoint) => Boolean(env[customEndpointKeyEnv(endpoint.id)]))
    || hasStoredOpenCodeAuth(env)
    || await canListOpenCodeModels(env, config.cli)
  ),
  classifyError: classifyOpenCodeError,
  resolveModels: async (environment, config) => {
    if (!goCatalog) {
      return mergeLocalInject(await loadCatalog(environment, config.cli), environment);
    }
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

/** Configure an injected provider in a child-local OpenCode overlay. */
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

export function classifyOpenCodeError(error: unknown): ProviderErrorCode | undefined {
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

export const classifyOpenCodeGoError = classifyOpenCodeError;

export async function discoverOpenCodeModels(
  environment: Record<string, string | undefined>,
  cli = "opencode",
): Promise<ModelCatalog> {
  return (await fetchOpenCodeCliModels(cli, environment)) ?? cloneCatalog(STATIC_MODELS);
}

export function createOpenCodeDriver(loadCatalog: OpenCodeCatalogLoader = discoverOpenCodeModels) {
  return createAcpDriver(support({ loadCatalog, fetcher: fetch, goCatalog: false }));
}

/** Historical Go factory: its optional fetcher controls the fixed Go catalog. */
export function createOpenCodeGoDriver(fetcher: typeof fetch = fetch) {
  return createAcpDriver(support({ loadCatalog: discoverOpenCodeModels, fetcher, goCatalog: true }));
}

export const resetOpenCodeModelCache = resetOpenCodeGoModelCache;
export const OpenCodeDriver = createOpenCodeDriver();
export const OpenCodeGoDriver = createOpenCodeGoDriver();
