import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const launcher = process.env.OPENMAUSBOT_AGY_LAUNCHER ||
  join(homedir(), ".openmausbot", "bin", "agy-worker-a.exe");
const repositoryLauncherSource = join(process.cwd(), "scripts", "agy-profile-launcher.cpp");
const launcherSource = process.env.OPENMAUSBOT_AGY_LAUNCHER_SOURCE || (existsSync(repositoryLauncherSource)
  ? repositoryLauncherSource
  : join(dirname(launcher), "agy-profile-launcher.cpp"));
const available = process.platform === "win32" && existsSync(launcher);

function eligibilityGate(state: "patched" | "unpatched") {
  return Buffer.from([
    0x48, 0x85, 0xc0, 0x0f, 0x84,
    0x11, 0x22, 0x33, 0x44,
    ...(state === "patched" ? [0x48, 0x85, 0xc0, 0x90] : [0x80, 0x78, 0x08, 0x00]),
    0x0f, 0x85, 0x55, 0x66, 0x77, 0x88,
  ]);
}

describe.skipIf(!available)("Antigravity launcher patch regression", () => {
  it("disables agy self-update before every diagnostic or provider invocation", () => {
    const source = readFileSync(launcherSource, "utf8");
    const disableUpdate = source.indexOf(
      'SetEnvironmentVariableW(L"AGY_CLI_DISABLE_AUTO_UPDATE", L"true")',
    );
    const patchDiagnostic = source.indexOf('std::wcscmp(argv[1], L"--openmaus-inspect-patch")');
    const versionProbe = source.indexOf('std::wcscmp(argv[1], L"--version")');
    const providerLaunch = source.indexOf("const DWORD exitCode = runProcess(agy");
    expect(disableUpdate).toBeGreaterThan(-1);
    expect(patchDiagnostic).toBeGreaterThan(disableUpdate);
    expect(versionProbe).toBeGreaterThan(disableUpdate);
    expect(providerLaunch).toBeGreaterThan(disableUpdate);
  });

  it("launches the read-only pinned master instead of mutable upstream agy", () => {
    const source = readFileSync(launcherSource, "utf8");
    expect(source).toContain('L"\\\\.openmausbot\\\\bin\\\\agy-pinned.exe"');
    expect(source).toContain("const std::wstring agy = pinnedAgy");
    expect(source).not.toContain("CopyFileW(pinnedAgy.c_str(), agy.c_str(), FALSE)");
    expect(source).not.toContain('L"\\\\.openmausbot\\\\antigravity-runtime"');
    expect(source).not.toContain('L"\\\\agy\\\\bin\\\\agy.exe"');
  });

  it("keeps the read-only version probe ahead of the credential mutex", () => {
    const source = readFileSync(launcherSource, "utf8");
    const versionProbe = source.indexOf('std::wcscmp(argv[1], L"--version")');
    const credentialMutex = source.indexOf("CreateMutexW");
    expect(versionProbe).toBeGreaterThan(-1);
    expect(credentialMutex).toBeGreaterThan(versionProbe);
  });

  it.each(["worker-a", "worker-b"] as const)(
    "keeps global vault activation/capture outside the %s isolated profile",
    (profile) => {
      const source = readFileSync(launcherSource, "utf8");
      expect(source).toContain('std::wcscmp(PROFILE_NAME, L"worker-a")');
      expect(source).toContain('L"\\\\.openmausbot\\\\antigravity-profiles\\\\" + PROFILE_NAME');
      expect(source).toContain("Could not activate isolated Antigravity profile");

      const isolatedProfile = source.indexOf('SetEnvironmentVariableW(L"USERPROFILE", profile.c_str())');
      const activate = source.indexOf('runVault(vault, L"activate")');
      const restoreBeforeActivate = source.lastIndexOf('SetEnvironmentVariableW(L"USERPROFILE", userProfile)', activate);
      const launch = source.indexOf("const DWORD exitCode = runProcess(agy");
      const capture = source.indexOf('runVault(vault, L"capture")');
      const restoreBeforeCapture = source.lastIndexOf('SetEnvironmentVariableW(L"USERPROFILE", userProfile)', capture);
      const activationFailure = source.indexOf("if (activateExit != 0)");
      const exit113 = source.indexOf("return 113", activationFailure);

      expect(isolatedProfile).toBeGreaterThan(-1);
      expect(restoreBeforeActivate).toBeGreaterThan(isolatedProfile);
      expect(restoreBeforeActivate).toBeLessThan(activate);
      expect(launch).toBeGreaterThan(activate);
      expect(restoreBeforeCapture).toBeGreaterThan(launch);
      expect(restoreBeforeCapture).toBeLessThan(capture);
      expect(activationFailure).toBeGreaterThan(activate);
      expect(exit113).toBeGreaterThan(activationFailure);
      expect(profile).toMatch(/^worker-[ab]$/);
    },
  );

  it.each([
    ["patched", 0],
    ["unpatched", 115],
    ["unknown", 116],
  ] as const)("classifies a synthetic %s agy binary", (state, expectedExit) => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-agy-patch-"));
    const fixture = join(root, "agy.exe");
    try {
      writeFileSync(fixture, state === "unknown" ? Buffer.from("not-an-agy-binary") : eligibilityGate(state));
      const result = spawnSync(launcher, ["--openmaus-inspect-patch", fixture], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status).toBe(expectedExit);
      expect(result.stdout.trim()).toBe(state);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Antigravity profile activation contract", () => {
  it("passes a profile to vault activation but not to capture", () => {
    const source = readFileSync(launcherSource, "utf8");
    const runVaultStart = source.indexOf("static DWORD runVault");
    const runVaultEnd = source.indexOf("static void clearProxyEnvironment", runVaultStart);
    const runVault = source.slice(runVaultStart, runVaultEnd);

    expect(runVault).toContain('std::wcscmp(action, L"capture") == 0');
    expect(runVault).toContain('quote(vault) + L" capture"');
    expect(runVault).toContain('quote(vault) + L" " + action + L" " + profileCode()');
  });

  it.each(["worker-a", "worker-b"] as const)(
    "routes %s through its profile code and global vault boundary",
    (profile) => {
      const source = readFileSync(launcherSource, "utf8");
      expect(source).toContain('std::wcscmp(PROFILE_NAME, L"worker-a")');
      expect(source).toContain('L"\\\\.openmausbot\\\\antigravity-profiles\\\\" + PROFILE_NAME');
      expect(source).toContain("Could not activate isolated Antigravity profile");

      const isolatedProfile = source.indexOf('SetEnvironmentVariableW(L"USERPROFILE", profile.c_str())');
      const activate = source.indexOf('runVault(vault, L"activate")');
      const restoreBeforeActivate = source.lastIndexOf('SetEnvironmentVariableW(L"USERPROFILE", userProfile)', activate);
      const launch = source.indexOf("const DWORD exitCode = runProcess(agy");
      const capture = source.indexOf('runVault(vault, L"capture")');
      const restoreBeforeCapture = source.lastIndexOf('SetEnvironmentVariableW(L"USERPROFILE", userProfile)', capture);

      expect(isolatedProfile).toBeGreaterThan(-1);
      expect(restoreBeforeActivate).toBeGreaterThan(isolatedProfile);
      expect(restoreBeforeActivate).toBeLessThan(activate);
      expect(launch).toBeGreaterThan(activate);
      expect(restoreBeforeCapture).toBeGreaterThan(launch);
      expect(restoreBeforeCapture).toBeLessThan(capture);
      expect(profile).toMatch(/^worker-[ab]$/);
    },
  );
});

describe("Antigravity helper provisioning contract", () => {
  it("owns the complete packaged helper set without account-specific literals", () => {
    const build = readFileSync(join(process.cwd(), "scripts", "build-antigravity-helpers.ps1"), "utf8");
    const provision = readFileSync(join(process.cwd(), "scripts", "provision-antigravity-helpers.ps1"), "utf8");
    for (const name of ["agy-account-vault.exe", "agy-worker-a.exe", "agy-worker-b.exe"]) {
      expect(build).toContain(name);
      expect(provision).toContain(name);
    }
    expect(build).toContain("agy-account-vault.cpp");
    expect(build).toContain("provision-antigravity-helpers.ps1");
    expect(provision).not.toMatch(/@gmail\.com|@users\.noreply\.github\.com/i);
  });
});
