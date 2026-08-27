const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WINDOWS_PROBE_ENV = Object.freeze({
  CUA_DRIVER_RS_UPDATE_CHECK: "false",
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
});
const WINDOWS_MANIFEST_ARGS = ["manifest", "--json"];
const WINDOWS_DRIVER_FILE_IDENTITY_KEYS = ["sha256", "size", "mtimeNs", "ctimeNs"];

function candidateRecords({
  env = process.env,
  resourcesPath = "",
  homeDir = "",
  packaged = false,
} = {}) {
  const candidates = [];
  if (env.CUA_DRIVER_PATH) candidates.push({ path: env.CUA_DRIVER_PATH, source: "environment" });
  if (packaged && resourcesPath) {
    candidates.push({ path: path.join(resourcesPath, "cua-driver.exe"), source: "bundled" });
  }

  const localAppData =
    env.LOCALAPPDATA || (homeDir ? path.join(homeDir, "AppData", "Local") : "");
  if (localAppData) {
    candidates.push({
      path: path.join(localAppData, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe"),
      source: "user-local",
    });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function windowsDriverCandidates(options = {}) {
  return candidateRecords(options).map((candidate) => candidate.path);
}

function isAbsoluteWindowsPath(value) {
  return typeof value === "string" && (path.win32.isAbsolute(value) || path.posix.isAbsolute(value));
}

function canonicalRegularFile(candidate, fileSystem) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const absolute = isAbsoluteWindowsPath(candidate) ? candidate : path.resolve(candidate);
  const realpathSync = fileSystem.realpathSync;
  const canonical =
    typeof realpathSync?.native === "function"
      ? realpathSync.native(absolute)
      : typeof realpathSync === "function"
        ? realpathSync(absolute)
        : absolute;
  if (!isAbsoluteWindowsPath(canonical)) return null;
  const stat = fileSystem.statSync(canonical);
  return stat && typeof stat.isFile === "function" && stat.isFile() ? canonical : null;
}

function resolveWindowsDriverCandidate(options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  for (const candidate of candidateRecords(options)) {
    try {
      const canonical = canonicalRegularFile(candidate.path, fileSystem);
      if (canonical) return { path: canonical, source: candidate.source };
    } catch {
      // A broken candidate is skipped so the documented priority can continue.
    }
  }
  return null;
}

function resolveWindowsDriverBinary(options = {}) {
  return resolveWindowsDriverCandidate(options)?.path ?? null;
}

function statString(stat, key, fallbackKey) {
  const value = stat[key] ?? (fallbackKey ? stat[fallbackKey] : undefined);
  if (value === undefined || value === null) throw new Error(`driver stat missing ${key}`);
  return String(value);
}

function defaultHashFile(file, fileSystem) {
  return crypto.createHash("sha256").update(fileSystem.readFileSync(file)).digest("hex");
}

function captureWindowsDriverIdentity(binary, {
  fileSystem = fs,
  hashFile = defaultHashFile,
} = {}) {
  const canonical = canonicalRegularFile(binary, fileSystem);
  if (!canonical) throw new Error("cua-driver path is not a canonical regular file");
  const stat = fileSystem.statSync(canonical, { bigint: true });
  const sha256 = String(hashFile(canonical, fileSystem)).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("cua-driver hash is not SHA-256");
  return {
    path: canonical,
    fileIdentity: {
      sha256,
      size: statString(stat, "size"),
      mtimeNs: statString(stat, "mtimeNs", "mtimeMs"),
      ctimeNs: statString(stat, "ctimeNs", "ctimeMs"),
    },
  };
}

function validWindowsDriverFileIdentity(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === WINDOWS_DRIVER_FILE_IDENTITY_KEYS.length &&
    WINDOWS_DRIVER_FILE_IDENTITY_KEYS.every(
      (key) => typeof value[key] === "string" &&
        (key === "sha256" ? /^[0-9a-f]{64}$/i.test(value[key]) : /^\d+$/.test(value[key])),
    );
}

function sameWindowsDriverFileIdentity(expected, actual) {
  return validWindowsDriverFileIdentity(expected) &&
    WINDOWS_DRIVER_FILE_IDENTITY_KEYS.every((key) => expected[key] === actual[key]);
}

function runWindowsProbe(binary, args, {
  spawnSync,
  env,
  timeout,
} = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: { ...env, ...WINDOWS_PROBE_ENV },
  });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      reason: result.stderr?.trim() || `cua-driver ${args[0]} exited ${result.status}`,
    };
  }
  return { ok: true, stdout: String(result.stdout ?? "") };
}

function observedVersion(stdout) {
  const match = String(stdout ?? "").trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match?.[1] ?? null;
}

