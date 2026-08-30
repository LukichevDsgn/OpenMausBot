// Fetch a skill's files from where users actually keep skills: a GitHub
// repo, a folder inside one, or a direct SKILL.md. Network in, plain
// {path, content} list out — validation, scanning, and storage live in
// skills.ts, so this file owns exactly one concern and its tests can hand
// it a fake fetch.
//
// Caps mirror the skills.sh CLI's: nothing here downloads more than
// MAX_FILES files or MAX_FILE_BYTES per file, and only markdown is ever
// requested (v1 imports are markdown-only by policy).
import { z } from "zod";

const MAX_FILES = 30;
const MAX_FILE_BYTES = 256 * 1024;
const API = "https://api.github.com";

export interface FetchedSkill {
  source: string;
  files: Array<{ path: string; content: string }>;
}

interface Target {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

export interface SkillImportRequest {
  source: string;
  skillNames?: string[];
}

const SAFE_SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function tokenizeSkillCommand(input: string): string[] | { error: string } {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
    } else if (char === "\\") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
  }
  if (escaped || quote) return { error: "malformed quoting in skills import command" };
  if (started) tokens.push(token);
  return tokens;
}

/** Parse either a plain GitHub source or the safe, data-only shape of the
 * skills CLI command. This deliberately never invokes npx or a shell. */
export function parseSkillImportInput(input: string): SkillImportRequest | { error: string } {
  const tokenized = tokenizeSkillCommand(input.trim());
  if ("error" in tokenized) return tokenized;
  if (tokenized.length === 1) return { source: tokenized[0]! };
  const command = tokenized[0] === "npx" ? tokenized.slice(1) : tokenized;
  if (command[0] !== "skills" || command[1] !== "add") {
    return { error: "only `npx skills add <GitHub source> [--skill <name>]` is supported" };
  }
  let source: string | undefined;
  const skillNames: string[] = [];
  for (let index = 2; index < command.length; index += 1) {
    const value = command[index]!;
    if (value === "--skill" || value === "-s") {
      const name = command[++index];
      if (!name) return { error: `${value} requires an exact skill name` };
      if (!SAFE_SKILL_ID.test(name)) return { error: `invalid skill name "${name}"` };
      if (skillNames.includes(name)) return { error: `duplicate --skill name "${name}"` };
      skillNames.push(name);
    } else if (value.startsWith("-")) {
      return { error: `unknown skills import flag "${value}"` };
    } else if (source) {
      return { error: "the skills import command accepts exactly one GitHub source" };
    } else {
      source = value;
    }
  }
  if (!source) return { error: "the skills import command needs a GitHub source" };
  return { source, ...(skillNames.length ? { skillNames } : {}) };
}

const GITHUB_TRACKING_QUERY_KEYS = new Set(["ysclid"]);

/** Remove a tracking-only query without allowing arbitrary URL metadata into
 * the repository parser. Unknown query keys remain invalid input. */
function normalizeGithubTrackingQuery(text: string): string {
  if (!/^https?:\/\/github\.com\//i.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.hostname.toLowerCase() !== "github.com" || !url.search) return text;
    const keys = [...url.searchParams.keys()];
    if (keys.length === 0 || keys.some((key) => !GITHUB_TRACKING_QUERY_KEYS.has(key.toLowerCase()))) return text;
    return `${text.slice(0, text.indexOf("?"))}${url.hash}`;
  } catch {
    return text;
  }
}

/** owner/repo, github.com/owner/repo[/tree/<ref>/<path>], or a raw/blob URL
 * straight to a SKILL.md. Anything else is refused, loudly. */
