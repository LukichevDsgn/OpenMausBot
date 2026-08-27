import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  WINDOWS_PROBE_ENV,
  probeWindowsDriver,
  resolveWindowsDriverCandidate,
  resolveWindowsDriverBinary,
  windowsCuaConnection,
  windowsDriverCandidates,
} = require("./cua-windows.cjs");

const BINARY = "C:\\Users\\test\\AppData\\Local\\Programs\\Cua\\cua-driver.exe";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function fakeFileSystem({ canonical = BINARY, hashes = [HASH_A, HASH_A], files = [canonical] } = {}) {
  let hashIndex = 0;
  return {
    existsSync: (candidate) => files.includes(candidate),
    realpathSync: (candidate) => (files.includes(candidate) ? canonical : candidate),
    statSync: (candidate) => {
      if (!files.includes(candidate) && candidate !== canonical) throw new Error("missing fake file");
      return { isFile: () => true, size: 123n, mtimeNs: 456n, ctimeNs: 789n };
    },
    readFileSync: () => Buffer.from("fake driver"),
    nextHash: () => hashes[Math.min(hashIndex++, hashes.length - 1)],
  };
}

function fakeSpawn({
  version = "0.21.0",
  manifestVersion = version,
  manifestSchema = "1",
  manifestCommand,
  manifestArgs = ["mcp"],
  doctor = { ok: true },
  versionStatus = 0,
} = {}) {
  const calls = [];
  const spawnSync = (binary, args, options) => {
    calls.push({ binary, args: [...args], env: options.env });
    if (args[0] === "--version") {
      return { status: versionStatus, stdout: `cua-driver ${version}`, stderr: "" };
    }
    if (args[0] === "manifest") {
      return {
        status: 0,
        stdout: JSON.stringify({
          schema_version: manifestSchema,
          binary_version: manifestVersion,
          mcp_invocation: { command: manifestCommand ?? binary, args: manifestArgs },
        }),
        stderr: "",
      };
    }
    return { status: doctor.ok ? 0 : 1, stdout: doctor.ok ? JSON.stringify(doctor) : "", stderr: doctor.reason ?? "" };
  };
  return { calls, spawnSync };
}

function validProbe(fileIdentity = { sha256: HASH_A, size: "123", mtimeNs: "456", ctimeNs: "789" }, doctor = { ok: true }) {
  return {
    ok: true,
    source: "environment",
    version: "0.21.0",
    manifestSchema: "1",
    fileIdentity,
    doctor,
  };
}

