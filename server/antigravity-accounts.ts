import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execCliTree } from "./procs.ts";

const execFileAsync = promisify(execFile);
const BIN = `${process.env.USERPROFILE ?? ""}\\.openmausbot\\bin`;
const QUOTA_CACHE_FILE = `${process.env.USERPROFILE ?? ""}\\.openmausbot\\antigravity-quota-cache.json`;
const ACCOUNT_LABELS_FILE = `${process.env.USERPROFILE ?? ""}\\.openmausbot\\antigravity-account-labels.json`;
const QUOTA_PROBE_ARGS = ["--print", "/usage", "--output-format", "json"] as const;
const ACCOUNT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const NETWORK_ROUTE_ENV = "OPENMAUSBOT_ANTIGRAVITY_NETWORK_ROUTE";

export type AntigravityProfile = "a" | "b";

export interface QuotaWindow {
  remaining: number;
  resetsAt: string | null;
}

export interface AntigravityAccountStatus {
  profile: AntigravityProfile;
  instanceId: string;
  label: string;
  /** Optional sanitized account label returned by the runtime probe. */
  email?: string;
  active: boolean;
  available: boolean;
  quota: {
    gemini: { weekly: QuotaWindow | null; fiveHour: QuotaWindow | null };
    other: { weekly: QuotaWindow | null; fiveHour: QuotaWindow | null };
  };
  quotaStale?: boolean;
  error?: string;
}

const PROFILES = {
  a: { instanceId: "antigravity-worker-a", label: "Antigravity A · Worker A" },
  b: { instanceId: "antigravity-worker-b", label: "Antigravity B · Worker B" },
} as const;

/** Read optional private labels from the user's local OpenMaus data. The file
 * is intentionally outside the repository so account addresses never become
 * source defaults or PR content. Malformed values fall back to Worker A/B. */
