import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { BotAvatar } from "./Avatar";
import type { ExportScopeOption } from "@/lib/team-files";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

let exportScopeAvatarProps: typeof import("./TeamLibraryPanel").exportScopeAvatarProps;

beforeAll(async () => {
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  ({ exportScopeAvatarProps } = await import("./TeamLibraryPanel"));
});

const bots = [
  { id: "bot-a", name: "A", color: "blue" as const },
  { id: "bot-b", name: "B", color: "green" as const },
];

function botOption(id: string): ExportScopeOption {
  return {
    key: `bot:${id}`,
    category: "bot",
    label: id,
    detail: "Single bot",
    scope: { botIds: [id], groupIds: [] },
    botIds: [id],
  };
}

describe("team export scope avatars", () => {
  it("renders a static BotAvatar for every existing bot and only falls back for missing ids", () => {
    const existingA = exportScopeAvatarProps(botOption("bot-a"), bots);
    const existingB = exportScopeAvatarProps(botOption("bot-b"), bots);
    const missing = exportScopeAvatarProps(botOption("missing"), bots);

    expect(existingA?.bot.id).toBe("bot-a");
    expect(existingB?.bot.id).toBe("bot-b");
    expect(missing).toBeUndefined();
    expect(renderToStaticMarkup(createElement(BotAvatar, existingA))).toContain("svg");
    expect(renderToStaticMarkup(createElement(BotAvatar, existingB))).toContain("svg");
  });
});
