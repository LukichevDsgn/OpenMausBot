import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { execCliTreeMock } = vi.hoisted(() => ({ execCliTreeMock: vi.fn() }));
vi.mock("./procs.ts", () => ({ execCliTree: execCliTreeMock }));

const originalUserProfile = process.env.USERPROFILE;
const testProfileRoot = mkdtempSync(join(tmpdir(), "openmaus-antigravity-test-"));
process.env.USERPROFILE = testProfileRoot;

const {
  antigravityManagedQuotaRefreshRunning,
  antigravityManagedWorkerRunning,
  nextAntigravityQuotaStaleState,
  parseAntigravityUsage,
  registerManagedAntigravityWorker,
  unregisterManagedAntigravityWorker,
  withAntigravityAccountRefreshSingleFlight,
  withAntigravityCredentialLock,
  withManagedAntigravityQuotaRefresh,
  refreshAntigravityProfileQuota,
  antigravityAccountStatuses,
} = await import("./antigravity-accounts.ts");

afterAll(() => {
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(testProfileRoot, { recursive: true, force: true });
});

beforeEach(() => execCliTreeMock.mockReset());

describe("Antigravity account coordination", () => {
  it("keeps a failed refresh stale across cache reads until a successful refresh", () => {
    const failed = nextAntigravityQuotaStaleState(false, "failure");
    const normalCacheRead = nextAntigravityQuotaStaleState(failed, "unchanged");
    const refreshed = nextAntigravityQuotaStaleState(normalCacheRead, "success");

    expect(failed).toBe(true);
    expect(normalCacheRead).toBe(true);
    expect(refreshed).toBe(false);
  });

  it("distinguishes OpenMaus-managed workers from standalone agy processes", () => {
    expect(antigravityManagedWorkerRunning()).toBe(false);
    registerManagedAntigravityWorker(12001);
    expect(antigravityManagedWorkerRunning()).toBe(true);
    registerManagedAntigravityWorker(12002);
    unregisterManagedAntigravityWorker(12001);
    expect(antigravityManagedWorkerRunning()).toBe(true);
    unregisterManagedAntigravityWorker(12002);
    expect(antigravityManagedWorkerRunning()).toBe(false);
  });

  it("parses the documented structured read-only usage response", () => {
    const quota = parseAntigravityUsage(JSON.stringify({
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", remaining_fraction: 0.82, reset_time: "2026-08-30T00:00:00Z" },
                { id: "gemini-5h", remaining_fraction: 0.91, reset_time: "2026-08-24T00:00:00Z" },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-weekly", remaining_fraction: 0.63, reset_time: "2026-08-30T00:00:00Z" },
                { id: "3p-5h", remaining_fraction: 0.75, reset_time: "2026-08-24T00:00:00Z" },
              ],
            },
          ],
        },
      },
    }));
    expect(quota.gemini.weekly?.remaining).toBe(82);
    expect(quota.gemini.fiveHour?.remaining).toBe(91);
    expect(quota.other.weekly?.remaining).toBe(63);
    expect(quota.other.fiveHour?.remaining).toBe(75);
  });

  it("fails closed on incomplete or agent-turn payloads", () => {
    expect(() => parseAntigravityUsage(JSON.stringify({ groups: [] }))).toThrow("incomplete");
    expect(() => parseAntigravityUsage(JSON.stringify({
      usage: { total_tokens: 1 },
      groups: [],
    }))).toThrow("agent turn");
  });

  it("shows that execCliTree settles on pipe closure, not a complete usage envelope", async () => {
    const { execCliTree: actualExecCliTree } =
      await vi.importActual<typeof import("./procs.ts")>("./procs.ts");
    const usageEnvelope = JSON.stringify({
      command: { name: "usage", data: { groups: [] } },
    });
    const childScript = [
      "const { spawn } = require('node:child_process');",
      `process.stdout.write(${JSON.stringify(usageEnvelope)});`,
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 1, 2] });",
      "setTimeout(() => {}, 5000);",
    ].join("\n");

    let error: unknown;
    try {
      await actualExecCliTree(process.execPath, ["-e", childScript], {
        timeout: 1_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("timed out after 1000ms");
    const capturedStdout = (error as Error & { stdout?: string }).stdout ?? "";
    expect(capturedStdout).toContain('"command"');
    expect(capturedStdout).toContain('"usage"');
  });

  it("preserves last-good quota and marks it stale after a bounded refresh failure", async () => {
    const output = JSON.stringify({
      command: {
        name: "usage",
        data: {
          groups: [
            { name: "Gemini Models", buckets: [
              { id: "gemini-weekly", remaining_fraction: 0.84 },
              { id: "gemini-5h", remaining_fraction: 1 },
            ] },
            { name: "Claude and GPT models", buckets: [
              { id: "3p-weekly", remaining_fraction: 0.63 },
              { id: "3p-5h", remaining_fraction: 0.75 },
            ] },
          ],
        },
      },
    });
    execCliTreeMock.mockResolvedValueOnce({ stdout: output, stderr: "" });
    await refreshAntigravityProfileQuota("a");
    expect(execCliTreeMock).toHaveBeenLastCalledWith(
      expect.stringContaining("agy-worker-a.exe"),
      ["--print", "/usage", "--output-format", "json"],
      expect.objectContaining({
        windowsHide: true,
        timeout: 30_000,
        completionPredicate: expect.any(Function),
      }),
    );

    execCliTreeMock.mockRejectedValueOnce(new Error("bounded timeout"));
    await expect(refreshAntigravityProfileQuota("a")).rejects.toThrow("bounded timeout");
    const status = (await antigravityAccountStatuses(false)).find((entry) => entry.profile === "a");
    expect(status?.quota.gemini.weekly?.remaining).toBe(84);
    expect(status?.quota.gemini.fiveHour?.remaining).toBe(100);
    expect(status?.quotaStale).toBe(true);
  });

  it("serializes machine-wide credential operations", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withAntigravityCredentialLock(async () => {
      events.push("a:start");
      await firstGate;
      events.push("a:end");
    });
    const second = withAntigravityCredentialLock(async () => {
      events.push("b:start");
      events.push("b:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["a:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("coalesces overlapping picker refreshes into one managed probe", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = () => withManagedAntigravityQuotaRefresh(async () => {
      calls += 1;
      await gate;
      return [];
    });

    const first = withAntigravityAccountRefreshSingleFlight(operation);
    const second = withAntigravityAccountRefreshSingleFlight(operation);
    expect(first).toBe(second);
    expect(calls).toBe(1);
    expect(antigravityManagedQuotaRefreshRunning()).toBe(true);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(antigravityManagedQuotaRefreshRunning()).toBe(false);
  });
});