describe("Windows CUA runtime", () => {
  it("prefers an explicit driver and falls back to the official per-user install", () => {
    const explicit = "D:\\tools\\cua-driver.exe";
    const options = {
      env: { CUA_DRIVER_PATH: explicit, LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      resourcesPath: "C:\\app\\resources",
      homeDir: "C:\\Users\\test",
      packaged: true,
    };
    expect(windowsDriverCandidates(options)).toEqual([
      explicit,
      path.win32.join("C:\\app\\resources", "cua-driver.exe"),
      path.win32.join(
        "C:\\Users\\test\\AppData\\Local",
        "Programs",
        "Cua",
        "cua-driver",
        "bin",
        "cua-driver.exe",
      ),
    ]);
    const explicitFileSystem = fakeFileSystem({ canonical: explicit, files: [explicit] });
    expect(
      resolveWindowsDriverCandidate({
        ...options,
        fileSystem: explicitFileSystem,
      }),
    ).toEqual({ path: explicit, source: "environment" });

    const packaged = path.win32.join("C:\\app\\resources", "cua-driver.exe");
    const packagedFileSystem = fakeFileSystem({ canonical: packaged, files: [packaged] });
    expect(
      resolveWindowsDriverCandidate({
        ...options,
        env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
        fileSystem: packagedFileSystem,
      }),
    ).toEqual({ path: packaged, source: "bundled" });

    const userLocal = path.win32.join(
      "C:\\Users\\test\\AppData\\Local",
      "Programs\\Cua\\cua-driver\\bin\\cua-driver.exe",
    );
    expect(
      resolveWindowsDriverCandidate({
        env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
        fileSystem: fakeFileSystem({ canonical: userLocal, files: [userLocal] }),
      }),
    ).toEqual({ path: userLocal, source: "user-local" });
  });

  it("requires compatible version and manifest probes and disables update/telemetry on every child", () => {
    const fileSystem = fakeFileSystem();
    const { calls, spawnSync } = fakeSpawn();
    const result = probeWindowsDriver(BINARY, {
      spawnSync,
      fileSystem,
      hashFile: (_file, _fs) => fileSystem.nextHash(),
      env: { CUA_DRIVER_RS_UPDATE_CHECK: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "1" },
      source: "environment",
    });

    expect(result).toMatchObject({
      ok: true,
      source: "environment",
      version: "0.21.0",
      manifestSchema: "1",
      fileIdentity: { sha256: HASH_A, size: "123", mtimeNs: "456", ctimeNs: "789" },
      doctor: { ok: true },
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["manifest", "--json"],
      ["doctor", "--json"],
    ]);
    expect(calls.every((call) => call.env.CUA_DRIVER_RS_UPDATE_CHECK === "false" && call.env.CUA_DRIVER_RS_TELEMETRY_ENABLED === "false")).toBe(true);
    expect(WINDOWS_PROBE_ENV).toEqual({
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    });
  });

  it("fails closed on invalid version, manifest mismatch, spawn failure, and probe-time mutation", () => {
    const cases = [
      {
        name: "invalid version",
        spawn: fakeSpawn({ version: "not-a-version" }),
        expected: "cua-driver --version returned an invalid version",
      },
      {
        name: "manifest version mismatch",
        spawn: fakeSpawn({ manifestVersion: "0.20.0" }),
        expected: "cua-driver manifest schema or version mismatch",
      },
      {
        name: "manifest schema mismatch",
        spawn: fakeSpawn({ manifestSchema: "2" }),
        expected: "cua-driver manifest schema or version mismatch",
      },
      {
        name: "manifest invocation mismatch",
        spawn: fakeSpawn({ manifestCommand: "C:\\other-driver.exe" }),
        expected: "cua-driver manifest MCP invocation mismatch",
      },
      {
        name: "version spawn failure",
        spawn: fakeSpawn({ versionStatus: 1 }),
        expected: "cua-driver --version exited 1",
      },
    ];
    for (const testCase of cases) {
      const fileSystem = fakeFileSystem();
      expect(
        probeWindowsDriver(BINARY, {
          spawnSync: testCase.spawn.spawnSync,
          fileSystem,
          hashFile: (_file, _fs) => fileSystem.nextHash(),
        }),
        testCase.name,
      ).toMatchObject({ ok: false, fatal: true, reason: testCase.expected });
    }

    const mutationFileSystem = fakeFileSystem({ hashes: [HASH_A, HASH_B] });
    const mutationSpawn = fakeSpawn();
    expect(
      probeWindowsDriver(BINARY, {
        spawnSync: mutationSpawn.spawnSync,
        fileSystem: mutationFileSystem,
        hashFile: (_file, _fs) => mutationFileSystem.nextHash(),
      }),
    ).toMatchObject({ ok: false, fatal: true, reason: "cua-driver changed during inspection" });
  });

  it("keeps doctor degradation ready while publishing the exact supervised descriptor", () => {
    const connection = windowsCuaConnection(
      { path: BINARY, source: "environment" },
      validProbe(),
    );
    expect(connection).toEqual({
      schemaVersion: 1,
      mode: "standalone",
      platform: "win32",
      status: "ready",
      enabled: true,
      driver: {
        path: BINARY,
        version: "0.21.0",
        source: "environment",
        manifestSchema: "1",
        fileIdentity: { sha256: HASH_A, size: "123", mtimeNs: "456", ctimeNs: "789" },
      },
      mcp: {
        command: BINARY,
        args: ["mcp"],
        env: { ...WINDOWS_PROBE_ENV },
      },
      mcpCommand: BINARY,
      mcpArgs: ["mcp"],
      mcpEnv: { ...WINDOWS_PROBE_ENV },
    });
    expect(
      windowsCuaConnection(
        { path: BINARY, source: "user-local" },
        validProbe(undefined, { ok: false, reason: "transient UIA timeout" }),
      ),
    ).toMatchObject({
      mode: "standalone",
      status: "ready",
      health: "degraded",
      healthWarning: "transient UIA timeout",
      driver: { source: "user-local" },
      mcpCommand: BINARY,
      mcpArgs: ["mcp"],
    });
    expect(windowsCuaConnection({ path: BINARY, source: "environment" }, { ok: false, fatal: true, reason: "identity changed" })).toMatchObject({
      mode: "unavailable",
      status: "unavailable",
      enabled: false,
    });
  });
});
