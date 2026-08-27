import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SkillAuditLog } from "./skill-audit.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function row(botId: string, surface: "direct" | "room" = "direct") {
  return {
    botId,
    threadId: `${botId}-thread`,
    surface,
    selectedSkillIds: botId === "bot-1" ? ["phone-harness"] : [],
    mountedSkillToolIds: botId === "bot-1" ? ["phone"] : [],
    decisions: [{ skillId: "phone-harness", reason: botId === "bot-1" ? "selected" as const : "unknown" as const }],
  };
}

describe("SkillAuditLog", () => {
  it("stores only bounded selection metadata and supports filters", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-skill-audit-"));
    dirs.push(dir);
    const audit = new SkillAuditLog(join(dir, "skill-audit.ndjson"));
    audit.append({ ...row("bot-1"), recordedAt: "2026-08-25T00:00:00.000Z" });
    audit.append({ ...row("bot-2", "room"), recordedAt: "2026-08-25T00:00:01.000Z" });

    expect(audit.read()).toHaveLength(2);
    expect(audit.read({ botId: "bot-2", surface: "room", limit: 1 })).toMatchObject([
      { botId: "bot-2", surface: "room", selectedSkillIds: [], decisions: [{ reason: "unknown" }] },
    ]);
    expect(readFileSync(audit.path, "utf8")).not.toContain("raw prompt");
    expect(JSON.stringify(audit.read())).not.toContain("raw prompt");
  });

  it("rotates on Windows-safe rename and keeps the support log bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-skill-audit-"));
    dirs.push(dir);
    const path = join(dir, "skill-audit.ndjson");
    const audit = new SkillAuditLog(path, { maxBytes: 4 * 1024 });
    for (let i = 0; i < 80; i += 1) {
      audit.append({
        ...row(`bot-${i}`),
        threadId: `thread-${i}`,
        recordedAt: `2026-08-25T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThan(8 * 1024);
    expect(statSync(`${path}.1`).size).toBeLessThan(8 * 1024);
    expect(audit.read({ limit: 200 }).length).toBeLessThan(80);
    expect(audit.read({ limit: 3 }).length).toBe(3);
  });

  it("does not throw when the audit path cannot be written", () => {
    const audit = new SkillAuditLog("skill-audit\u0000.ndjson");
    expect(() => audit.append(row("bot-1"))).not.toThrow();
  });
});
