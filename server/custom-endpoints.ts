import { z } from "zod";

import type { ModelCatalog } from "./contracts.ts";

const ENDPOINT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_ID = /^[^\s]{1,200}$/;
const API_KEY_FIELD = "apiKey" as const;

export const CUSTOM_ENDPOINT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const CUSTOM_ENDPOINT_MAX_OPTIONS_PER_ENDPOINT = 2_048;
export const CUSTOM_ENDPOINT_MAX_OPTIONS_TOTAL = 4_096;
export const CUSTOM_ENDPOINT_MAX_LIVE_DISCOVERIES = 8;
export const CUSTOM_ENDPOINT_DISCOVERY_SETTLE_MS = 5_000;
const CUSTOM_ENDPOINT_PROBE_TIMEOUT_MS = 8_000;

export const customEndpointSchema = z.object({
  id: z.string().regex(ENDPOINT_ID, "must start with a lowercase letter and contain only lowercase letters, numbers, _ or -"),
  name: z.string().trim().min(1).max(120),
  providerId: z.string().trim().regex(PROVIDER_ID, "must start with a lowercase letter and contain only lowercase letters, numbers, _ or -"),
  baseUrl: z.string().trim().url().refine(isSafeCustomEndpointBaseUrl, "must use an http(s) URL without credentials, query, or fragment"),
  defaultModel: z.string().trim().regex(MODEL_ID, "must be a non-empty model id without spaces"),
  context: z.number().int().min(1_024).max(10_000_000).optional(),
  useForNewChats: z.boolean().optional(),
  discoverModels: z.boolean().optional(),
  [API_KEY_FIELD]: z.string().optional(),
});

export type CustomEndpoint = z.infer<typeof customEndpointSchema>;
export type CustomEndpointPublic = Omit<CustomEndpoint, "apiKey"> & { configured: boolean };

export const CUSTOM_ENDPOINT_PRESETS: CustomEndpoint[] = [
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    providerId: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "z-ai/glm-5.2",
    discoverModels: true,
    useForNewChats: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    providerId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "z-ai/glm-5.2",
    discoverModels: true,
    useForNewChats: false,
  },
];

export function parseCustomEndpoint(raw: unknown): CustomEndpoint {
  const parsed = customEndpointSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return {
    ...parsed.data,
    baseUrl: normalizeBaseUrl(parsed.data.baseUrl),
    providerId: parsed.data.providerId.toLowerCase(),
  };
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Validate the URL shape accepted for newly-authored endpoint metadata. */
export function isSafeCustomEndpointBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed) || trimmed.includes("?") || trimmed.includes("#")) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

/** Remove legacy URL components without treating them as credentials. */
export function sanitizeCustomEndpointBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return normalizeBaseUrl(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
  } catch {
    return null;
  }
}

function defensiveCustomEndpointBaseUrl(value: unknown): string | null {
  if (typeof value === "string" && isSafeCustomEndpointBaseUrl(value)) return normalizeBaseUrl(value);
  return sanitizeCustomEndpointBaseUrl(value);
}

export function customEndpointKeyEnv(id: string): string {
  const escapedId = id.replaceAll("_", "_U").replaceAll("-", "_D").toUpperCase();
  return `OPENMAUSBOT_ENDPOINT_${escapedId}_API_KEY`;
}

export function publicCustomEndpoint(endpoint: CustomEndpoint, env: Record<string, string | undefined> = process.env): CustomEndpointPublic {
  const key = endpoint.apiKey || env[customEndpointKeyEnv(endpoint.id)];
  const metadata = { ...endpoint };
  delete metadata[API_KEY_FIELD];
  return {
    ...metadata,
    baseUrl: defensiveCustomEndpointBaseUrl(endpoint.baseUrl) ?? "",
    configured: Boolean(key?.trim()),
  };
}

export function customEndpointModelId(endpointId: string, modelId: string): string {
  return `endpoint::${endpointId}::${encodeURIComponent(modelId)}`;
}

export function decodeCustomEndpointModelId(value: string | null | undefined): { endpointId: string; modelId: string } | null {
  if (typeof value !== "string") return null;
  const match = /^endpoint::([a-z][a-z0-9_-]{0,63})::(.+)$/.exec(value);
  if (!match) return null;
  try {
    const modelId = decodeURIComponent(match[2]);
    return MODEL_ID.test(modelId) ? { endpointId: match[1], modelId } : null;
  } catch {
    return null;
  }
}

function endpointKey(endpoint: CustomEndpoint, env: Record<string, string | undefined>): string | undefined {
  const value = endpoint.apiKey || env[customEndpointKeyEnv(endpoint.id)];
  return value?.trim() || undefined;
}

