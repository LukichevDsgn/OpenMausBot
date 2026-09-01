// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";
import {
  customEndpointKeyEnv,
  customEndpointMetadata,
  customEndpointSchema,
  isSafeCustomEndpointBaseUrl,
  sanitizeCustomEndpointBaseUrl,
  configuredEndpointKey,
  CUSTOM_ENDPOINT_PRESETS,
  type CustomEndpoint,
} from "./custom-endpoints.ts";

const optionalText = z.string().optional();
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LEGACY_BROWSER_PROFILE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const BROWSER_PROFILE_ID = /^[a-z0-9_-]{1,40}$/;

export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 4;

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

/** Keep the persisted VPS shape deliberately smaller than an SSH connection. */
export function normalizeVpsConfig(raw: unknown): { sshAlias?: string } {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vps must be an object containing an SSH config alias");
  }
  const alias = (raw as Record<string, unknown>).sshAlias;
  if (alias === undefined || alias === "") return {};
  if (!isValidSshAlias(alias)) {
    throw new Error("vps.sshAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore)");
  }
  return { sshAlias: alias };
}

const vpsConfigSchema = z.object({
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), {
    message: "must be a simple SSH config alias",
  }).optional(),
});
const roomConfigSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES),
});
const localVmConfigSchema = z.object({
  mode: z.enum(["shared", "per-bot"]).optional(),
  maxInstances: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_MAX_INSTANCES)
    .max(MAX_LOCAL_VM_MAX_INSTANCES)
    .optional(),
});