export function readAntigravityAccountEmail(profile: AntigravityProfile): string | undefined {
  try {
    const labels = JSON.parse(readFileSync(ACCOUNT_LABELS_FILE, "utf8")) as Record<string, unknown>;
    const value = labels[profile];
    if (typeof value !== "string") return undefined;
    const email = value.trim();
    return email.length <= 320 && ACCOUNT_EMAIL_RE.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

function profileMeta(profile: AntigravityProfile) {
  const email = readAntigravityAccountEmail(profile);
  return email ? { ...PROFILES[profile], email } : PROFILES[profile];
}

/** Resolve account helpers from the running packaged build first. The user
 * bin is only a development/legacy fallback; letting stale copies win makes
 * model turns use one launcher while quota refresh silently uses another. */
export function antigravityHelperPath(
  name: "agy-account-vault.exe" | "agy-worker-a.exe" | "agy-worker-b.exe",
): string {
  const packaged = process.env.OMB_RESOURCES_PATH
    ? join(process.env.OMB_RESOURCES_PATH, "antigravity", name)
    : null;
  return packaged && existsSync(packaged) ? packaged : `${BIN}\\${name}`;
}

function launcherForProfile(profile: AntigravityProfile): string {
  return antigravityHelperPath(`agy-worker-${profile}.exe`);
}
const quotaCache = new Map<AntigravityProfile, AntigravityAccountStatus["quota"]>();
const quotaRefreshFailures = new Set<AntigravityProfile>();
let credentialQueue: Promise<void> = Promise.resolve();
let managedQuotaRefreshes = 0;
let accountRefreshInFlight: Promise<AntigravityAccountStatus[]> | null = null;
const managedWorkerProcesses = new Set<number>();

/** Track only Antigravity process trees launched by this OpenMaus server.
 * A plain `agy.exe` process check cannot distinguish one of our workers from
 * a standalone terminal, which made quota refresh show a false OAuth-race
 * warning while Worker A/B was doing normal delegated work. */
export function registerManagedAntigravityWorker(pid: number | undefined): void {
  if (pid && Number.isInteger(pid) && pid > 0) managedWorkerProcesses.add(pid);
}

/** Remove a worker process from the server-owned Antigravity set. */
export function unregisterManagedAntigravityWorker(pid: number | undefined): void {
  if (pid) managedWorkerProcesses.delete(pid);
}

/** Report whether an OpenMaus-managed Antigravity worker is still running. */
export function antigravityManagedWorkerRunning(): boolean {
  return managedWorkerProcesses.size > 0;
}

/** Antigravity stores OAuth in one machine-wide credential target. Every
 * activate/use/capture sequence must therefore be atomic across HTTP calls. */
export function withAntigravityCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = credentialQueue.then(operation, operation);
  credentialQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Report whether account quota telemetry currently owns the credential lane. */
export function antigravityManagedQuotaRefreshRunning(): boolean {
  return managedQuotaRefreshes > 0 || accountRefreshInFlight !== null;
}

/** Run one quota operation while exposing its in-flight state to callers. */
export async function withManagedAntigravityQuotaRefresh<T>(operation: () => Promise<T>): Promise<T> {
  managedQuotaRefreshes += 1;
  try {
    return await operation();
  } finally {
    managedQuotaRefreshes -= 1;
  }
}

/** Coalesce concurrent account status refreshes into one promise. */
export function withAntigravityAccountRefreshSingleFlight(
  operation: () => Promise<AntigravityAccountStatus[]>,
): Promise<AntigravityAccountStatus[]> {
  if (accountRefreshInFlight) return accountRefreshInFlight;
  const request = operation();
  const tracked = request.finally(() => {
    if (accountRefreshInFlight === tracked) accountRefreshInFlight = null;
  });
  accountRefreshInFlight = tracked;
  return tracked;
}

/** Create an empty quota shape for accounts without cached usage data. */
function emptyQuota(): AntigravityAccountStatus["quota"] {
  return {
    gemini: { weekly: null, fiveHour: null },
    other: { weekly: null, fiveHour: null },
  };
}

export function nextAntigravityQuotaStaleState(
  current: boolean,
  outcome: "unchanged" | "success" | "failure",
): boolean {
  if (outcome === "failure") return true;
  if (outcome === "success") return false;
  return current;
}

function recordAntigravityQuotaRefresh(
  profile: AntigravityProfile,
  outcome: "success" | "failure",
): void {
  const stale = nextAntigravityQuotaStaleState(quotaRefreshFailures.has(profile), outcome);
  if (stale) quotaRefreshFailures.add(profile);
  else quotaRefreshFailures.delete(profile);
}

/** Load cached account quotas, ignoring missing or malformed cache files. */
function loadQuotaCache() {
  try {
    // SAFETY: every entry is validated by profile key before being placed in
    // the in-memory cache; malformed JSON is discarded by this try/catch.
    const saved = JSON.parse(readFileSync(QUOTA_CACHE_FILE, "utf8")) as Partial<Record<AntigravityProfile, AntigravityAccountStatus["quota"]>>;
    for (const profile of ["a", "b"] as const) {
      if (saved[profile]) quotaCache.set(profile, saved[profile]);
    }
  } catch {
    // First run or an invalid old cache: report unknown quotas without mutation.
  }
}

/** Persist the last known quota values for the two Antigravity profiles. */
function saveQuotaCache() {
  mkdirSync(dirname(QUOTA_CACHE_FILE), { recursive: true });
  writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(Object.fromEntries(quotaCache), null, 2), "utf8");
}

loadQuotaCache();

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function readFiniteFraction(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  return null;
}

function readUsageGroups(payload: unknown): unknown[] {
  const root = asRecord(payload);
  if (!root) throw new Error("Antigravity usage response is not an object");

  const command = asRecord(root.command);
  if (command && command.name !== "usage") throw new Error("Antigravity usage response is not the usage command");

  const candidates = [
    command?.data,
    root.data,
    root.response,
    root,
  ];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (Array.isArray(record?.groups)) return record.groups;
  }
  throw new Error("Antigravity usage response has no quota groups");
}

