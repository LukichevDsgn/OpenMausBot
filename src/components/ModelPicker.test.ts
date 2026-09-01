import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  accountDisplayLabel,
  AntigravityAccountCards,
  ModelPickerRailButton,
} from "./ModelPicker";
import type { AntigravityAccountStatus, InstanceInfo } from "@/state/store";

const quota = (weekly: number, fiveHour: number) => ({
  gemini: {
    weekly: { remaining: weekly, resetsAt: "2030-01-01T00:00:00.000Z" },
    fiveHour: { remaining: fiveHour, resetsAt: "2030-01-01T00:00:00.000Z" },
  },
  other: { weekly: null, fiveHour: null },
});

function account(
  profile: "a" | "b",
  overrides: Partial<AntigravityAccountStatus> = {},
): AntigravityAccountStatus {
  return {
    profile,
    instanceId: `antigravity-worker-${profile}`,
    label: `Antigravity ${profile.toUpperCase()}`,
    active: profile === "a",
    available: true,
    quota: quota(profile === "a" ? 81 : 42, profile === "a" ? 17 : 8),
    ...overrides,
  };
}

const antigravityInstance: InstanceInfo = {
  instanceId: "antigravity-worker-a",
  driverKind: "antigravityAgent",
  displayName: "Antigravity A",
  snapshot: { state: "available", authenticated: true, version: "test" },
  models: { default: "test-model", options: [{ id: "test-model", label: "Test model" }] },
};

describe("Antigravity model picker acceptance behavior", () => {
  it("isolates the selected account card and keeps refresh failure truthful", () => {
    const markup = renderToStaticMarkup(
      createElement(AntigravityAccountCards, {
        accounts: [
          account("a", { email: "a@example.test" }),
          account("b", { email: "b@example.test", quotaStale: true }),
        ],
        selectedInstanceId: "antigravity-worker-b",
        selectedBotInstanceId: "antigravity-worker-b",
        busy: false,
        onRefresh: vi.fn(),
      }),
    );

    expect(markup).toContain("antigravity-quota-card-antigravity-worker-b");
    expect(markup).toContain("b@example.test");
    expect(markup).toContain("42%");
    expect(markup).toContain("Refresh failed · showing last good");
    expect(markup).not.toContain("a@example.test");
    expect(markup).not.toContain("81%");
  });

  it("uses a neutral label when runtime account metadata has no sanitized email", () => {
    expect(accountDisplayLabel(account("a"))).toBe("Worker A account");
    expect(accountDisplayLabel(account("a", { email: "not-an-email" }))).toBe("Worker A account");
    expect(accountDisplayLabel(account("a", { email: "a@example.test" }))).toBe("a@example.test");
  });

  it("keeps A/B rail entries separately addressable", () => {
    const a = renderToStaticMarkup(
      createElement(ModelPickerRailButton, {
        instance: antigravityInstance,
        selected: true,
        attention: false,
        disabled: false,
        onSelect: vi.fn(),
      }),
    );
    const b = renderToStaticMarkup(
      createElement(ModelPickerRailButton, {
        instance: { ...antigravityInstance, instanceId: "antigravity-worker-b", displayName: "Antigravity B" },
        selected: false,
        attention: false,
        disabled: false,
        onSelect: vi.fn(),
      }),
    );

    expect(a).toContain('data-testid="model-picker-rail-antigravity-worker-a"');
    expect(b).toContain('data-testid="model-picker-rail-antigravity-worker-b"');
    expect(a).toContain('aria-pressed="true"');
    expect(b).toContain('aria-pressed="false"');
  });
});
