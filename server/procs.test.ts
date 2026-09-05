import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertSafeCliArgv,
  describeSpawnFailure,
  estimatedWindowsCommandLineChars,
  execCliTree,
  WINDOWS_SAFE_COMMAND_LINE_CHARS,
} from "./procs.ts";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function descendantPipeScript(envelope: string, markerPath: string, lingerMs: number): string {
  return [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${lingerMs})'], { stdio: ['ignore', 1, 2] });`,
    `writeFileSync(${JSON.stringify(markerPath)}, String(descendant.pid));`,
    `process.stdout.write(${JSON.stringify(envelope)});`,
    `setTimeout(() => {}, ${lingerMs});`,
  ].join("\n");
}

describe("Windows CLI argument safety", () => {
  it("accepts ordinary launches", () => {
    const resolved = { command: "agy.exe", args: ["--model", "gemini-3.1-pro-high"] };
    expect(estimatedWindowsCommandLineChars(resolved)).toBeLessThan(WINDOWS_SAFE_COMMAND_LINE_CHARS);
    expect(() => assertSafeCliArgv(resolved, "win32")).not.toThrow();
  });

  it("rejects a prompt-sized argv before CreateProcess can fail opaquely", () => {
    const resolved = { command: "agy.exe", args: ["--print", "x".repeat(40_000)] };
    expect(() => assertSafeCliArgv(resolved, "win32")).toThrow(
      /pass large prompts through stdin or a file/,
    );
    try {
      assertSafeCliArgv(resolved, "win32");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENAMETOOLONG");
    }
  });

  it("does not impose the Windows limit on other platforms", () => {
    const resolved = { command: "agy", args: ["--print", "x".repeat(40_000)] };
    expect(() => assertSafeCliArgv(resolved, "linux")).not.toThrow();
  });

  it("turns ENAMETOOLONG into an actionable message without echoing argv", () => {
    const error = Object.assign(new Error("private prompt contents"), { code: "ENAMETOOLONG" });
    const failure = describeSpawnFailure(error, "agy");
    expect(failure).toEqual({
      message: "`agy` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file",
      setup: false,
    });
    expect(failure.message).not.toContain("private prompt contents");
  });
});

describe("bounded CLI completion boundaries", () => {
  it("settles on a complete envelope and reaps an inherited descendant pipe", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "openmaus-procs-test-"));
    const markerPath = join(fixtureRoot, "descendant.pid");
    const envelope = JSON.stringify({ status: "SUCCESS", response: "complete" });
    let descendantPid: number | undefined;
    const startedAt = Date.now();

    try {
      const result = await execCliTree(
        process.execPath,
        ["-e", descendantPipeScript(envelope, markerPath, 10_000)],
        {
          timeout: 2_000,
          completionPredicate: (stdout) => stdout === envelope,
        },
      );
      descendantPid = Number(readFileSync(markerPath, "utf8"));

      expect(result.stdout).toBe(envelope);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await waitForProcessExit(descendantPid);
      expect(processIsAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        try { process.kill(descendantPid); } catch { /* already gone */ }
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not settle on a partial envelope and still cleans up on timeout", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "openmaus-procs-test-"));
    const markerPath = join(fixtureRoot, "descendant.pid");
    const partial = '{"status":"SUCCESS"';
    const complete = `${partial}}`;
    let descendantPid: number | undefined;

    try {
      await expect(execCliTree(
        process.execPath,
        ["-e", descendantPipeScript(partial, markerPath, 10_000)],
        {
          timeout: 150,
          completionPredicate: (stdout) => stdout === complete,
        },
      )).rejects.toThrow("timed out after 150ms");
      descendantPid = Number(readFileSync(markerPath, "utf8"));
      await waitForProcessExit(descendantPid);
      expect(processIsAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        try { process.kill(descendantPid); } catch { /* already gone */ }
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
