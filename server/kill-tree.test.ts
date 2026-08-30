// The drivers spawn their CLI detached so that stopping a turn also stops
// whatever the CLI started (its MCP servers). That guarantee is the whole
// contract of killCliTree, so it is what gets tested: a grandchild must not
// survive the kill on either platform.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { execCliTree, killCliTree, spawnCli } from "./procs.ts";

const IDLE = "setInterval(() => {}, 1000)";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killCliTree", () => {
  it("preserves CLI stderr in a non-zero exit error", async () => {
    await expect(execCliTree(process.execPath, ["-e", "console.error('region denied');process.exit(7)"]))
      .rejects.toThrow(/exited 7: region denied/);
  });

  it("does not leave a launcher descendant alive after a timeout", async () => {
    const marker = `openmaus-antigravity-timeout-${process.pid}-${Date.now()}`;
    const launcher =
      `const {spawn}=require("node:child_process");` +
      `const child=spawn(process.execPath,["-e",${JSON.stringify(IDLE)},${JSON.stringify(marker)}],{stdio:"ignore"});` +
      `console.log(child.pid);` +
      IDLE;

    let failureMessage = "";
    let failureStdout = "";
    try {
      await execCliTree(process.execPath, ["-e", launcher], { timeout: 1_000 });
    } catch (error) {
      // SAFETY: execCliTree's rejection contract attaches the captured stdout
      // to an Error; this test invokes that function directly.
      const failure = error as Error & { stdout: string };
      failureMessage = failure.message;
      failureStdout = failure.stdout;
    }
    expect(failureMessage).toMatch(/timed out/);
    const descendantPid = Number(failureStdout.trim());
    expect(descendantPid).toBeGreaterThan(0);
    expect(alive(descendantPid)).toBe(false);
  }, 15_000);

  it("owns stdin pipe errors before a CLI can be force-stopped", async () => {
    const child = spawnCli(process.execPath, ["-e", IDLE], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      killCliTree(child);
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  });

  it("reaps a grandchild, not just the process it was handed", async () => {
    // a stand-in CLI: spawns one helper, reports its pid, then idles
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" });` +
          `console.log(c.pid); ${IDLE}`,
      ],
      { stdio: ["ignore", "pipe", "ignore"], detached: true, windowsHide: true },
    );
    let grandchild = 0;
    try {
      grandchild = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("helper did not report its pid")), 5_000);
        parent.stdout!.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
      });
      expect(grandchild).toBeGreaterThan(0);
      expect(alive(grandchild)).toBe(true);

      killCliTree(parent);

      // Read the parent's death off the child object: a POSIX parent stays a
      // live pid as a zombie until Node reaps it. The grandchild has no Child
      // object here, so wait until its pid disappears as the observable proof.
      const exited = () => parent.exitCode !== null || parent.signalCode !== null;
      const deadline = Date.now() + 10_000;
      while ((alive(grandchild) || !exited()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive(grandchild)).toBe(false);
      expect(exited()).toBe(true);
    } finally {
      killCliTree(parent);
      if (grandchild && alive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);
});
