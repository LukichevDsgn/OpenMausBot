import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { stopEmbeddedServer } from "./server-lifecycle.mjs";

function fakeProcess() {
  const proc = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe("embedded server lifecycle", () => {
  it("requests graceful shutdown and waits for provider disposal", async () => {
    const proc = fakeProcess();
    const fetchImpl = vi.fn(async () => {
      queueMicrotask(() => proc.emit("exit", 0));
      return { ok: true };
    });

    await expect(stopEmbeddedServer({ proc, port: 8799, fetchImpl, timeoutMs: 100 })).resolves.toEqual({
      graceful: true,
      reason: "server-exited",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8799/api/internal/shutdown",
      expect.objectContaining({ method: "POST" }),
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("kills only after the bounded graceful window expires", async () => {
    const proc = fakeProcess();
    const fetchImpl = vi.fn(async () => ({ ok: true }));

    await expect(stopEmbeddedServer({ proc, port: 18799, fetchImpl, timeoutMs: 5 })).resolves.toEqual({
      graceful: false,
      reason: "timeout-killed",
    });
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
});