function readUsageFraction(bucket: JsonRecord): number | null {
  const remaining = asRecord(bucket.remaining);
  return readFiniteFraction(
    bucket.remaining_fraction,
    bucket.remainingFraction,
    remaining?.remaining_fraction,
    remaining?.remainingFraction,
  );
}

function readResetAt(bucket: JsonRecord): string | null {
  const value = bucket.reset_time ?? bucket.resetTime;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readQuotaWindow(bucket: unknown): "weekly" | "fiveHour" | null {
  const record = asRecord(bucket);
  if (!record) return null;
  const hint = [record.window, record.id, record.bucketId, record.displayName]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (hint.includes("weekly") || hint.includes("week")) return "weekly";
  if (hint.includes("5h") || hint.includes("five hour") || hint.includes("five-hour")) return "fiveHour";
  return null;
}

/** Parse the documented structured, read-only Antigravity usage response. */
export function parseAntigravityUsage(output: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(output.trim());
  } catch {
    throw new Error("Antigravity usage response is not valid JSON");
  }

  const root = asRecord(payload);
  const usage = asRecord(root?.usage);
  if (usage) {
    const tokenCounts = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"]
      .map((key) => usage[key]);
    if (tokenCounts.some((value) => typeof value === "number" && value !== 0)) {
      throw new Error("Antigravity usage response describes an agent turn");
    }
  }

  const result = emptyQuota();
  const seen = new Set<string>();
  for (const group of readUsageGroups(payload)) {
    const groupRecord = asRecord(group);
    const family = groupRecord?.name ?? groupRecord?.displayName;
    const target = family === "Gemini Models" ? result.gemini : family === "Claude and GPT models" ? result.other : null;
    if (!target) continue;
    const buckets = groupRecord?.buckets;
    if (!Array.isArray(buckets)) continue;
    for (const bucket of buckets) {
      const window = readQuotaWindow(bucket);
      const record = asRecord(bucket);
      const fraction = record ? readUsageFraction(record) : null;
      if (!window || !record || fraction === null) continue;
      if (seen.has(`${family}:${window}`)) throw new Error("Antigravity usage response has duplicate quota windows");
      seen.add(`${family}:${window}`);
      target[window] = { remaining: Math.round(fraction * 100), resetsAt: readResetAt(record) };
    }
  }

  if (seen.size !== 4) throw new Error("Antigravity usage response is incomplete");
  return result;
}

function hasCompleteAntigravityUsage(stdout: string): boolean {
  try {
    parseAntigravityUsage(stdout);
    return true;
  } catch {
    return false;
  }
}

/** Invoke the local account vault with bounded Windows process settings. */
async function runVault(...args: string[]) {
  return execFileAsync(antigravityHelperPath("agy-account-vault.exe"), args, {
    windowsHide: true,
    timeout: 10_000,
    encoding: "utf8",
  });
}

/** Read the currently active Antigravity profile, or null when unavailable. */
export async function activeAntigravityProfile(): Promise<AntigravityProfile | null> {
  try {
    const { stdout } = await runVault("which");
    const profile = stdout.trim();
    return profile === "a" || profile === "b" ? profile : null;
  } catch {
    return null;
  }
}

/** Activate one of the two machine-wide Antigravity credential profiles. */
export async function activateAntigravityProfile(profile: AntigravityProfile): Promise<void> {
  await runVault("activate", profile);
}

/** Detect any running Antigravity CLI process without throwing on probe failure. */
export async function antigravityProcessRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FI", "IMAGENAME eq agy.exe", "/NH"], {
      windowsHide: true, timeout: 5_000, encoding: "utf8",
    });
    return /\bagy\.exe\b/i.test(stdout);
  } catch {
    return true;
  }
}

/** Collect both account statuses while preserving the originally active profile. */
function quotaProbeEnvironment(networkRoute?: string): NodeJS.ProcessEnv {
  return networkRoute
    ? { ...process.env, [NETWORK_ROUTE_ENV]: networkRoute }
    : process.env;
}

