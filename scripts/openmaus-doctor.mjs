import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8799";
const STATUS_PATHS = ["/api/status-capsule", "/api/status", "/api/capsule"];
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/i;

function check(level, name, message, details = {}) {
  return { level, name, message, ...details };
}

function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("endpoint must be an HTTP localhost URL");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return { value: JSON.parse(text), text };
  } catch {
    return { value: undefined, text };
  }
}

async function fetchJson(fetcher, url, timeoutMs) {
  let response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
  const body = await readResponse(response);
  return { kind: "response", response, ...body };
}

function digestPair(value, names) {
  const values = names.map((name) => value?.[name]).filter((item) => item !== undefined && item !== null);
  if (values.some((item) => typeof item !== "string" || !DIGEST.test(item))) return { invalid: true };
  return { values };
}

function inspectStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid JSON object";
  const app = value.app ?? value.identity?.app;
  if (app !== undefined && app !== "openmausbot") return "wrong app identity";
  if (value.ready !== undefined && value.ready !== true) return "ready=false";
  if (value.identity?.ready !== undefined && value.identity.ready !== true) return "ready=false";
  const source = digestPair(value, ["sourceSha256", "source_sha256"]);
  const build = digestPair(value, ["buildSha256", "build_sha256", "dualViewSha256", "dual_view_sha256"]);
  if (source.invalid || build.invalid) return "invalid source/build digest";
  if (source.values.length && build.values.length && source.values[0].toLowerCase() !== build.values[0].toLowerCase()) {
    return "source/build digest mismatch";
  }
  return null;
}

// The hash is computed once above; keeping this helper separate makes watch checks
// read-only and deliberately prevents any baseline file or state from being written.
async function watchFileWithDigest(file) {
  const path = resolve(file);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return check("FAIL", "watch", `${file}: not a regular file`, { path });
    const hash = createHash("sha256");
    await new Promise((resolvePromise, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolvePromise);
    });
    const sha256 = hash.digest("hex");
    return check("PASS", "watch", `${basename(file)} sha256=${sha256}`, { path, sha256 });
  } catch (error) {
    return check("FAIL", "watch", `${file}: unreadable`, { path, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function runDoctor({ endpoint = DEFAULT_ENDPOINT, watches = [], fetcher = fetch, timeoutMs = 2_000 } = {}) {
  const checks = [];
  let base;
  try {
    base = localEndpoint(endpoint);
    checks.push(check("PASS", "endpoint", `local endpoint ${base.origin}`));
  } catch (error) {
    checks.push(check("FAIL", "endpoint", error instanceof Error ? error.message : String(error)));
    return { endpoint, checks, exitCode: 2 };
  }

  const health = await fetchJson(fetcher, `${base.origin}/api/health`, timeoutMs);
  if (health.kind === "unreachable") {
    checks.push(check("FAIL", "health", "unreachable endpoint", { state: "unreachable" }));
  } else if (!health.response.ok) {
    checks.push(check("FAIL", "health", `HTTP ${health.response.status}`, { state: "http_error", status: health.response.status }));
  } else if (health.value === undefined) {
    checks.push(check("FAIL", "health", "invalid JSON", { state: "invalid_json" }));
  } else if (health.value.app !== "openmausbot") {
    checks.push(check("FAIL", "health", "wrong app identity", { state: "wrong_identity", observed: health.value.app ?? null }));
  } else if (health.value.ready === false) {
    checks.push(check("WARN", "health", "app identity is valid but ready=false", { state: "degraded", pid: health.value.pid ?? null }));
  } else {
    checks.push(check("PASS", "health", "OpenMausBot identity confirmed", { state: "ready", pid: health.value.pid ?? null }));
  }

  let statusSeen = false;
  for (const path of STATUS_PATHS) {
    const result = await fetchJson(fetcher, `${base.origin}${path}`, timeoutMs);
    if (result.kind === "unreachable") continue;
    if (result.response.status === 404) continue;
    statusSeen = true;
    if (!result.response.ok) checks.push(check("FAIL", "status", `${path}: HTTP ${result.response.status}`, { path, state: "http_error", status: result.response.status }));
    else if (result.value === undefined) checks.push(check("FAIL", "status", `${path}: invalid JSON`, { path, state: "invalid_json" }));
    else {
      const problem = inspectStatus(result.value);
      checks.push(problem ? check("FAIL", "status", `${path}: ${problem}`, { path, state: "invalid_effect" }) : check("PASS", "status", `${path}: identity/readiness/digests valid`, { path, state: "valid" }));
    }
    break;
  }
  if (!statusSeen) checks.push(check("INFO", "status", "status/capsule endpoint unavailable", { state: "unknown" }));
  for (const file of watches) checks.push(await watchFileWithDigest(file));

  const exitCode = checks.some((item) => item.level === "FAIL") ? 2 : checks.some((item) => item.level === "WARN") ? 1 : 0;
  return { endpoint: base.origin, checks, exitCode };
}

export function parseArgs(argv) {
  const options = { endpoint: DEFAULT_ENDPOINT, watches: [], json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--endpoint") options.endpoint = argv[++i] ?? "";
    else if (arg === "--watch") options.watches.push(argv[++i] ?? "");
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.json && options.quiet) throw new Error("--json and --quiet cannot be combined");
  return options;
}

export function renderReport(report, { json = false, quiet = false } = {}) {
  if (json) return JSON.stringify(report);
  const rows = report.checks.filter((item) => !quiet || item.level === "FAIL" || item.level === "WARN");
  return rows.length ? rows.map((item) => `${item.level} ${item.name}: ${item.message}`).join("\n") : "OK";
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL args: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  const report = await runDoctor(options);
  console.log(renderReport(report, options));
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