const browserProfileSchema = z.object({
  id: z.string().regex(BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved"),
  name: z.string().trim().min(1).max(40),
}).strict();

const legacyBrowserProfileSchema = z.object({
  id: z.string().regex(LEGACY_BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved"),
  name: z.string().trim().min(1).max(40),
  partitionId: z.string().regex(LEGACY_BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved").optional(),
}).strict();

interface StoredBrowserProfileMigration {
  profiles: BrowserProfile[];
  aliases: ReadonlyMap<string, string>;
}

function suffixedBrowserProfileId(base: string, unavailable: ReadonlySet<string>): string {
  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, 40 - ending.length)}${ending}`;
    if (candidate !== "guest" && !unavailable.has(candidate)) return candidate;
  }
}

function migrateStoredBrowserProfiles(
  profiles: Array<z.output<typeof legacyBrowserProfileSchema>>,
): StoredBrowserProfileMigration {
  const requestedPartitions = profiles.map((profile) => profile.partitionId ?? profile.id);
  const rawBases = profiles.map((profile) => profile.id.toLowerCase());
  const canonicalIds: Array<string | undefined> = Array(profiles.length).fill(undefined);
  const used = new Set<string>();
  const baseOwner = new Map<string, number>();
  rawBases.forEach((base, index) => {
    if (base === "guest") return;
    const current = baseOwner.get(base);
    if (current === undefined || (profiles[index]!.id === base && profiles[current]!.id !== base)) {
      baseOwner.set(base, index);
    }
  });
  for (const [base, index] of baseOwner) {
    canonicalIds[index] = base;
    used.add(base);
  }
  const reserved = new Set([
    "guest",
    ...rawBases,
    ...requestedPartitions.map((partitionId) => partitionId.toLowerCase()),
  ]);
  rawBases.forEach((base, index) => {
    if (canonicalIds[index] !== undefined) return;
    const id = suffixedBrowserProfileId(base, new Set([...reserved, ...used]));
    canonicalIds[index] = id;
    used.add(id);
  });

  const partitionWinner = new Map<string, number>();
  requestedPartitions.forEach((partitionId, index) => {
    const folded = partitionId.toLowerCase();
    const current = partitionWinner.get(folded);
    if (current === undefined) {
      partitionWinner.set(folded, index);
      return;
    }
    const score = (candidate: number) => canonicalIds[candidate] === folded ? 1 : 0;
    if (score(index) > score(current)) partitionWinner.set(folded, index);
  });

  let effectivePartitions = requestedPartitions.map((partitionId, index) =>
    partitionWinner.get(partitionId.toLowerCase()) === index ? partitionId : canonicalIds[index]!,
  );
  const conflictingIdOwners = new Set<number>();
  canonicalIds.forEach((id, owner) => {
    effectivePartitions.forEach((partitionId, partitionOwner) => {
      if (partitionOwner !== owner && partitionId.toLowerCase() === id) conflictingIdOwners.add(owner);
    });
  });
  const unavailable = new Set([...reserved, ...used]);
  for (const owner of conflictingIdOwners) {
    const id = suffixedBrowserProfileId(rawBases[owner]!, unavailable);
    canonicalIds[owner] = id;
    unavailable.add(id);
  }
  if (conflictingIdOwners.size > 0) {
    effectivePartitions = requestedPartitions.map((partitionId, index) =>
      partitionWinner.get(partitionId.toLowerCase()) === index ? partitionId : canonicalIds[index]!,
    );
  }

  const aliases = new Map<string, string>();
  const canonical: BrowserProfile[] = profiles.map((profile, index) => {
    const id = canonicalIds[index]!;
    const partitionId = effectivePartitions[index]!;
    const migrated: BrowserProfile = { id, name: profile.name };
    if (partitionId !== id) migrated.partitionId = partitionId;
    if (!aliases.has(profile.id)) aliases.set(profile.id, id);
    return migrated;
  });
  return { profiles: canonical, aliases };
}

const legacyBrowserProfilesSchema = z.array(legacyBrowserProfileSchema).max(20);
const storedBrowserProfilesSchema = legacyBrowserProfilesSchema.transform(
  (profiles) => migrateStoredBrowserProfiles(profiles).profiles,
);
const browserProfilesSchema = z.array(browserProfileSchema).max(20).superRefine((profiles, ctx) => {
  const seen = new Set<string>();
  profiles.forEach((profile, index) => {
    if (!seen.has(profile.id)) {
      seen.add(profile.id);
      return;
    }
    ctx.addIssue({
      code: "custom",
      path: [index, "id"],
      message: `browser profile id ${profile.id} is duplicated`,
    });
  });
});

export const DEFAULT_ANTIGRAVITY_PROXY_URL = "http://127.0.0.1:10808";
export const ANTIGRAVITY_NETWORK_ROUTE_ENV = "OPENMAUSBOT_ANTIGRAVITY_NETWORK_ROUTE";
export const ANTIGRAVITY_NETWORK_ROUTE_SEPARATOR = "|";
export const ANTIGRAVITY_WORKER_A_INSTANCE_ID = "antigravity-worker-a";
export const ANTIGRAVITY_WORKER_B_INSTANCE_ID = "antigravity-worker-b";
const ANTIGRAVITY_WORKER_LABELS = {
  a: "Antigravity A · Worker A",
  b: "Antigravity B · Worker B",
} as const;

function antigravityWorkerCli(profile: "a" | "b"): string {
  const packaged = process.env.OMB_RESOURCES_PATH
    ? join(process.env.OMB_RESOURCES_PATH, "antigravity", `agy-worker-${profile}.exe`)
    : null;
  return packaged && existsSync(packaged)
    ? packaged
    : join(homedir(), ".openmausbot", "bin", `agy-worker-${profile}.exe`);
}

export type AntigravityNetworkMode = "off" | "tun" | "proxy";

/** Normalize only an explicitly-portioned loopback HTTP(S) proxy URL. */
export function normalizeAntigravityProxyUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})(\/?)$/i.exec(input);
  if (!match) return null;
  const protocol = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return null;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  try {
    const parsed = new URL(input);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
  } catch {
    return null;
  }
  return `${protocol}://${host}:${port}`;
}

function canonicalAntigravityProxySettings(raw: {
  mode?: AntigravityNetworkMode;
  enabled?: boolean;
  url?: string;
} | undefined): { mode: AntigravityNetworkMode; url: string } {
  const normalizedUrl = normalizeAntigravityProxyUrl(raw?.url);
  if (raw?.url !== undefined && normalizedUrl === null) throw new Error("Invalid Antigravity proxy URL");
  const mode = raw?.mode
    ?? (raw?.enabled === true ? "proxy" : raw?.enabled === false ? "tun" : "off");
  if (mode === "proxy" && normalizedUrl === null) throw new Error("Antigravity proxy URL is required in Proxy mode");
  return { mode, url: normalizedUrl ?? DEFAULT_ANTIGRAVITY_PROXY_URL };
}

function canonicalAntigravityProxyPatch(raw: {
  mode?: AntigravityNetworkMode;
  enabled?: boolean;
  url?: string;
}): { mode: AntigravityNetworkMode; url?: string } {
  const settings = canonicalAntigravityProxySettings(raw);
  return settings.mode === "proxy" || raw.url !== undefined
    ? settings
    : { mode: settings.mode };
}

export function antigravityProxySettings(cfg: Pick<AppConfig, "features">): {
  mode: AntigravityNetworkMode;
  url: string;
} {
  try {
    return canonicalAntigravityProxySettings(cfg.features?.antigravityProxy);
  } catch {
    return { mode: "off", url: DEFAULT_ANTIGRAVITY_PROXY_URL };
  }
}

export function antigravityNetworkRoute(cfg: Pick<AppConfig, "features">): string {
  const settings = antigravityProxySettings(cfg);
  return settings.mode === "proxy"
    ? `proxy${ANTIGRAVITY_NETWORK_ROUTE_SEPARATOR}${settings.url}`
    : settings.mode;
}

export function normalizeAntigravityNetworkRoute(value: unknown): string {
  if (value === "system") return "tun";
  if (value === "off" || value === "tun") return value;
  if (typeof value !== "string" || !value.startsWith(`proxy${ANTIGRAVITY_NETWORK_ROUTE_SEPARATOR}`)) return "off";
  const url = normalizeAntigravityProxyUrl(value.slice(`proxy${ANTIGRAVITY_NETWORK_ROUTE_SEPARATOR}`.length));
  return url ? `proxy${ANTIGRAVITY_NETWORK_ROUTE_SEPARATOR}${url}` : "off";
}

const featureConfigSchema = z.object({
  /** Experimental desktop workflow recorder. Hidden unless explicitly enabled. */
  skillRecorder: z.boolean().optional(),
  /** Show each tool run in the transcript. Off unless explicitly enabled. */
  showToolCalls: z.boolean().optional(),
  /** Experimental built-in browser. Off until explicitly enabled; each bot
   * also has its own switch. */
  browser: z.boolean().optional(),
  /** Shared Antigravity launcher route. `enabled` is a read-compatibility migration input. */
  antigravityProxy: z.object({
    mode: z.enum(["off", "tun", "proxy"]).optional(),
    enabled: z.boolean().optional(),
    url: z.string().optional().refine(
      (value) => value === undefined || normalizeAntigravityProxyUrl(value) !== null,
      "must be a local HTTP(S) proxy URL with an explicit port",
    ),
  }).strict().superRefine((value, ctx) => {
    if ((value.mode === "proxy" || value.enabled === true) && value.url === undefined) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "is required when proxy routing is enabled" });
    }
  }).optional(),
});
const instanceConfigSchema = z.object({
  driver: z.string().min(1),
  displayName: optionalText,
  accentColor: optionalText,
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  config: z.json().optional(),
});
const instanceConfigMapSchema = z.record(z.string(), instanceConfigSchema);
const customEndpointMapSchema = z.record(z.string(), customEndpointSchema);
const appConfigSchema = z.object({
  xai: z.object({ key: optionalText, url: optionalText }).optional(),
  nvidia: z.object({ apiKey: optionalText }).optional(),
  openrouter: z.object({ apiKey: optionalText }).optional(),
  openaiCompat: z.object({ key: optionalText, url: optionalText }).optional(),
  /** Project key used for Sessions, catalog and agent tools. userId/sessionId
   * are non-secret local identifiers used to reuse one Composio Session. */
  composio: z.object({ apiKey: optionalText, userId: optionalText, sessionId: optionalText }).optional(),
  box: z.object({ token: optionalText }).optional(),
  vps: vpsConfigSchema.optional(),
  /** Optional OpenCode key; persisted write-only and passed only to its child. */
  opencodeGo: z.object({ apiKey: optionalText }).optional(),
  /** OpenAI-compatible endpoints managed by the OpenCode ACP harness. */
  customEndpoints: customEndpointMapSchema.optional(),
  /** Voice credentials and the selected voice id. `provider` picks the
   * engine: "elevenlabs" (default; needs a key) or "system" (the Mac's
   * built-in voices, no key). */
  tts: z.object({ key: optionalText, voice: optionalText, provider: z.enum(["elevenlabs", "system"]).optional() }).optional(),
  /** OpenAI key used only by the in-process avatar image generator. */
  imageGen: z.object({ key: optionalText }).optional(),
  /** Non-secret profile details shown in the sidebar. */
  profile: z.object({ name: optionalText, email: optionalText }).optional(),
  rooms: roomConfigSchema.optional(),
  localVm: localVmConfigSchema.optional(),
  features: featureConfigSchema.optional(),
  browserProfiles: browserProfilesSchema.optional(),
  instances: instanceConfigMapSchema.optional(),
});
const storedAppConfigSchema = appConfigSchema.extend({
  browserProfiles: storedBrowserProfilesSchema.optional(),
});
const appConfigPatchSchema = appConfigSchema.omit({ instances: true });
const jsonObjectSchema = z.record(z.string(), z.json());

