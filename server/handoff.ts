// Compact delegation contract. A handoff is deliberately a small control
// plane envelope, not a transcript transport: parent history, logs and large
// documents never belong in it.

export const MAX_HANDOFF_BYTES = 12_000;
export const MIN_HANDOFF_BYTES = 1_024;
export const MAX_HANDOFF_REASON_BYTES = 512;

const SECTION_NAMES = [
  "OBJECTIVE",
  "BASE/WORKTREE",
  "ALLOWED FILES",
  "FORBIDDEN SCOPE",
  "EXACT CHANGES",
  "VERIFICATION",
  "RECEIPT",
] as const;

type SectionName = (typeof SECTION_NAMES)[number];

export interface HandoffScope {
  base: string;
  worktree: string;
  allowedFiles: string[];
}

export interface ParsedHandoff {
  objective: string;
  baseAndWorktree: string;
  forbiddenScope: string;
  exactChanges: string;
  verification: string;
  receipt: string;
  scope: HandoffScope;
}

export interface HandoffParseOptions {
  reason?: string;
  maxBytes?: number;
}

export type HandoffParseResult =
  | { ok: true; handoff: ParsedHandoff }
  | { ok: false; error: string };

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sectionMap(text: string): Map<SectionName, string> | { error: string } {
  const sections = new Map<SectionName, string[]>();
  let current: SectionName | undefined;
  for (const rawLine of text.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(rawLine.trim());
    if (header && (SECTION_NAMES as readonly string[]).includes(header[1]!)) {
      current = header[1] as SectionName;
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)!.push(rawLine);
    else if (rawLine.trim()) return { error: "text before the first handoff section" };
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n").trim()]));
}

function nonEmpty(section: Map<SectionName, string>, name: SectionName): string | null {
  const value = section.get(name)?.trim() ?? "";
  return value || null;
}

function parseScope(value: string, allowedFilesText: string): HandoffScope | null {
  const base = /^base\s*:\s*(.+)$/imu.exec(value)?.[1]?.trim();
  const worktree = /^worktree\s*:\s*(.+)$/imu.exec(value)?.[1]?.trim();
  if (!base || !worktree || /^(?:unknown|unspecified|n\/a)$/iu.test(worktree)) return null;
  const allowedFiles = allowedFilesText
    .split(/\r?\n/u)
    .map((line) => /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/u.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);
  if (!allowedFiles.length || allowedFiles.some((file) => /^(?:all|\*|everything)$/iu.test(file))) return null;
  return { base, worktree, allowedFiles };
}

function requestedByteCap(value: number | { maxBytes?: number } | undefined): number | null {
  const cap = typeof value === "number" ? value : value?.maxBytes ?? MAX_HANDOFF_BYTES;
  return Number.isInteger(cap) && cap >= MIN_HANDOFF_BYTES && cap <= MAX_HANDOFF_BYTES ? cap : null;
}

export function parseHandoff(
  text: string,
  reasonOrOptions?: string | HandoffParseOptions,
  maxBytesOrOptions?: number | { maxBytes?: number },
): HandoffParseResult {
  const value = text.trim();
  if (!value) return { ok: false, error: "handoff is empty" };
  const reason = typeof reasonOrOptions === "string" ? reasonOrOptions : reasonOrOptions?.reason;
  const maxBytes = requestedByteCap(
    maxBytesOrOptions ?? (typeof reasonOrOptions === "object" ? reasonOrOptions.maxBytes : undefined),
  );
  if (maxBytes === null) {
    return { ok: false, error: `handoff byte cap must be an integer between ${MIN_HANDOFF_BYTES} and ${MAX_HANDOFF_BYTES}` };
  }
  if (bytes(value) > maxBytes) {
    return { ok: false, error: `handoff exceeds ${maxBytes} bytes` };
  }
  if (reason && bytes(reason.trim()) > MAX_HANDOFF_REASON_BYTES) {
    return { ok: false, error: `handoff reason exceeds ${MAX_HANDOFF_REASON_BYTES} bytes` };
  }
  if (/(?:\[PARENT HISTORY\]|\[TRANSCRIPT\]|\[CHAT LOG\]|<delegated-result>|conversation so far)/iu.test(value)) {
    return { ok: false, error: "parent history, transcripts and logs are forbidden in a handoff" };
  }
  const mapped = sectionMap(value);
  if ("error" in mapped) return { ok: false, error: mapped.error };
  for (const name of SECTION_NAMES) {
    if (!nonEmpty(mapped, name)) return { ok: false, error: `missing handoff section [${name}]` };
  }
  const baseAndWorktree = nonEmpty(mapped, "BASE/WORKTREE")!;
  const scope = parseScope(baseAndWorktree, nonEmpty(mapped, "ALLOWED FILES")!);
  if (!scope) {
    return { ok: false, error: "[BASE/WORKTREE] must contain Base:, Worktree: and an exact file list" };
  }
  return {
    ok: true,
    handoff: {
      objective: nonEmpty(mapped, "OBJECTIVE")!,
      baseAndWorktree,
      forbiddenScope: nonEmpty(mapped, "FORBIDDEN SCOPE")!,
      exactChanges: nonEmpty(mapped, "EXACT CHANGES")!,
      verification: nonEmpty(mapped, "VERIFICATION")!,
      receipt: nonEmpty(mapped, "RECEIPT")!,
      scope,
    },
  };
}

function key(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase();
}

export function scopesConflict(a: HandoffScope, b: HandoffScope): boolean {
  if (key(a.worktree) === key(b.worktree)) return true;
  const files = new Set(a.allowedFiles.map(key));
  return b.allowedFiles.some((file) => files.has(key(file)));
}