async function accountStatusesUnlocked(
  refresh: boolean,
  networkRoute?: string,
): Promise<AntigravityAccountStatus[]> {
  const originallyActive = await activeAntigravityProfile();
  const statuses: AntigravityAccountStatus[] = [];
  for (const profile of ["a", "b"] as const) {
    const meta = profileMeta(profile);
    const cached = quotaCache.get(profile) ?? emptyQuota();
    try {
      await runVault("exists", profile);
    } catch {
      statuses.push({
        profile, ...meta, active: originallyActive === profile, available: false,
        quota: cached,
        quotaStale: quotaRefreshFailures.has(profile),
        error: "Account helper is unavailable.",
      });
      continue;
    }

    let quota = cached;
    let refreshError: string | undefined;
    if (refresh) {
      try {
        // The profile launcher owns the complete activate -> agy -> capture
        // sequence under a machine-wide mutex. Doing either credential copy
        // here would race a live wrapper between its own atomic operations.
        const launcher = launcherForProfile(profile);
        const { stdout } = await execCliTree(launcher, [...QUOTA_PROBE_ARGS], {
          windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
          env: quotaProbeEnvironment(networkRoute),
          completionPredicate: (output) => hasCompleteAntigravityUsage(output),
        });
        quota = parseAntigravityUsage(stdout);
        quotaCache.set(profile, quota);
        recordAntigravityQuotaRefresh(profile, "success");
        saveQuotaCache();
      } catch {
        // A quota request can be rejected by region, VPN, rate limit or OAuth
        // without making the launcher/profile disappear. Keep the last known
        // good quota and report the refresh failure separately.
        recordAntigravityQuotaRefresh(profile, "failure");
        refreshError = "Quota refresh failed.";
      }
    }
    const status: AntigravityAccountStatus = {
      profile, ...meta, active: originallyActive === profile, available: true, quota,
      quotaStale: quotaRefreshFailures.has(profile),
    };
    if (refreshError) status.error = refreshError;
    statuses.push(status);
  }
  // Quota inspection is read-only from the user's perspective. Put back the
  // account that was selected before the sequential A/B probes.
  if (refresh && originallyActive) {
    try {
      await activateAntigravityProfile(originallyActive);
    } catch {
      // Quota telemetry must not turn a successful response into an HTTP 500.
    }
  }
  return statuses;
}

/** Return cached statuses or perform a serialized A/B quota refresh. */
export async function antigravityAccountStatuses(
  refresh = false,
  networkRoute?: string,
): Promise<AntigravityAccountStatus[]> {
  if (!refresh) return accountStatusesUnlocked(false, networkRoute);
  return withAntigravityAccountRefreshSingleFlight(() =>
    withAntigravityCredentialLock(() =>
      withManagedAntigravityQuotaRefresh(() => accountStatusesUnlocked(true, networkRoute)),
    ),
  );
}

/** Refresh the selected profile. Antigravity auth is global, so activation is
 * required even though each launcher supplies an isolated USERPROFILE. */
export async function refreshAntigravityProfileQuota(
  profile: AntigravityProfile,
  networkRoute?: string,
): Promise<void> {
  return withAntigravityCredentialLock(() =>
    withManagedAntigravityQuotaRefresh(async () => {
      const launcher = launcherForProfile(profile);
      try {
        const { stdout } = await execCliTree(launcher, [...QUOTA_PROBE_ARGS], {
          windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
          env: quotaProbeEnvironment(networkRoute),
          completionPredicate: (output) => hasCompleteAntigravityUsage(output),
        });
        quotaCache.set(profile, parseAntigravityUsage(stdout));
        recordAntigravityQuotaRefresh(profile, "success");
        saveQuotaCache();
      } catch (error) {
        recordAntigravityQuotaRefresh(profile, "failure");
        throw error;
      }
    }),
  );
}

/** Map a server instance id to its isolated Antigravity account profile. */
export function profileForInstance(instanceId: string): AntigravityProfile | null {
  if (instanceId === PROFILES.a.instanceId) return "a";
  if (instanceId === PROFILES.b.instanceId) return "b";
  return null;
}
