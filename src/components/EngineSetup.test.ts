import { describe, expect, it } from "vitest";

import { engineUnavailable, needsCli, needsSignIn } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(engineUnavailable(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("does not turn a transient probe failure into an install prompt", () => {
    const busy = instance({
      state: "unavailable",
      reason: "spawn failed: agy timed out after 8000ms",
      setup: false,
    });
    expect(needsCli(busy)).toBe(false);
    expect(engineUnavailable(busy)).toBe(true);
    expect(needsSignIn(busy)).toBe(false);
  });

  it("honors an explicit setup signal without parsing provider copy", () => {
    const missing = instance({ state: "unavailable", reason: "provider unavailable", setup: true });
    expect(needsCli(missing)).toBe(true);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(engineUnavailable(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});