export interface AppConfig {
  xai?: { key?: string; url?: string };
  nvidia?: { apiKey?: string };
  openrouter?: { apiKey?: string };
  openaiCompat?: { key?: string; url?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string };
  box?: { token?: string };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string };
  opencodeGo?: { apiKey?: string };
  customEndpoints?: Record<string, CustomEndpoint>;
  tts?: { key?: string; voice?: string; provider?: "elevenlabs" | "system" };
  imageGen?: { key?: string };
  profile?: { name?: string; email?: string };
  rooms?: { turnTimeoutMinutes: number };
  /** Shared preserves the historical singleton. Per-bot gives every bot a
   * separate container, durable workspace, viewer and lease. */
  localVm?: { mode?: "shared" | "per-bot"; maxInstances?: number };
  /** Opt-in product experiments. Every flag defaults to disabled. */
  features?: {
    skillRecorder?: boolean;
    showToolCalls?: boolean;
    browser?: boolean;
    antigravityProxy?: { mode?: AntigravityNetworkMode; enabled?: boolean; url?: string };
  };
  browserProfiles?: BrowserProfile[];
  instances?: InstanceConfigMap;
}
export type BrowserProfile = z.output<typeof browserProfileSchema> & {
  partitionId?: string;
};
export type ConfigPatch = z.output<typeof appConfigPatchSchema>;

export function browserProfilePartitionId(profile: BrowserProfile): string {
  return profile.partitionId ?? profile.id;
}

export function browserProfileRoutingConflict(
  profiles: readonly BrowserProfile[],
): string | null {
  const logicalOwner = new Map(profiles.map((profile, index) => [profile.id.toLowerCase(), index]));
  const partitionOwner = new Map<string, number>();
  for (const [index, profile] of profiles.entries()) {
    const partitionId = browserProfilePartitionId(profile);
    const foldedPartition = partitionId.toLowerCase();
    const existingPartitionOwner = partitionOwner.get(foldedPartition);
    if (existingPartitionOwner !== undefined && existingPartitionOwner !== index) {
      return `browser profiles cannot share the durable session “${partitionId}”`;
    }
    partitionOwner.set(foldedPartition, index);
    const otherLogicalOwner = logicalOwner.get(foldedPartition);
    if (otherLogicalOwner !== undefined && otherLogicalOwner !== index) {
      return `browser profile id “${profiles[otherLogicalOwner]!.id}” is already used by another durable session`;
    }
  }
  return null;
}

export function browserProfileReplacementConflict(
  currentProfiles: readonly BrowserProfile[],
  nextProfiles: readonly BrowserProfile[],
): string | null {
  const routingConflict = browserProfileRoutingConflict(nextProfiles);
  if (routingConflict) return routingConflict;
  const currentIds = new Set(currentProfiles.map((profile) => profile.id));
  const nextIds = new Set(nextProfiles.map((profile) => profile.id));
  const removedPartitions = new Set(
    currentProfiles
      .filter((profile) => !nextIds.has(profile.id))
      .map((profile) => browserProfilePartitionId(profile).toLowerCase()),
  );
  const reused = nextProfiles.find((profile) =>
    !currentIds.has(profile.id)
    && removedPartitions.has(browserProfilePartitionId(profile).toLowerCase()));
  return reused
    ? `browser profile “${reused.name}” cannot reuse a session that is being erased; delete it first, then add the new profile`
    : null;
}

export interface BrowserProfilePartitionTarget {
  profileId: string;
  partitionId: string;
}

export function browserProfilePartitionTarget(
  config: Pick<AppConfig, "browserProfiles">,
  profileId: string,
): BrowserProfilePartitionTarget | null {
  const profile = config.browserProfiles?.find((candidate) => candidate.id === profileId);
  return profile ? { profileId: profile.id, partitionId: browserProfilePartitionId(profile) } : null;
}

/** Replace the live config object exactly. In-place identity is retained for
 * existing readers, while optional keys removed by the new snapshot cannot
 * survive a shallow merge. */
export function replaceAppConfig(target: AppConfig, next: AppConfig): void {
  for (const key of Object.keys(target)) {
    delete (target as unknown as Record<string, unknown>)[key];
  }
  Object.assign(target, structuredClone(next));
}