function modelLabel(endpoint: CustomEndpoint, modelId: string): string {
  return `${modelId} (${endpoint.name})`;
}

export function endpointModelsUrl(endpoint: Pick<CustomEndpoint, "baseUrl">): string | null {
  const baseUrl = defensiveCustomEndpointBaseUrl(endpoint.baseUrl);
  return baseUrl ? `${baseUrl}/models` : null;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeJsonObjects(base: JsonObject, overlay: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = result[key];
    result[key] = isJsonObject(previous) && isJsonObject(value)
      ? mergeJsonObjects(previous, value)
      : value;
  }
  return result;
}

/** Apply a child-local OpenCode config overlay without touching user config. */
export function applyOpenCodeConfigOverlay(
  env: Record<string, string | undefined>,
  overlay: JsonObject,
): void {
  let base: JsonObject = {};
  const raw = env.OPENCODE_CONFIG_CONTENT;
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("OpenCode config content must be a JSON object");
    }
    if (!isJsonObject(parsed)) throw new Error("OpenCode config content must be a JSON object");
    base = parsed;
  }
  if (!isJsonObject(overlay)) throw new Error("OpenCode config overlay must be a JSON object");
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(mergeJsonObjects(base, overlay));
}

type ProbeFailureCode = "timeout" | "body_limit" | "invalid_json" | "network" | "invalid_url";

class ProbeFailure extends Error {
  readonly code: ProbeFailureCode;

  constructor(code: ProbeFailureCode) {
    super(code);
    this.code = code;
  }
}

type ProbeResult =
  | { ok: true; status: number; payload: unknown }
  | { ok: false; status?: number; code: "http" | ProbeFailureCode };

async function readResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? NaN : Number(contentLength);
  if (Number.isFinite(declaredLength) && declaredLength > CUSTOM_ENDPOINT_MAX_BODY_BYTES) {
    throw new ProbeFailure("body_limit");
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        total += chunk.byteLength;
        if (total > CUSTOM_ENDPOINT_MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ProbeFailure("body_limit");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  }

  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > CUSTOM_ENDPOINT_MAX_BODY_BYTES) throw new ProbeFailure("body_limit");
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("network");
  }
}

export async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  return JSON.parse(await readResponseText(response)) as unknown;
}

async function fetchJson(
  url: string | null,
  key: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (!url) return { ok: false, code: "invalid_url" };
  const controller = new AbortController();
  let settle: (result: ProbeResult) => void = () => undefined;
  const deadline = new Promise<ProbeResult>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => {
    controller.abort();
    settle({ ok: false, code: "timeout" });
  }, timeoutMs);
  timer.unref?.();

  const request = Promise.resolve().then(async (): Promise<ProbeResult> => {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    const status = Number.isInteger(response.status) ? response.status : undefined;
    if (!response.ok) return { ok: false, status, code: "http" };
    let payload: unknown;
    try {
      payload = await readBoundedJsonResponse(response);
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure("invalid_json");
    }
    return { ok: true, status: response.status, payload };
  }).catch((error): ProbeResult => {
    if (error instanceof ProbeFailure) return { ok: false, code: error.code };
    return { ok: false, code: "network" };
  });

  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function probeFailureMessage(result: Extract<ProbeResult, { ok: false }>): string {
  if (result.code === "http") return `Custom endpoint returned HTTP ${result.status ?? 0}`;
  if (result.code === "timeout") return "Custom endpoint probe timed out";
  if (result.code === "body_limit") return "Custom endpoint response exceeded 8 MiB";
  if (result.code === "invalid_json") return "Custom endpoint returned invalid JSON";
  if (result.code === "invalid_url") return "Custom endpoint URL is invalid";
  return "Custom endpoint probe failed";
}

function modelRecords(payload: unknown): string[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  return records
    .map((record) => record && typeof record === "object" ? (record as { id?: unknown }).id : undefined)
    .filter((id): id is string => typeof id === "string" && MODEL_ID.test(id));
}

/** Return the small catalog used by the OpenCode model picker. Discovery is
 * opt-in, and a failed provider never blocks the other endpoints. */