export function parseSkillSource(input: string): Target | { rawUrl: string } | { error: string } {
  const text = normalizeGithubTrackingQuery(input.trim());
  if (!text) return { error: "paste a GitHub repository, folder, or SKILL.md URL" };
  if (/^https?:\/\/github\.com\//i.test(text) && /[?#]/.test(text)) {
    return { error: "that does not look like a GitHub repository, folder, or SKILL.md URL" };
  }
  if (/^https:\/\/raw\.githubusercontent\.com\/.+\/SKILL\.md$/i.test(text)) return { rawUrl: text };
  const blob = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+SKILL\.md)$/i);
  if (blob) {
    return { rawUrl: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}` };
  }
  const tree = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i);
  if (tree) {
    return { owner: tree[1]!, repo: tree[2]!, ref: tree[3], path: tree[4] ?? "" };
  }
  const shorthand = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]!, path: "" };
  return { error: "that does not look like a GitHub repository, folder, or SKILL.md URL" };
}

const CONTENT_ENTRY = z.object({
  type: z.string(),
  name: z.string(),
  path: z.string(),
  download_url: z.string().nullable().optional(),
});
type ContentEntry = z.infer<typeof CONTENT_ENTRY>;

// The GitHub contents API is the I/O boundary: parse its JSON here, keep
// only entries matching the documented shape, drop the rest silently.
const CONTENT_LISTING = z.array(z.unknown()).catch([]);

function asEntries(listing: z.infer<typeof CONTENT_LISTING>): ContentEntry[] {
  return listing.flatMap((item) => {
    const entry = CONTENT_ENTRY.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

async function fetchListing(url: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const response = await fetcher(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "OpenMausBot-skills" },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return asEntries(CONTENT_LISTING.parse(await response.json()));
}

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, { headers: { "user-agent": "OpenMausBot-skills" } });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("file is larger than the 256KB import cap");
  return text;
}

async function listDir(target: Target, path: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const ref = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : "";
  const url = `${API}/repos/${target.owner}/${target.repo}/contents/${path}${ref}`;
  return fetchListing(url, fetcher);
}

/** Where SKILL.md folders live in real repos, per the registry's own
 * discovery order: the pasted path itself, then skills/, then .claude/skills/
 * and .agents/skills/, then one level of direct children. */
export async function discoverSkillDirs(target: Target, fetcher: typeof fetch): Promise<string[]> {
  const root = await listDir(target, target.path, fetcher);
  if (root.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
    return [target.path];
  }
  const dirs = root.filter((entry) => entry.type === "dir");
  const found: string[] = [];
  const preferred = ["skills", ".claude", ".agents"];
  const ordered = [...dirs].sort(
    (a, b) => (preferred.includes(a.name) ? 0 : 1) - (preferred.includes(b.name) ? 0 : 1),
  );
  for (const dir of ordered.slice(0, 12)) {
    if (found.length >= 10) break;
    const base = dir.name === ".claude" || dir.name === ".agents" ? `${dir.path}/skills` : dir.path;
    let children: ContentEntry[];
    try {
      children = await listDir(target, base, fetcher);
    } catch {
      continue;
    }
    if (children.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
      found.push(base);
      continue;
    }
    for (const child of children.filter((entry) => entry.type === "dir").slice(0, 20)) {
      if (found.length >= 10) break;
      try {
        const inner = await listDir(target, child.path, fetcher);
        if (inner.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) found.push(child.path);
      } catch {
        // unreadable child — skip
      }
    }
  }
  return found;
}

/** Fetch ONE skill folder's markdown files. `dir` must contain SKILL.md. */
export async function fetchSkillDir(target: Target, dir: string, fetcher: typeof fetch): Promise<FetchedSkill> {
  const entries = await listDir(target, dir, fetcher);
  const markdown = entries
    .filter((entry) => entry.type === "file" && /\.md$/i.test(entry.name) && entry.download_url)
    .slice(0, MAX_FILES);
  if (!markdown.some((entry) => entry.name === "SKILL.md")) {
    throw new Error(`no SKILL.md in ${dir || "the repository root"}`);
  }
  const files = await Promise.all(
    markdown.map(async (entry) => ({
      path: entry.name,
      content: await fetchText(entry.download_url!, fetcher),
    })),
  );
  const ref = target.ref ? `@${target.ref}` : "";
  return { source: `github.com/${target.owner}/${target.repo}${ref}/${dir}`.replace(/\/$/, ""), files };
}

/** Match the installer's narrow frontmatter field semantics without coupling
 * the fetch boundary to workspace storage: keys are case-insensitive and a
 * later duplicate replaces an earlier value. */
function declaredSkillName(manifest: string | undefined): string | undefined {
  const frontmatter = manifest?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return undefined;
  let name: string | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (field?.[1]?.toLowerCase() !== "name") continue;
    name = field[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return name;
}

export async function fetchSkillFromSource(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<{ skills: FetchedSkill[] } | { error: string }> {
  const request = parseSkillImportInput(input);
  if ("error" in request) return request;
  const parsed = parseSkillSource(request.source);
  if ("error" in parsed) return parsed;
  try {
    let skills: FetchedSkill[];
    if ("rawUrl" in parsed) {
      const content = await fetchText(parsed.rawUrl, fetcher);
      skills = [{ source: parsed.rawUrl, files: [{ path: "SKILL.md", content }] }];
    } else {
      const dirs = await discoverSkillDirs(parsed, fetcher);
      if (!dirs.length) return { error: "no SKILL.md found there — paste a skill folder or a repo with a skills/ directory" };
      skills = await Promise.all(dirs.map((dir) => fetchSkillDir(parsed, dir, fetcher)));
    }
    if (!request.skillNames?.length) return { skills };
    const byName = new Map<string, FetchedSkill>();
    for (const skill of skills) {
      const sourceName = skill.source.split("/").at(-1)?.split("@")[0];
      const manifest = skill.files.find((file) => file.path === "SKILL.md")?.content;
      const frontmatterName = declaredSkillName(manifest);
      // Prefer the declared SKILL.md name when present. A directory named
      // `lavish` must not satisfy `--skill lavish` if its manifest actually
      // declares another id; source basename is only the fixture/legacy
      // fallback for markdown that is validated later by the installer.
      if (frontmatterName) byName.set(frontmatterName, skill);
      else if (sourceName) byName.set(sourceName, skill);
    }
    const missing = request.skillNames.filter((name) => !byName.has(name));
    if (missing.length) return { error: `requested skill(s) not found: ${missing.join(", ")}` };
    return { skills: request.skillNames.map((name) => byName.get(name)!) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