function isJsonRecord(value: JsonValue): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Purely sanitize legacy endpoint URLs while preserving every other field. */
export function sanitizeStoredCustomEndpointUrls(value: JsonValue): { value: JsonValue; changed: boolean } {
  if (!isJsonRecord(value) || !isJsonRecord(value.customEndpoints)) return { value, changed: false };
  let sanitizedEndpoints: JsonObject | undefined;
  for (const [id, rawEndpoint] of Object.entries(value.customEndpoints)) {
    if (!isJsonRecord(rawEndpoint) || typeof rawEndpoint.baseUrl !== "string") continue;
    if (isSafeCustomEndpointBaseUrl(rawEndpoint.baseUrl)) continue;
    const safeBaseUrl = sanitizeCustomEndpointBaseUrl(rawEndpoint.baseUrl);
    if (!safeBaseUrl || safeBaseUrl === rawEndpoint.baseUrl) continue;
    sanitizedEndpoints ??= { ...value.customEndpoints };
    sanitizedEndpoints[id] = { ...rawEndpoint, baseUrl: safeBaseUrl };
  }
  if (!sanitizedEndpoints) return { value, changed: false };
  return { value: { ...value, customEndpoints: sanitizedEndpoints }, changed: true };
}

/** Include the two common aggregators only when an older config already has
 * their fixed key. New endpoints are created explicitly from the UI, while
 * existing NVIDIA/OpenRouter keys remain usable after the endpoint manager
 * replaces the old standalone key rows. */
export function effectiveCustomEndpoints(cfg: AppConfig): Record<string, CustomEndpoint> {
  const result: Record<string, CustomEndpoint> = { ...(cfg.customEndpoints ?? {}) };
  for (const preset of CUSTOM_ENDPOINT_PRESETS) {
    if (result[preset.id]) continue;
    const legacyKey = preset.id === "nvidia" ? cfg.nvidia?.apiKey : cfg.openrouter?.apiKey;
    if (legacyKey) result[preset.id] = { ...preset, apiKey: legacyKey };
  }
  return result;
}

/** Validate stored configuration and canonicalize its Antigravity route. */
export function parseStoredConfig(value: JsonValue): AppConfig {
  const parsed = storedAppConfigSchema.safeParse(sanitizeStoredCustomEndpointUrls(value).value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Invalid stored configuration"));
  const proxy = parsed.data.features?.antigravityProxy;
  if (proxy === undefined) return parsed.data;
  try {
    return {
      ...parsed.data,
      features: { ...parsed.data.features, antigravityProxy: canonicalAntigravityProxySettings(proxy) },
    };
  } catch {
    throw new Error("Invalid stored configuration");
  }
}

export function parseConfigPatch(value: JsonValue): ConfigPatch {
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(schemaIssue(parsed.error, "Invalid configuration")), { status: 400 });
  }
  const proxy = parsed.data.features?.antigravityProxy;
  if (proxy === undefined) return parsed.data;
  try {
    return {
      ...parsed.data,
      features: { ...parsed.data.features, antigravityProxy: canonicalAntigravityProxyPatch(proxy) },
    };
  } catch {
    throw Object.assign(new Error("Invalid configuration"), { status: 400 });
  }
}

export function vpsSshAlias(cfg: AppConfig): string | null {
  return isValidSshAlias(cfg.vps?.sshAlias) ? cfg.vps.sshAlias : null;
}

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

export function localVmMode(cfg: AppConfig): "shared" | "per-bot" {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

export function skillRecorderEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillRecorder === true;
}

export function showToolCallsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.showToolCalls === true;
}

export function builtInBrowserEnabled(cfg: AppConfig): boolean {
  return cfg.features?.browser === true;
}