function parseManifest(stdout, binary, version) {
  let manifest;
  try {
    manifest = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "cua-driver manifest returned invalid JSON" };
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schema_version !== "1" ||
    manifest.binary_version !== version
  ) {
    return { ok: false, reason: "cua-driver manifest schema or version mismatch" };
  }
  const invocation = manifest.mcp_invocation;
  if (
    !invocation ||
    typeof invocation !== "object" ||
    Array.isArray(invocation) ||
    Object.keys(invocation).length !== 2 ||
    !Object.keys(invocation).every((key) => ["command", "args"].includes(key)) ||
    invocation.command !== binary ||
    !Array.isArray(invocation.args) ||
    invocation.args.length !== 1 ||
    invocation.args[0] !== "mcp"
  ) {
    return { ok: false, reason: "cua-driver manifest MCP invocation mismatch" };
  }
  return { ok: true, manifestSchema: manifest.schema_version };
}

function probeDoctor(binary, options) {
  const result = runWindowsProbe(binary, ["doctor", "--json"], options);
  if (!result.ok) return result;
  try {
    const report = JSON.parse(result.stdout);
    return report?.ok === true
      ? { ok: true }
      : { ok: false, reason: "cua-driver doctor reported an unavailable desktop" };
  } catch {
    return { ok: false, reason: "cua-driver doctor returned invalid JSON" };
  }
}

function probeWindowsDriver(binary, {
  spawnSync = require("node:child_process").spawnSync,
  env = process.env,
  timeout = 10_000,
  fileSystem = fs,
  hashFile = defaultHashFile,
  source = "environment",
  manifestArgs = WINDOWS_MANIFEST_ARGS,
} = {}) {
  const probeOptions = { spawnSync, env, timeout };
  let before;
  try {
    before = captureWindowsDriverIdentity(binary, { fileSystem, hashFile });
  } catch (error) {
    return { ok: false, fatal: true, reason: error.message };
  }
  if (before.path !== binary) {
    return { ok: false, fatal: true, reason: "cua-driver path is not canonical" };
  }

  const versionProbe = runWindowsProbe(binary, ["--version"], probeOptions);
  if (!versionProbe.ok) return { ok: false, fatal: true, reason: versionProbe.reason };
  const version = observedVersion(versionProbe.stdout);
  if (!version) return { ok: false, fatal: true, reason: "cua-driver --version returned an invalid version" };

  const manifestProbe = runWindowsProbe(binary, manifestArgs, probeOptions);
  if (!manifestProbe.ok) return { ok: false, fatal: true, reason: manifestProbe.reason };
  const manifest = parseManifest(manifestProbe.stdout, binary, version);
  if (!manifest.ok) return { ok: false, fatal: true, reason: manifest.reason };

  const doctor = probeDoctor(binary, probeOptions);
  let after;
  try {
    after = captureWindowsDriverIdentity(binary, { fileSystem, hashFile });
  } catch (error) {
    return { ok: false, fatal: true, reason: error.message };
  }
  if (after.path !== before.path || !sameWindowsDriverFileIdentity(before.fileIdentity, after.fileIdentity)) {
    return { ok: false, fatal: true, reason: "cua-driver changed during inspection" };
  }

  return {
    ok: true,
    source,
    version,
    manifestSchema: manifest.manifestSchema,
    fileIdentity: before.fileIdentity,
    doctor: doctor.ok ? { ok: true } : { ok: false, reason: doctor.reason },
  };
}

function unavailableWindowsConnection(reason) {
  return {
    mode: "unavailable",
    platform: "win32",
    status: "unavailable",
    enabled: false,
    reason,
  };
}

function windowsCuaConnection(candidate, probe) {
  if (!probe?.ok) return unavailableWindowsConnection(probe?.reason || "cua-driver inspection failed");
  const binary = typeof candidate === "string" ? candidate : candidate?.path;
  const source = typeof candidate === "string" ? probe.source : candidate?.source ?? probe.source;
  if (
    typeof binary !== "string" ||
    !isAbsoluteWindowsPath(binary) ||
    typeof source !== "string" ||
    typeof probe.version !== "string" ||
    probe.manifestSchema !== "1" ||
    !validWindowsDriverFileIdentity(probe.fileIdentity)
  ) {
    return unavailableWindowsConnection("cua-driver inspection did not produce a certified descriptor");
  }
  const env = { ...WINDOWS_PROBE_ENV };
  const connection = {
    schemaVersion: 1,
    mode: "standalone",
    platform: "win32",
    status: "ready",
    enabled: true,
    driver: {
      path: binary,
      version: probe.version,
      source,
      manifestSchema: probe.manifestSchema,
      fileIdentity: { ...probe.fileIdentity },
    },
    mcp: { command: binary, args: ["mcp"], env: { ...env } },
    mcpCommand: binary,
    mcpArgs: ["mcp"],
    mcpEnv: { ...env },
  };
  if (probe.doctor?.ok === false && typeof probe.doctor.reason === "string") {
    connection.health = "degraded";
    connection.healthWarning = probe.doctor.reason;
  }
  return connection;
}

module.exports = {
  WINDOWS_DRIVER_FILE_IDENTITY_KEYS,
  WINDOWS_MANIFEST_ARGS,
  WINDOWS_PROBE_ENV,
  captureWindowsDriverIdentity,
  probeWindowsDriver,
  resolveWindowsDriverBinary,
  resolveWindowsDriverCandidate,
  windowsCuaConnection,
  windowsDriverCandidates,
};
