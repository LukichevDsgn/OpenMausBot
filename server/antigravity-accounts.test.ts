import { describe, expect, it } from "vitest";

import {
  antigravityManagedQuotaRefreshRunning,
  antigravityManagedWorkerRunning,
  parseAntigravityUsage,
  registerManagedAntigravityWorker,
  unregisterManagedAntigravityWorker,
  withAntigravityAccountRefreshSingleFlight,
  withAntigravityCredentialLock,
  withManagedAntigravityQuotaRefresh,
} from "./antigravity-accounts.ts";

describe("Antigravity account coordination", () => {
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

  it("parses both model-family quota windows", () => {
    const quota = parseAntigravityUsage([
      "Gemini Models\tWeekly Limit Remaining\t82%\t2026-08-30",
      "Gemini Models\tFive Hour Limit Remaining\t91%\t2026-08-24",
      "Claude and GPT models\tWeekly Limit Remaining\t63%\t2026-08-30",
      "Claude and GPT models\tFive Hour Limit Remaining\t75%\t2026-08-24",
    ].join("\n"));
    expect(quota.gemini.weekly?.remaining).toBe(82);
    expect(quota.gemini.fiveHour?.remaining).toBe(91);
    expect(quota.other.weekly?.remaining).toBe(63);
    expect(quota.other.fiveHour?.remaining).toBe(75);
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
