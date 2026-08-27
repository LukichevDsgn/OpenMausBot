import { describe, expect, it } from "vitest";

import { MAX_HANDOFF_BYTES, parseHandoff, scopesConflict } from "./handoff.ts";

const valid = (worktree = "D:/Codex/OpenMausBot-custom", file = "server/index.ts") =>
  `[OBJECTIVE]\nFix the bounded delegation path.\n[BASE/WORKTREE]\nBase: main\nWorktree: ${worktree}\n[ALLOWED FILES]\n- ${file}\n[FORBIDDEN SCOPE]\nNo parent history, logs, unrelated files or live services.\n[EXACT CHANGES]\nImplement only the requested change.\n[VERIFICATION]\nRun the focused deterministic tests.\n[RECEIPT]\nReturn changed files, commands, results and uncertainty.`;

describe("delegation handoff contract", () => {
  it("requires the compact fields and extracts the conflict scope", () => {
    const parsed = parseHandoff(valid());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.handoff.scope).toEqual({
        base: "main",
        worktree: "D:/Codex/OpenMausBot-custom",
        allowedFiles: ["server/index.ts"],
      });
    }
  });

  it("rejects oversized handoffs and parent-history injection", () => {
    const oversized = parseHandoff(valid() + "x".repeat(MAX_HANDOFF_BYTES));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error).toContain("exceeds");
    expect(parseHandoff(valid().replace("Fix the bounded delegation path.", "[PARENT HISTORY]\nold transcript")).ok).toBe(false);
  });

  it("counts UTF-8 bytes at an admitted custom cap and keeps the absolute ceiling", () => {
    const prefix = valid();
    const target = 1_024;
    const gap = target - Buffer.byteLength(prefix, "utf8");
    const unicode = "é".repeat(Math.floor(gap / 2));
    const remainder = gap - Buffer.byteLength(unicode, "utf8");
    const exact = `${prefix}${unicode}${"a".repeat(remainder)}`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(target);
    expect(parseHandoff(exact, undefined, target).ok).toBe(true);
    expect(parseHandoff(exact, { maxBytes: target }).ok).toBe(true);
    expect(parseHandoff(`${exact}a`, undefined, target).ok).toBe(false);
    expect(parseHandoff(prefix, undefined, target - 1).ok).toBe(false);

    const absolute = `${prefix}${"x".repeat(MAX_HANDOFF_BYTES - Buffer.byteLength(prefix, "utf8"))}`;
    expect(parseHandoff(absolute, undefined, MAX_HANDOFF_BYTES).ok).toBe(true);
    expect(parseHandoff(`${absolute}x`, undefined, MAX_HANDOFF_BYTES).ok).toBe(false);
    expect(parseHandoff(prefix, undefined, MAX_HANDOFF_BYTES + 1).ok).toBe(false);
  });

  it("explains the exact wire-format error instead of returning a generic invalid result", () => {
    const malformed = parseHandoff(
      valid().replace("- server/index.ts", "server/index.ts; server/store.ts"),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error).toContain("exact file list");
  });

  it("rejects the same worktree or overlapping exact files, but allows disjoint scopes", () => {
    const first = parseHandoff(valid("D:/work/a", "server/a.ts"));
    const sameWorktree = parseHandoff(valid("D:/work/a", "server/b.ts"));
    const sameFile = parseHandoff(valid("D:/work/b", "server/a.ts"));
    const disjoint = parseHandoff(valid("D:/work/b", "server/b.ts"));
    expect(first.ok && sameWorktree.ok && scopesConflict(first.handoff.scope, sameWorktree.handoff.scope)).toBe(true);
    expect(first.ok && sameFile.ok && scopesConflict(first.handoff.scope, sameFile.handoff.scope)).toBe(true);
    expect(first.ok && disjoint.ok && scopesConflict(first.handoff.scope, disjoint.handoff.scope)).toBe(false);
  });
});
