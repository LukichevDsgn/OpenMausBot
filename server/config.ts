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

export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;

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
  /** Project key used for Sessions, catalog and agent tools. userId/sessionId
   * are non-secret local identifiers used to reuse one Composio Session. */
  composio: z.object({ apiKey: optionalText, userId: optionalText, sessionId: optionalText }).optional(),
  box: z.object({ token: optionalText }).optional(),
  vps: vpsConfigSchema.optional(),
  /** OpenCode Go key; persisted write-only and passed only to its child. */
  opencodeGo: z.object({ apiKey: optionalText }).optional(),
  /** OpenAI-compatible endpoints managed by the OpenCode ACP harness. */
  customEndpoints: customEndpointMapSchema.optional(),
  /** Voice credentials and the selected voice id. */
  tts: z.object({ key: optionalText, voice: optionalText }).optional(),
  /** Non-secret profile details shown in the sidebar. */
  profile: z.object({ name: optionalText, email: optionalText }).optional(),
  rooms: roomConfigSchema.optional(),
  instances: instanceConfigMapSchema.optional(),
});
const appConfigPatchSchema = appConfigSchema.omit({ instances: true });
const jsonObjectSchema = z.record(z.string(), z.json());

export interface AppConfig {
  xai?: { key?: string; url?: string };
  nvidia?: { apiKey?: string };
  openrouter?: { apiKey?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string };
  box?: { token?: string };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string };
  opencodeGo?: { apiKey?: string };
  customEndpoints?: Record<string, CustomEndpoint>;
  tts?: { key?: string; voice?: string };
  profile?: { name?: string; email?: string };
  rooms?: { turnTimeoutMinutes: number };
  instances?: InstanceConfigMap;
}
export type ConfigPatch = z.output<typeof appConfigPatchSchema>;

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

export function parseStoredConfig(value: JsonValue): AppConfig {
  const parsed = appConfigSchema.safeParse(sanitizeStoredCustomEndpointUrls(value).value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Invalid stored configuration"));
  return parsed.data;
}

export function parseConfigPatch(value: JsonValue): ConfigPatch {
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(schemaIssue(parsed.error, "Invalid configuration")), { status: 400 });
  }
  return parsed.data;
}

export function vpsSshAlias(cfg: AppConfig): string | null {
  return isValidSshAlias(cfg.vps?.sshAlias) ? cfg.vps.sshAlias : null;
}

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
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
  cfg.composio = { ...cfg.composio };
  if (process.env.COMPOSIO_API_KEY !== undefined) cfg.composio.apiKey = process.env.COMPOSIO_API_KEY;
  cfg.box = { ...cfg.box };
  if (process.env.BOX_TOKEN !== undefined) cfg.box.token = process.env.BOX_TOKEN;
  cfg.opencodeGo = { ...cfg.opencodeGo };
  if (process.env.OPENCODE_API_KEY !== undefined) cfg.opencodeGo.apiKey = process.env.OPENCODE_API_KEY;
  cfg.tts = { ...cfg.tts };
  if (process.env.OMB_TTS_KEY !== undefined) cfg.tts.key = process.env.OMB_TTS_KEY;
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
    [patch.composio?.apiKey, "COMPOSIO_API_KEY"],
    [patch.box?.token, "BOX_TOKEN"],
    [patch.opencodeGo?.apiKey, "OPENCODE_API_KEY"],
    [patch.tts?.key, "OMB_TTS_KEY"],
  ];
  for (const [value, name] of secrets) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
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
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
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
  for (const key of ["xai", "nvidia", "openrouter", "composio", "box", "opencodeGo", "tts", "profile", "rooms"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    Object.assign(merged, section);
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
 * OpenCode Go reads OPENCODE_API_KEY. Every other engine brings its own
 * login, so handing it a key it never uses would only put that key in the
 * environment of an unrelated child process. */
function injectedEnvironment(cfg: AppConfig, driver: string): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  if (driver === "codex" && cfg.nvidia?.apiKey) environment.set("OPENMAUSBOT_NVIDIA_API_KEY", cfg.nvidia.apiKey);
  if (driver === "codex" && cfg.openrouter?.apiKey) environment.set("OPENMAUSBOT_OPENROUTER_API_KEY", cfg.openrouter.apiKey);
  if (driver === "boxAgent" && cfg.box?.token) environment.set("BOX_TOKEN", cfg.box.token);
  if (driver === "opencodeGo" && cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  if (driver === "opencodeGo") {
    for (const endpoint of Object.values(effectiveCustomEndpoints(cfg))) {
      const key = endpoint.apiKey || process.env[customEndpointKeyEnv(endpoint.id)];
      if (key) environment.set(customEndpointKeyEnv(endpoint.id), key);
    }
  }
  return environment;
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
    antigravity: { driver: "antigravityAgent" },
    opencodeGo: { driver: "opencodeGo" },
    computer: { driver: "boxAgent" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
  };
  const CUSTOM_ONLY = {
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
  } as const;
  // New default-fleet engines that existing product configs would otherwise
  // never see. Custom-only engines stay in CUSTOM_ONLY so a one-off test map
  // is not expanded, matching the claude/grok/codex product-fleet probe.
  const PRODUCT_FLEET_ADDITIONS = {
    cursor: { driver: "cursorAgent" },
    ...CUSTOM_ONLY,
  } as const;
  const configured = cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : null;
  const map: InstanceConfigMap = configured ? { ...configured } : { ...DEFAULT_FLEET };
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
  for (const entry of Object.values(map)) {
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
  }
  return map;
}
