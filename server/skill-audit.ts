import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { SkillSelectionReason } from "./skill-library.ts";

export type SkillAuditSurface = "direct" | "room";

export interface SkillAuditDecision {
  skillId: string;
  reason: SkillSelectionReason;
}

export interface SkillAuditRow {
  recordedAt: string;
  botId: string;
  threadId: string;
  surface: SkillAuditSurface;
  selectedSkillIds: string[];
  mountedSkillToolIds: string[];
  decisions: SkillAuditDecision[];
}

export interface SkillAuditFilter {
  limit?: number;
  botId?: string;
  threadId?: string;
  surface?: SkillAuditSurface;
}

export const SKILL_AUDIT_FILE = join(DATA_DIR, "skill-audit.ndjson");
export const SKILL_AUDIT_MAX_BYTES = 256 * 1024;
export const SKILL_AUDIT_MAX_LIMIT = 200;

interface SkillAuditOptions {
  maxBytes?: number;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareIds);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return SKILL_AUDIT_MAX_LIMIT;
  if (!Number.isFinite(value) || !Number.isInteger(value)) return 0;
  return Math.max(1, Math.min(SKILL_AUDIT_MAX_LIMIT, value));
}

function parseRow(value: unknown): SkillAuditRow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.recordedAt !== "string" ||
    typeof raw.botId !== "string" ||
    typeof raw.threadId !== "string" ||
    (raw.surface !== "direct" && raw.surface !== "room") ||
    !Array.isArray(raw.selectedSkillIds) ||
    !Array.isArray(raw.mountedSkillToolIds) ||
    !Array.isArray(raw.decisions)
  ) return null;
  const decisions = raw.decisions.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.skillId !== "string" || typeof candidate.reason !== "string") return [];
    return [{ skillId: candidate.skillId, reason: candidate.reason as SkillSelectionReason }];
  });
  if (
    raw.selectedSkillIds.some((id) => typeof id !== "string") ||
    raw.mountedSkillToolIds.some((id) => typeof id !== "string") ||
    decisions.length !== raw.decisions.length
  ) return null;
  return {
    recordedAt: raw.recordedAt,
    botId: raw.botId,
    threadId: raw.threadId,
    surface: raw.surface,
    selectedSkillIds: sortedUnique(raw.selectedSkillIds as string[]),
    mountedSkillToolIds: sortedUnique(raw.mountedSkillToolIds as string[]),
    decisions: decisions.sort((a, b) => compareIds(a.skillId, b.skillId)),
  };
}

/**
 * Small durable support log for skill-selection decisions. It is deliberately
 * not a skill runtime: rows contain ids and reasons only, never prompt text.
 * The primary file rotates to `.1` before it crosses maxBytes. Rotation uses
 * unlink-then-rename because Windows cannot replace an existing destination.
 */
export class SkillAuditLog {
  private readonly maxBytes: number;
  private readonly filePath: string;

  constructor(filePath = SKILL_AUDIT_FILE, options: SkillAuditOptions = {}) {
    this.filePath = filePath;
    this.maxBytes = Math.max(4 * 1024, Math.trunc(options.maxBytes ?? SKILL_AUDIT_MAX_BYTES));
  }

  get path(): string {
    return this.filePath;
  }

  append(input: Omit<SkillAuditRow, "recordedAt"> & { recordedAt?: string }): void {
    try {
      const row: SkillAuditRow = {
        recordedAt: input.recordedAt ?? new Date().toISOString(),
        botId: input.botId,
        threadId: input.threadId,
        surface: input.surface,
        selectedSkillIds: sortedUnique(input.selectedSkillIds),
        mountedSkillToolIds: sortedUnique(input.mountedSkillToolIds),
        decisions: input.decisions
          .map(({ skillId, reason }) => ({ skillId, reason }))
          .sort((a, b) => compareIds(a.skillId, b.skillId)),
      };
      const line = `${JSON.stringify(row)}\n`;
      this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, line, { encoding: "utf8" });
    } catch {
      // Audit is best-effort. A locked or unavailable support file must never
      // turn a valid provider dispatch into a failed turn.
    }
  }

  read(filter: SkillAuditFilter = {}): SkillAuditRow[] {
    const limit = boundedLimit(filter.limit);
    if (!limit) return [];
    const rows: SkillAuditRow[] = [];
    for (const file of [`${this.filePath}.1`, this.filePath]) {
      if (!existsSync(file)) continue;
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const row = parseRow(JSON.parse(line));
          if (row) rows.push(row);
        } catch {
          // A truncated final line is ignored rather than breaking support UI.
        }
      }
    }
    return rows
      .filter((row) => !filter.botId || row.botId === filter.botId)
      .filter((row) => !filter.threadId || row.threadId === filter.threadId)
      .filter((row) => !filter.surface || row.surface === filter.surface)
      .slice(-limit);
  }

  private rotateIfNeeded(nextBytes: number): void {
    if (!existsSync(this.filePath)) return;
    let currentBytes = 0;
    try {
      currentBytes = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (currentBytes + nextBytes <= this.maxBytes) return;
    const rotated = `${this.filePath}.1`;
    try {
      if (existsSync(rotated)) unlinkSync(rotated);
      renameSync(this.filePath, rotated);
    } catch {
      // Keep dispatch safe if another local reader briefly holds the file.
    }
  }
}