export async function fetchCustomEndpointModels(
  endpoints: CustomEndpoint[],
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<ModelCatalog> {
  const keyed = endpoints
    .map((endpoint, index) => ({ endpoint, index, key: endpointKey(endpoint, env) }))
    .filter((entry): entry is { endpoint: CustomEndpoint; index: number; key: string } => Boolean(entry.key))
    .slice(0, CUSTOM_ENDPOINT_MAX_OPTIONS_TOTAL);
  const modelsByIndex = new Map<number, Set<string>>(
    keyed.map(({ endpoint, index }) => [index, new Set([endpoint.defaultModel])]),
  );
  const liveEntries: Array<{ endpoint: CustomEndpoint; index: number; key: string }> = [];
  for (const entry of keyed) {
    if (!entry.endpoint.discoverModels || liveEntries.length >= CUSTOM_ENDPOINT_MAX_LIVE_DISCOVERIES) continue;
    liveEntries.push(entry);
  }
  const discovered = await Promise.all(liveEntries.map(async (entry) => ({
    entry,
    result: await fetchJson(
      endpointModelsUrl(entry.endpoint),
      entry.key,
      fetcher,
      CUSTOM_ENDPOINT_DISCOVERY_SETTLE_MS,
    ),
  })));
  for (const { entry, result } of discovered) {
    if (!result.ok) continue;
    const models = modelsByIndex.get(entry.index);
    if (!models) continue;
    for (const id of modelRecords(result.payload)) {
      if (entry.key && id.includes(entry.key)) continue;
      if (models.size >= CUSTOM_ENDPOINT_MAX_OPTIONS_PER_ENDPOINT) break;
      models.add(id);
    }
  }

  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let selectedDefault = "";
  for (const { endpoint, index } of keyed) {
    const models = modelsByIndex.get(index) ?? new Set<string>();
    for (const modelId of models) {
      if (options.length >= CUSTOM_ENDPOINT_MAX_OPTIONS_TOTAL) break;
      const id = customEndpointModelId(endpoint.id, modelId);
      if (seen.has(id)) continue;
      seen.add(id);
      options.push({ id, label: modelLabel(endpoint, modelId), custom: true });
      if (!selectedDefault && endpoint.useForNewChats && modelId === endpoint.defaultModel) selectedDefault = id;
    }
    if (options.length >= CUSTOM_ENDPOINT_MAX_OPTIONS_TOTAL) break;
  }
  return { default: selectedDefault || options[0]?.id || "", options };
}

export async function testCustomEndpoint(
  endpoint: CustomEndpoint,
  keyValue: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; status: number; models: number; includesDefault: boolean } | { ok: false; status?: number; message: string }> {
  const key = keyValue?.trim();
  if (!key) return { ok: false, message: "API key is required" };
  const result = await fetchJson(endpointModelsUrl(endpoint), key, fetcher, CUSTOM_ENDPOINT_PROBE_TIMEOUT_MS);
  if (!result.ok) return { ok: false, status: result.status, message: probeFailureMessage(result) };
  const models = modelRecords(result.payload);
  return {
    ok: true,
    status: result.status,
    models: Math.min(models.length, CUSTOM_ENDPOINT_MAX_OPTIONS_PER_ENDPOINT),
    includesDefault: models.includes(endpoint.defaultModel),
  };
}

/** Configure an OpenCode provider in the child-local overlay. */
export function ensureOpenCodeCustomEndpointModel(
  modelId: string,
  endpoints: CustomEndpoint[],
  env: Record<string, string | undefined> = process.env,
): string {
  const decoded = decodeCustomEndpointModelId(modelId);
  if (!decoded) return modelId;
  const endpoint = endpoints.find((candidate) => candidate.id === decoded.endpointId);
  if (!endpoint) return modelId;
  const baseUrl = defensiveCustomEndpointBaseUrl(endpoint.baseUrl);
  if (!baseUrl) return modelId;
  const envKey = customEndpointKeyEnv(endpoint.id);
  if (endpoint.apiKey && !env[envKey]) env[envKey] = endpoint.apiKey;
  applyOpenCodeConfigOverlay(env, {
    provider: {
      [endpoint.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: endpoint.name,
        options: {
          baseURL: baseUrl,
          [API_KEY_FIELD]: `{env:${envKey}}`,
        },
        models: {
          [decoded.modelId]: {
            name: modelLabel(endpoint, decoded.modelId),
            ...(endpoint.context ? { limit: { context: endpoint.context } } : {}),
          },
        },
      },
    },
  });
  return `${endpoint.providerId}/${decoded.modelId}`;
}

/** The metadata passed in an OpenCode instance config must not include keys. */
export function customEndpointMetadata(endpoints: Record<string, CustomEndpoint> | undefined): CustomEndpoint[] {
  return Object.values(endpoints ?? {}).map((endpoint) => {
    const metadata = { ...endpoint };
    delete metadata[API_KEY_FIELD];
    return {
      ...metadata,
      baseUrl: defensiveCustomEndpointBaseUrl(endpoint.baseUrl) ?? "",
    };
  });
}

export function configuredEndpointKey(endpoint: CustomEndpoint, env: Record<string, string | undefined> = process.env): string | undefined {
  return endpointKey(endpoint, env);
}
