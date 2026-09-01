import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { execCliTree } from "./procs.ts";

const execFileAsync = promisify(execFile);
const BIN = `${process.env.USERPROFILE ?? ""}\\.openmausbot\\bin`;
const VAULT = `${BIN}\\agy-account-vault.exe`;
const QUOTA_CACHE_FILE = `${process.env.USERPROFILE ?? ""}\\.openmausbot\\antigravity-quota-cache.json`;

export type AntigravityProfile = "a" | "b";

export interface QuotaWindow {
  remaining: number;
  resetsAt: string | null;
}

export interface AntigravityAccountStatus {
  profile: AntigravityProfile;
  instanceId: string;
  label: string;
  email: string;
  active: boolean;
  available: boolean;
  quota: {
    gemini: { weekly: QuotaWindow | null; fiveHour: QuotaWindow | null };
    other: { weekly: QuotaWindow | null; fiveHour: QuotaWindow | null };
  };
  error?: string;
}

const PROFILES = {
  a: { instanceId: "antigravity-worker-a", label: "Antigravity A · Worker A", email: "lukichev.eng@gmail.com" },
  b: { instanceId: "antigravity-worker-b", label: "Antigravity B · Worker B", email: "necaja12@gmail.com" },
} as const;
const quotaCache = new Map<AntigravityProfile, AntigravityAccountStatus["quota"]>();
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

/** Parse tab-separated Antigravity usage output into the UI quota shape. */
export function parseAntigravityUsage(output: string) {
  const result = emptyQuota();
  for (const line of output.split(/\r?\n/)) {
    const columns = line.split("\t");
    if (columns.length < 4) continue;
    const [family, window, rawRemaining, resetsAt] = columns;
    const remaining = Number(rawRemaining.replace("%", ""));
    if (!Number.isFinite(remaining)) continue;
    const target = family === "Gemini Models" ? result.gemini : family === "Claude and GPT models" ? result.other : null;
    if (!target) continue;
    const value = { remaining, resetsAt: resetsAt || null };
    if (window === "Weekly Limit Remaining") target.weekly = value;
    if (window === "Five Hour Limit Remaining") target.fiveHour = value;
  }
  return result;
}

/** Invoke the local account vault with bounded Windows process settings. */
async function runVault(...args: string[]) {
  return execFileAsync(VAULT, args, { windowsHide: true, timeout: 10_000, encoding: "utf8" });
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
async function accountStatusesUnlocked(refresh: boolean): Promise<AntigravityAccountStatus[]> {
  const originallyActive = await activeAntigravityProfile();
  const statuses: AntigravityAccountStatus[] = [];
  for (const profile of ["a", "b"] as const) {
    const meta = PROFILES[profile];
    const cached = quotaCache.get(profile) ?? emptyQuota();
    try {
      await runVault("exists", profile);
    } catch (error) {
      statuses.push({
        profile, ...meta, active: originallyActive === profile, available: false,
        quota: cached,
        error: error instanceof Error ? error.message : String(error),
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
        const launcher = `${BIN}\\agy-worker-${profile}.exe`;
        const { stdout } = await execCliTree(launcher, ["--print", "/usage"], {
          windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
        });
        quota = parseAntigravityUsage(stdout);
        quotaCache.set(profile, quota);
        saveQuotaCache();
      } catch (error) {
        // A quota request can be rejected by region, VPN, rate limit or OAuth
        // without making the launcher/profile disappear. Keep the last known
        // good quota and report the refresh failure separately.
        refreshError = error instanceof Error ? error.message : String(error);
      }
    }
    const status: AntigravityAccountStatus = {
      profile, ...meta, active: originallyActive === profile, available: true, quota,
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
export async function antigravityAccountStatuses(refresh = false): Promise<AntigravityAccountStatus[]> {
  if (!refresh) return accountStatusesUnlocked(false);
  return withAntigravityAccountRefreshSingleFlight(() =>
    withAntigravityCredentialLock(() =>
      withManagedAntigravityQuotaRefresh(() => accountStatusesUnlocked(true)),
    ),
  );
}

/** Refresh the selected profile. Antigravity auth is global, so activation is
 * required even though each launcher supplies an isolated USERPROFILE. */
export async function refreshAntigravityProfileQuota(profile: AntigravityProfile): Promise<void> {
  return withAntigravityCredentialLock(() =>
    withManagedAntigravityQuotaRefresh(async () => {
      const launcher = `${BIN}\\agy-worker-${profile}.exe`;
      const { stdout } = await execCliTree(launcher, ["--print", "/usage"], {
        windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      quotaCache.set(profile, parseAntigravityUsage(stdout));
      saveQuotaCache();
    }),
  );
}

/** Map a server instance id to its isolated Antigravity account profile. */
export function profileForInstance(instanceId: string): AntigravityProfile | null {
  if (instanceId === PROFILES.a.instanceId) return "a";
  if (instanceId === PROFILES.b.instanceId) return "b";
  return null;
}
