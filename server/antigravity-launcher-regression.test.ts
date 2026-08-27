import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const launcher = process.env.OPENMAUSBOT_AGY_LAUNCHER ||
  join(homedir(), ".openmausbot", "bin", "agy-worker-a.exe");
const launcherSource = process.env.OPENMAUSBOT_AGY_LAUNCHER_SOURCE ||
  join(dirname(launcher), "agy-profile-launcher.cpp");
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