// OMB_DATA_DIR isolates test/soak rigs from the user's real fleet.
export const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
    try {
      renameSync(LEGACY_DATA_DIR, DATA_DIR);
    } catch {
      /* cross-device or busy — fall through to a fresh dir */
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(
  dataDir = DATA_DIR,
  persist: (path: string, value: JsonValue) => void = (path, value) => {
    writeFileAtomic(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  },
): AppConfig {
  let cfg: AppConfig = {};
  const configPath = join(dataDir, "config.json");
  try {
    const sanitized = sanitizeStoredCustomEndpointUrls(parseJson(readFileSync(configPath, "utf8")));
    cfg = parseStoredConfig(sanitized.value);
    if (sanitized.changed) {
      try {
        persist(configPath, sanitized.value);
      } catch {
        // Keep the sanitized runtime usable; the unchanged raw file retries on
        // the next load instead of surfacing unsafe data or a persistence error.
      }
    }
  } catch {
    /* first run — env fallbacks below */
  }
  // Env wins over the file for every credential. The desktop shell keeps
  // these secrets OS-encrypted and hands them to this process as env at
  // spawn, leaving config.json without the plaintext field — so the file
  // value is the dev-mode (no desktop shell) fallback, not the primary.
  // Anything that saves a credential mid-session must keep process.env in
  // step (syncCredentialEnv below), or the value injected at boot would
  // shadow the save until the next launch.
  cfg.xai = { ...cfg.xai };
  if (process.env.XAI_API_KEY !== undefined) cfg.xai.key = process.env.XAI_API_KEY;
  cfg.nvidia = { ...cfg.nvidia };
  if (process.env.NVIDIA_API_KEY !== undefined) cfg.nvidia.apiKey = process.env.NVIDIA_API_KEY;
  cfg.openrouter = { ...cfg.openrouter };
  if (process.env.OPENROUTER_API_KEY !== undefined) cfg.openrouter.apiKey = process.env.OPENROUTER_API_KEY;
  cfg.openaiCompat = { ...cfg.openaiCompat };
  if (process.env.OPENAI_COMPAT_API_KEY !== undefined) cfg.openaiCompat.key = process.env.OPENAI_COMPAT_API_KEY;
  if (process.env.OPENAI_COMPAT_URL !== undefined) cfg.openaiCompat.url = process.env.OPENAI_COMPAT_URL;
  cfg.composio = { ...cfg.composio };
  if (process.env.COMPOSIO_API_KEY !== undefined) cfg.composio.apiKey = process.env.COMPOSIO_API_KEY;
  cfg.box = { ...cfg.box };
  if (process.env.BOX_TOKEN !== undefined) cfg.box.token = process.env.BOX_TOKEN;
  cfg.opencodeGo = { ...cfg.opencodeGo };
  if (process.env.OPENCODE_API_KEY !== undefined) cfg.opencodeGo.apiKey = process.env.OPENCODE_API_KEY;
  cfg.tts = { ...cfg.tts };
  if (process.env.OMB_TTS_KEY !== undefined) cfg.tts.key = process.env.OMB_TTS_KEY;
  cfg.imageGen = { ...cfg.imageGen };
  if (process.env.OMB_OPENAI_IMAGE_KEY !== undefined) cfg.imageGen.key = process.env.OMB_OPENAI_IMAGE_KEY;
  return cfg;
}

/** After saveConfig() writes a credential, the running process's env must
 * follow the newest value — loadConfig() prefers env, so the secret injected
 * at boot would otherwise shadow the save until relaunch: the UI would show
 * "saved" while every turn still used the old key. An empty string means the
 * user cleared the credential, so the var is dropped and the (now empty)
 * file value is authoritative again. Fields absent from the patch are
 * untouched. */
export function syncCredentialEnv(patch: Partial<AppConfig>): void {
  const secrets: Array<[value: string | undefined, name: string]> = [
    [patch.xai?.key, "XAI_API_KEY"],
    [patch.nvidia?.apiKey, "NVIDIA_API_KEY"],
    [patch.openrouter?.apiKey, "OPENROUTER_API_KEY"],
    [patch.openaiCompat?.key, "OPENAI_COMPAT_API_KEY"],
    [patch.composio?.apiKey, "COMPOSIO_API_KEY"],
    [patch.box?.token, "BOX_TOKEN"],
    [patch.opencodeGo?.apiKey, "OPENCODE_API_KEY"],
    [patch.tts?.key, "OMB_TTS_KEY"],
    [patch.imageGen?.key, "OMB_OPENAI_IMAGE_KEY"],
  ];
  for (const [value, name] of secrets) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  if (patch.openaiCompat?.url !== undefined) {
    if (patch.openaiCompat.url) process.env["OPENAI_COMPAT_URL"] = patch.openaiCompat.url;
    else delete process.env["OPENAI_COMPAT_URL"];
  }
}

/** Keep a dynamic endpoint key live in this server process. Packaged Electron
 * also keeps the durable copy in its OS-backed credential store. */
export function syncCustomEndpointKey(id: string, value: string): void {
  const envName = customEndpointKeyEnv(id);
  if (value.trim()) process.env[envName] = value.trim();
  else delete process.env[envName];
}

export type ConfigTransactionOutcome = "success" | "rolled_back" | "unknown";

export interface ConfigTransactionSnapshot {
  readonly configPath: string;
  readonly fileExists: boolean;
  readonly fileBytes?: Buffer;
  readonly cfg: AppConfig;
  readonly env: Record<string, string | undefined>;
}

export interface ConfigTransactionPlan {
  /** Persist the new config. No environment mutation may happen here. */
  applyDisk: () => void | Promise<void>;
  /** Apply the live environment only after applyDisk has completed. */
  applyEnv?: () => void | Promise<void>;
  /** Read the effective config after disk and env are in their new state. */
  readConfig?: () => AppConfig;
  /** Commit a live config when no provider reload is needed. */
  commitConfig?: (next: AppConfig) => void | Promise<void>;
  /** Apply the live config and rebuild the fleet. This is also used for rollback. */
  reload?: (next: AppConfig) => void | Promise<void>;
}

export interface ConfigTransactionResult {
  readonly outcome: ConfigTransactionOutcome;
  readonly config: AppConfig;
  /** Internal only. HTTP callers must never serialize these causes. */
  readonly cause?: unknown;
  /** Internal only. Present when any restoration step failed. */
  readonly rollbackCause?: unknown;
}

const isRelevantCredentialEnv = (name: string): boolean =>
  (WORKSPACE_CREDENTIAL_ENV as readonly string[]).includes(name) || name.startsWith("OPENMAUSBOT_ENDPOINT_");

function snapshotRelevantEnv(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const names = new Set<string>(WORKSPACE_CREDENTIAL_ENV);
  for (const name of Object.keys(environment)) {
    if (name.startsWith("OPENMAUSBOT_ENDPOINT_")) names.add(name);
  }
  return Object.fromEntries([...names].sort().map((name) => [name, environment[name]]));
}

/** Capture the exact on-disk bytes, live config, and credential environment
 * before a multi-surface config mutation. This is intentionally injectable so
 * transaction tests never touch the user's data directory. */
export function captureConfigTransactionSnapshot(
  cfg: AppConfig,
  dataDir = DATA_DIR,
  environment: Record<string, string | undefined> = process.env,
): ConfigTransactionSnapshot {
  const configPath = join(dataDir, "config.json");
  const fileExists = existsSync(configPath);
  return {
    configPath,
    fileExists,
    ...(fileExists ? { fileBytes: readFileSync(configPath) } : {}),
    cfg: structuredClone(cfg),
    env: snapshotRelevantEnv(environment),
  };
}

function restoreConfigFile(snapshot: ConfigTransactionSnapshot): void {
  if (!snapshot.fileExists) {
    if (existsSync(snapshot.configPath)) unlinkSync(snapshot.configPath);
    return;
  }
  mkdirSync(dirname(snapshot.configPath), { recursive: true });
  writeFileSync(snapshot.configPath, snapshot.fileBytes ?? Buffer.alloc(0), { mode: 0o600 });
}

function restoreRelevantEnv(
  snapshot: ConfigTransactionSnapshot,
  environment: Record<string, string | undefined>,
): void {
  const names = new Set<string>(Object.keys(snapshot.env));
  for (const name of Object.keys(environment)) {
    if (isRelevantCredentialEnv(name)) names.add(name);
  }
  for (const name of names) {
    const value = snapshot.env[name];
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
}

function internalTransactionResult(
  outcome: ConfigTransactionOutcome,
  config: AppConfig,
  cause?: unknown,
  rollbackCause?: unknown,
): ConfigTransactionResult {
  const result: ConfigTransactionResult = { outcome, config: structuredClone(config) };
  Object.defineProperties(result, {
    cause: { value: cause, enumerable: false, writable: false },
    rollbackCause: { value: rollbackCause, enumerable: false, writable: false },
  });
  return result;
}

function preflightTransactionFailure(currentCfg: AppConfig, cause: unknown): ConfigTransactionResult {
  let config: AppConfig = currentCfg;
  try {
    config = structuredClone(currentCfg);
  } catch {
    // AppConfig is JSON-shaped in normal operation. If cloning the supplied
    // snapshot itself fails, keep the caller's object untouched and still
    // return the definite-not-applied taxonomy.
  }
  const result: ConfigTransactionResult = { outcome: "rolled_back", config };
  Object.defineProperties(result, {
    cause: { value: cause, enumerable: false, writable: false },
    rollbackCause: { value: undefined, enumerable: false, writable: false },
  });
  return result;
}

/** Execute a config mutation as disk -> env -> live config/fleet. If any
 * stage fails, restore the exact prior disk/env/config; a provider rebuild is
 * attempted only after the new reload has begun. Causes stay on the returned
 * internal result and never belong in an HTTP response. */
export async function runConfigTransaction(
  currentCfg: AppConfig,
  plan: ConfigTransactionPlan,
  options: {
    dataDir?: string;
    environment?: Record<string, string | undefined>;
  } = {},
): Promise<ConfigTransactionResult> {
  const environment = options.environment ?? process.env;
  let snapshot: ConfigTransactionSnapshot;
  try {
    snapshot = captureConfigTransactionSnapshot(currentCfg, options.dataDir ?? DATA_DIR, environment);
  } catch (cause) {
    // Preflight has not reached any mutation callback: the new operation is
    // definitely not applied, so no rollback work or fleet rebuild is valid.
    return preflightTransactionFailure(currentCfg, cause);
  }
  let reloadBegan = false;
  try {
    await plan.applyDisk();
    await plan.applyEnv?.();
    const next = structuredClone(plan.readConfig ? plan.readConfig() : currentCfg);
    if (plan.reload) {
      reloadBegan = true;
      await plan.reload(next);
    } else {
      await plan.commitConfig?.(next);
    }
    return internalTransactionResult("success", next);
  } catch (cause) {
    const rollbackCauses: unknown[] = [];
    try {
      restoreConfigFile(snapshot);
    } catch (error) {
      rollbackCauses.push(error);
    }
    try {
      restoreRelevantEnv(snapshot, environment);
    } catch (error) {
      rollbackCauses.push(error);
    }
    try {
      if (reloadBegan && plan.reload) await plan.reload(snapshot.cfg);
      else await plan.commitConfig?.(snapshot.cfg);
    } catch (error) {
      rollbackCauses.push(error);
    }
    const rollbackCause = rollbackCauses.length
      ? (rollbackCauses.length === 1 ? rollbackCauses[0] : new AggregateError(rollbackCauses, "configuration rollback failed"))
      : undefined;
    return internalTransactionResult(
      rollbackCause === undefined ? "rolled_back" : "unknown",
      snapshot.cfg,
      cause,
      rollbackCause,
    );
  }
}

/** Fixed public shape for a failed transaction. Never pass internal causes or
 * provider/config paths through the HTTP boundary. */
export function publicConfigTransactionFailure(outcome: ConfigTransactionOutcome): {
  error: "configuration transaction failed";
  outcome: Exclude<ConfigTransactionOutcome, "success">;
} {
  if (outcome === "success") throw new Error("successful transactions have no public failure");
  return { error: "configuration transaction failed", outcome };
}

/** Env names of every workspace credential this process may be holding —
 * injected at boot by the desktop shell or exported by a developer. Spawned
 * engine CLIs must never inherit them: the one driver that consumes a given
 * secret receives it through instanceConfigs() narrowing, and to every other
 * child these are someone else's keys riding along in `...process.env`. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENMAUSBOT_NVIDIA_API_KEY",
  "OPENMAUSBOT_OPENROUTER_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
  // Ambient desktop/tool credentials observed in the parent environment.
  // No engine driver owns these, so forwarding them only exposes unrelated
  // secrets to model-invoked shell commands such as `Get-ChildItem env:`.
  "API_KEY_21ST",
  "API_KEY_SECRET",
] as const;

/** Drop every workspace credential from a child-process env (in place). */
export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENMAUSBOT_ENDPOINT_")) delete env[key];
  }
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
}

/** Env names a provider CLI might read as its own billing identity. A spawned
 * engine keeps only what its driver explicitly allows: a foreign key riding
 * along in `...process.env` must not flip a subscription CLI onto
 * pay-as-you-go billing the user never granted. */
export const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: JsonObject = {};
  try {
    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (parsed.success) {
      const sanitized = sanitizeStoredCustomEndpointUrls(parsed.data);
      if (isJsonRecord(sanitized.value)) disk = sanitized.value;
    }
  } catch {
    /* first write */
  }
  const checkedPatch = appConfigSchema.partial().parse(patch);
  const storedProfiles = storedBrowserProfilesSchema.safeParse(disk.browserProfiles);
  if (storedProfiles.success) disk.browserProfiles = storedProfiles.data;
  for (const key of ["xai", "nvidia", "openrouter", "openaiCompat", "composio", "box", "opencodeGo", "tts", "imageGen", "profile", "rooms", "localVm", "features"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    const featureSection = key === "features"
      ? section as NonNullable<AppConfig["features"]>
      : undefined;
    if (featureSection?.antigravityProxy) {
      const currentProxy = jsonObjectSchema.safeParse(merged.antigravityProxy);
      const mergedProxy = {
        ...(currentProxy.success ? currentProxy.data : {}),
        ...featureSection.antigravityProxy,
      };
      merged.antigravityProxy = canonicalAntigravityProxySettings(mergedProxy);
      const { antigravityProxy: _ignored, ...otherFeatures } = featureSection;
      Object.assign(merged, otherFeatures);
    } else {
      Object.assign(merged, section);
    }
    disk[key] = merged;
  }
  if (checkedPatch.customEndpoints) {
    const current = jsonObjectSchema.safeParse(disk.customEndpoints);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    for (const [id, endpoint] of Object.entries(checkedPatch.customEndpoints)) {
      const previous = jsonObjectSchema.safeParse(merged[id]);
      merged[id] = { ...(previous.success ? previous.data : {}), ...endpoint };
    }
    disk.customEndpoints = merged;
  }
  if (checkedPatch.vps !== undefined) disk.vps = normalizeVpsConfig(checkedPatch.vps);
  if (checkedPatch.browserProfiles !== undefined) {
    const existingProfiles = new Map(
      (storedProfiles.success ? storedProfiles.data : []).map((profile) => [profile.id, profile]),
    );
    const nextProfiles: BrowserProfile[] = checkedPatch.browserProfiles.map((profile) => {
      const partitionId = existingProfiles.get(profile.id)?.partitionId;
      return partitionId ? { ...profile, partitionId } : profile;
    });
    const routingConflict = browserProfileReplacementConflict(
      storedProfiles.success ? storedProfiles.data : [],
      nextProfiles,
    );
    if (routingConflict) throw Object.assign(new Error(routingConflict), { status: 409 });
    disk.browserProfiles = nextProfiles;
  }
  if (checkedPatch.instances) {
    const currentInstances = jsonObjectSchema.safeParse(disk.instances);
    const diskInstances: JsonObject = currentInstances.success ? currentInstances.data : {};
    for (const [instanceId, entry] of Object.entries(checkedPatch.instances)) {
      const current = jsonObjectSchema.safeParse(diskInstances[instanceId]);
      const merged: JsonObject = current.success ? { ...current.data } : {};
      Object.assign(merged, entry);
      diskInstances[instanceId] = merged;
    }
    disk.instances = diskInstances;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
}

export function removeCustomEndpoint(id: string): void {
  const p = join(DATA_DIR, "config.json");
  let disk: JsonObject = {};
  try {
    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (parsed.success) {
      const sanitized = sanitizeStoredCustomEndpointUrls(parsed.data);
      if (isJsonRecord(sanitized.value)) disk = sanitized.value;
    }
  } catch {
    return;
  }
  const current = jsonObjectSchema.safeParse(disk.customEndpoints);
  if (!current.success || !Object.hasOwn(current.data, id)) return;
  const endpoints = { ...current.data };
  delete endpoints[id];
  disk.customEndpoints = endpoints;
  writeFileAtomic(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
}

/** Set one instance's `config.cli` ("" clears the override back to the
 * driver default). Creating the instance entry is fine — a config-less
 * entry rides driver.defaultConfig(). Returns false for unknown instances
 * when the fleet is explicitly configured. The returned map must stay
 * PERSISTABLE: instanceConfigs() injects credential env into consuming
 * drivers' entries for the live fleet, so those injected keys are stripped
 * back out before the map is returned — otherwise saving an override would
 * copy xai/box/opencodeGo secrets into the instances section of
 * config.json. */
export function withInstanceCli(
  cfg: AppConfig,
  instanceId: string,
  cli: string,
): InstanceCliUpdate {
  const next: AppConfig = structuredClone(cfg);
  const map = instanceConfigs(next);
  // hasOwn, not truthiness: map is a plain object literal, so
  // map["__proto__"] resolves to Object.prototype — truthy — and the
  // assignment below would poison EVERY object in the process (instanceId
  // comes off the URL, where `__proto__` passes the route's [\w.-]+ regex)
  if (!Object.hasOwn(map, instanceId)) return { ok: false, config: cfg };
  const entry = map[instanceId];
  const cliKey = cli.trim();
  const currentConfig = jsonObjectSchema.safeParse(entry.config);
  if (cliKey) {
    const nextConfig: JsonObject = currentConfig.success ? { ...currentConfig.data } : {};
    nextConfig.cli = cliKey;
    entry.config = nextConfig;
  } else if (currentConfig.success && Object.hasOwn(currentConfig.data, "cli")) {
    const rest = { ...currentConfig.data };
    delete rest.cli;
    entry.config = Object.keys(rest).length ? rest : undefined;
  }
  for (const e of Object.values(map)) {
    if (!e.environment) continue;
    const injected = injectedEnvironment(next, e.driver);
    for (const [k, v] of Object.entries(e.environment)) {
      if (injected.get(k) === v) delete e.environment[k];
    }
    if (!Object.keys(e.environment).length) delete e.environment;
  }
  next.instances = map;
  return { ok: true, config: next };
}

interface InstanceCliUpdate {
  ok: boolean;
  config: AppConfig;
}

/** The credential env instanceConfigs() injects for one driver — shared with
 * withInstanceCli() so the inject rule and the strip rule cannot drift apart.
 * Each secret goes only to the driver that actually reads it: the API-key
 * Grok driver reads XAI_API_KEY, the Computer driver reads BOX_TOKEN, and
 * OpenCode reads OPENCODE_API_KEY. Every other engine brings its own
 * login, so handing it a key it never uses would only put that key in the
 * environment of an unrelated child process. */
function injectedEnvironment(cfg: AppConfig, driver: string): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  if (driver === "codex" && cfg.nvidia?.apiKey) environment.set("OPENMAUSBOT_NVIDIA_API_KEY", cfg.nvidia.apiKey);
  if (driver === "codex" && cfg.openrouter?.apiKey) environment.set("OPENMAUSBOT_OPENROUTER_API_KEY", cfg.openrouter.apiKey);
  if (driver === "openai-compat" && cfg.openaiCompat?.key)
    environment.set("OPENAI_COMPAT_API_KEY", cfg.openaiCompat.key);
  if (driver === "openai-compat" && cfg.openaiCompat?.url)
    environment.set("OPENAI_COMPAT_URL", cfg.openaiCompat.url);
  if (driver === "boxAgent" && cfg.box?.token) environment.set("BOX_TOKEN", cfg.box.token);
  if (driver === "opencodeGo" && cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  if (driver === "opencodeGo") {
    for (const endpoint of Object.values(effectiveCustomEndpoints(cfg))) {
      const key = endpoint.apiKey || process.env[customEndpointKeyEnv(endpoint.id)];
      if (key) environment.set(customEndpointKeyEnv(endpoint.id), key);
    }
  }
  if (driver === "antigravityAgent") {
    environment.set(ANTIGRAVITY_NETWORK_ROUTE_ENV, antigravityNetworkRoute(cfg));
  }
  return environment;
}

export function loadBrowserProfileIdAliases(): ReadonlyMap<string, string> {
  try {
    const document = z.object({ browserProfiles: legacyBrowserProfilesSchema.optional() }).safeParse(
      parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")),
    );
    if (!document.success || !document.data.browserProfiles) return new Map();
    return migrateStoredBrowserProfiles(document.data.browserProfiles).aliases;
  } catch {
    return new Map();
  }
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars — but only into the
// driver that consumes each key (injectedEnvironment above).
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  //
  // Google rides `antigravityAgent` (the `agy` CLI), not `geminiAgent`:
  // Google retired Gemini CLI for the free/Pro/Ultra tiers on 2026-06-18
  // (developers.googleblog.com, "transitioning Gemini CLI to Antigravity
  // CLI"), so a default `gemini` instance could only ever show unavailable.
  // The driver stays registered for enterprise licences, which keep Gemini
  // CLI — `{"instances": {"gemini": {"driver": "geminiAgent"}}}` restores it.
  const DEFAULT_FLEET: InstanceConfigMap = {
    grok: { driver: "grokAgent" },
    kimi: { driver: "kimiAgent" },
    droid: { driver: "droidAgent" },
    cursor: { driver: "cursorAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    [ANTIGRAVITY_WORKER_A_INSTANCE_ID]: { driver: "antigravityAgent" },
    [ANTIGRAVITY_WORKER_B_INSTANCE_ID]: { driver: "antigravityAgent" },
    opencodeGo: { driver: "opencodeGo" },
    computer: { driver: "boxAgent" },
    openaiCompat: { driver: "openai-compat" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  };
  const CUSTOM_ONLY = {
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  } as const;
  // New default-fleet engines that existing product configs would otherwise
  // never see. Custom-only engines stay in CUSTOM_ONLY so a one-off test map
  // is not expanded, matching the claude/grok/codex product-fleet probe.
  const PRODUCT_FLEET_ADDITIONS = {
    cursor: { driver: "cursorAgent" },
    openaiCompat: { driver: "openai-compat" },
    ...CUSTOM_ONLY,
  } as const;
  const configured = cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : null;
  const map: InstanceConfigMap = configured ? { ...configured } : { ...DEFAULT_FLEET };
  const antigravityFleetIsConfigured = !configured
    || Object.hasOwn(configured, "antigravity")
    || Object.hasOwn(configured, ANTIGRAVITY_WORKER_A_INSTANCE_ID)
    || Object.hasOwn(configured, ANTIGRAVITY_WORKER_B_INSTANCE_ID);
  if (antigravityFleetIsConfigured) {
    const legacy = map.antigravity;
    delete map.antigravity;
    const workerEntry = (profile: "a" | "b", source: InstanceConfigMap[string] | undefined) => {
      const rawConfig = source?.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? source.config as Record<string, unknown>
        : {};
      return {
        ...(source ?? { driver: "antigravityAgent" }),
        driver: "antigravityAgent",
        displayName: ANTIGRAVITY_WORKER_LABELS[profile],
        config: {
          ...rawConfig,
          cli: antigravityWorkerCli(profile),
        },
      };
    };
    map[ANTIGRAVITY_WORKER_A_INSTANCE_ID] = workerEntry(
      "a",
      map[ANTIGRAVITY_WORKER_A_INSTANCE_ID] ?? legacy,
    );
    map[ANTIGRAVITY_WORKER_B_INSTANCE_ID] = workerEntry(
      "b",
      map[ANTIGRAVITY_WORKER_B_INSTANCE_ID] ?? legacy,
    );
  }
  // Product fleets pick up newly shipped engines. A one-off test/shadow map
  // (no claude/grok/codex) is left exactly as written.
  if (
    configured &&
    (Object.hasOwn(configured, "claude") || Object.hasOwn(configured, "grok") || Object.hasOwn(configured, "codex"))
  ) {
    for (const [id, entry] of Object.entries(PRODUCT_FLEET_ADDITIONS)) {
      if (!Object.hasOwn(map, id)) map[id] = { ...entry };
    }
  }
  // A custom endpoint is a first-class OpenMaus model source. Older
  // user-authored fleets may predate the OpenCode entry, so add the existing
  // OpenCode worker when an endpoint key is configured instead of requiring a
  // manual config migration. This does not create a new bot or carry chat
  // history; it only makes the already-registered worker selectable.
  const hasCustomEndpointKey = Object.values(effectiveCustomEndpoints(cfg)).some((endpoint) => Boolean(configuredEndpointKey(endpoint)));
  if (configured && hasCustomEndpointKey && !Object.hasOwn(map, "opencodeGo")) {
    map.opencodeGo = { driver: "opencodeGo" };
  }
  for (const [id, sourceEntry] of Object.entries(map)) {
    // Build a transient entry so credential and workspace defaults never
    // mutate the persisted instance configuration.
    const entry = { ...sourceEntry };
    map[id] = entry;
    const environment = { ...entry.environment };
    for (const [key, value] of injectedEnvironment(cfg, entry.driver)) environment[key] = value;
    entry.environment = environment;
    if (entry.driver === "opencodeGo") {
      const raw = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
        ? { ...(entry.config as Record<string, unknown>) }
        : {};
      raw.customEndpoints = customEndpointMetadata(effectiveCustomEndpoints(cfg));
      entry.config = raw;
    }
    // The driver URL is configuration, not a credential. Environment is
    // intentionally not consulted by ProviderRegistry when it decodes a
    // driver's config, so carry the workspace default into the transient
    // instance map while preserving a per-instance override.
    if (entry.driver === "openai-compat" && cfg.openaiCompat?.url) {
      const raw = entry.config;
      if (raw === undefined) {
        entry.config = { url: cfg.openaiCompat.url };
      } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const current = raw as Record<string, unknown>;
        if (typeof current.url !== "string" || !current.url.trim()) {
          entry.config = { ...current, url: cfg.openaiCompat.url };
        }
      }
    }
  }
  return map;
}
