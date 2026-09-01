import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AntigravityAccountCards, ModelPickerRailButton } from "./ModelPicker";

describe("Antigravity account cards", () => {
  const accounts = [
    {
      profile: "a" as const,
      instanceId: "antigravity-worker-a",
      label: "Antigravity A · Worker A",
      email: "a@example.invalid",
      active: true,
      available: true,
      quota: { gemini: { weekly: { remaining: 84, resetsAt: null }, fiveHour: { remaining: 100, resetsAt: null } }, other: { weekly: null, fiveHour: null } },
    },
    {
      profile: "b" as const,
      instanceId: "antigravity-worker-b",
      label: "Antigravity B · Worker B",
      email: "b@example.invalid",
      active: false,
      available: true,
      quota: { gemini: { weekly: { remaining: 100, resetsAt: null }, fiveHour: { remaining: 100, resetsAt: null } }, other: { weekly: null, fiveHour: null } },
    },
  ];

  it.each([
    ["a", "Antigravity A · Worker A", "Antigravity B · Worker B"],
    ["b", "Antigravity B · Worker B", "Antigravity A · Worker A"],
  ] as const)("isolates the %s quota card to the selected instance", (profile, selectedLabel, hiddenLabel) => {
    const markup = renderToStaticMarkup(createElement(AntigravityAccountCards, {
      accounts,
      selectedInstanceId: `antigravity-worker-${profile}`,
      busy: false,
      onRefresh: () => undefined,
    }));

    expect(markup).toContain(selectedLabel);
    expect(markup).not.toContain(hiddenLabel);
    expect((markup.match(/data-testid="antigravity-account-[ab]"/g) ?? [])).toHaveLength(1);
  });

  it("marks selected cached quota as stale without exposing provider detail", () => {
    const refreshedWithErrors = accounts.map((account) => ({
      ...account,
      quotaStale: true,
      error: "provider detail must stay hidden",
    }));
    const markup = renderToStaticMarkup(createElement(AntigravityAccountCards, {
      accounts: refreshedWithErrors,
      selectedInstanceId: "antigravity-worker-a",
      busy: false,
      onRefresh: () => undefined,
    }));

    expect(markup).toContain("Refresh failed · showing last good");
    expect(markup).toContain("Total: <b>84%</b>");
    expect(markup).toContain("5 hours: <b>100%</b>");
    expect(markup).not.toContain("provider detail must stay hidden");
    expect(markup).not.toContain("Antigravity B · Worker B");
  });

  it("renders selectable A/B rail entries beside the account quota pane", () => {
    const instances = [
      {
        instanceId: "antigravity-worker-a",
        driverKind: "antigravityAgent",
        displayName: "Antigravity A · Worker A",
        snapshot: { state: "available" as const, version: "test" },
        models: { default: "gemini", options: [{ id: "gemini", label: "Gemini" }] },
      },
      {
        instanceId: "antigravity-worker-b",
        driverKind: "antigravityAgent",
        displayName: "Antigravity B · Worker B",
        snapshot: { state: "available" as const, version: "test" },
        models: { default: "gemini", options: [{ id: "gemini", label: "Gemini" }] },
      },
    ];
    const markup = renderToStaticMarkup(createElement("div", null,
      instances.map((instance) => createElement(ModelPickerRailButton, {
        key: instance.instanceId,
        instance,
        selected: instance.instanceId === "antigravity-worker-a",
        attention: false,
        disabled: false,
        onSelect: () => undefined,
      })),
      createElement(AntigravityAccountCards, {
        accounts,
        selectedInstanceId: "antigravity-worker-a",
        busy: false,
        onRefresh: () => undefined,
      }),
    ));

    expect(markup).toContain('data-testid="model-picker-rail-antigravity-worker-a"');
    expect(markup).toContain('data-testid="model-picker-rail-antigravity-worker-b"');
    expect(markup).toContain('aria-label="Antigravity A · Worker A"');
    expect(markup).toContain('aria-label="Antigravity B · Worker B"');
    expect(markup).toContain("Selected for bot");
    expect((markup.match(/Total:/g) ?? [])).toHaveLength(1);
    expect((markup.match(/5 hours:/g) ?? [])).toHaveLength(1);
  });
});
