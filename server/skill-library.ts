// Bundled skill catalog. Skills remain isolated resources so adding or
// disabling one does not require changing a provider driver. A future Skills
// UI can use the same manifests; today enabled built-ins are selected by their
// declared trigger terms and mounted capabilities.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  triggerTerms: string[];
  requiredCapabilities: string[];
  /** Tool ids owned by this skill. A declaration is not itself a grant. */
  tools: string[];
}

export interface BundledSkill {
  manifest: SkillManifest;
  instructions: string;
  directory: string;
}

export interface SkillGrantState {
  /** undefined preserves the default-enabled catalog behavior; [] denies all. */
  skillGrants?: readonly string[];
  /** undefined preserves all tools declared by the effective skills; [] denies all. */
  skillToolGrants?: readonly string[];
}

export type SkillSelectionReason =
  | "selected"
  | "trigger-mismatch"
  | "skill-denied"
  | "capability-missing"
  | "tool-denied";

export interface SkillDecision {
  skillId: string;
  reason: SkillSelectionReason;
  requiredCapabilities: string[];
  declaredToolIds: string[];
}

export interface SkillSelection {
  selectedSkills: BundledSkill[];
  mountedSkillToolIds: string[];
  decisions: SkillDecision[];
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  triggerTerms: string[];
  requiredCapabilities: string[];
  tools: string[];
}

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_TOOL_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function compareDeterministically(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) return null;
  const values = value.map((item) => (item as string).trim());
  if (new Set(values).size !== values.length) throw new Error("duplicate list entry");
  return values.sort(compareDeterministically);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareDeterministically);
}

export function parseSkillManifest(value: unknown, directory: string): SkillManifest {
  if (!value || typeof value !== "object") throw new Error(`${directory}/manifest.json is invalid`);
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  let triggerTerms: string[] | null;
  let requiredCapabilities: string[] | null;
  let tools: string[] | null;
  try {
    triggerTerms = stringList(raw.triggerTerms);
    requiredCapabilities = stringList(raw.requiredCapabilities);
    tools = stringList(raw.tools);
  } catch {
    throw new Error(`${directory}/manifest.json has duplicate list entries`);
  }
  if (!SAFE_ID.test(id) || id !== basename(directory)) throw new Error(`${directory}/manifest.json has an invalid id`);
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`${directory}/manifest.json has no name`);
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.version)) throw new Error(`${directory}/manifest.json has an invalid version`);
  if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error(`${directory}/manifest.json has no description`);
  if (typeof raw.defaultEnabled !== "boolean") throw new Error(`${directory}/manifest.json has no defaultEnabled flag`);
  if (!triggerTerms?.length) throw new Error(`${directory}/manifest.json has no trigger terms`);
  if (!requiredCapabilities) throw new Error(`${directory}/manifest.json has invalid capabilities`);
  if (!tools || tools.some((tool) => !SAFE_TOOL_ID.test(tool))) throw new Error(`${directory}/manifest.json has invalid tools`);
  return {
    id,
    name: raw.name.trim(),
    version: raw.version,
    description: raw.description.trim(),
    defaultEnabled: raw.defaultEnabled,
    triggerTerms,
    requiredCapabilities,
    tools,
  };
}

function loadSkillDirectory(directory: string, options: { allowMissingTools?: boolean } = {}): BundledSkill | null {
  const manifestPath = join(directory, "manifest.json");
  const skillPath = join(directory, "SKILL.md");
  if (!existsSync(manifestPath) || !existsSync(skillPath)) return null;
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (options.allowMissingTools && raw && typeof raw === "object" && !Array.isArray(raw) && !Object.hasOwn(raw, "tools")) {
    raw.tools = [];
  }
  const manifest = parseSkillManifest(raw, directory);
  const instructions = readFileSync(skillPath, "utf8").trim();
  if (!instructions.startsWith("---")) throw new Error(`${skillPath} has no skill frontmatter`);
  return { manifest, instructions, directory };
}

export function loadBundledSkills(root = process.env.OMB_SKILLS_DIR || join(process.cwd(), "skills")): BundledSkill[] {
  if (!existsSync(root)) return [];
  const skills: BundledSkill[] = [];
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    const skill = loadSkillDirectory(directory);
    if (skill) skills.push(skill);
  }
  return skills;
}

export function skillCatalog(skills: readonly BundledSkill[]): SkillCatalogEntry[] {
  return skills.map(({ manifest }) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    defaultEnabled: manifest.defaultEnabled,
    triggerTerms: [...manifest.triggerTerms],
    requiredCapabilities: [...manifest.requiredCapabilities],
    tools: [...manifest.tools],
  }));
}

export function filterSkillGrantState(
  grants: SkillGrantState,
  skills: readonly BundledSkill[],
): SkillGrantState {
  const skillIds = new Set(skills.map(({ manifest }) => manifest.id));
  const toolIds = new Set(skills.flatMap(({ manifest }) => manifest.tools));
  const filtered: SkillGrantState = {};
  if (grants.skillGrants !== undefined) {
    filtered.skillGrants = sortedUnique(grants.skillGrants.filter((id): id is string => typeof id === "string" && skillIds.has(id)));
  }
  if (grants.skillToolGrants !== undefined) {
    filtered.skillToolGrants = sortedUnique(grants.skillToolGrants.filter((id): id is string => typeof id === "string" && toolIds.has(id)));
  }
  return filtered;
}

export function validateSkillGrantPatch(
  input: { skillGrants?: unknown; skillToolGrants?: unknown },
  skills: readonly BundledSkill[],
): SkillGrantState {
  const knownSkills = new Set(skills.map(({ manifest }) => manifest.id));
  const knownTools = new Set(skills.flatMap(({ manifest }) => manifest.tools));
  const patch: SkillGrantState = {};
  for (const [field, known] of [["skillGrants", knownSkills], ["skillToolGrants", knownTools]] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${field} must be a list of known ids`);
    }
    const ids = sortedUnique(value as string[]);
    const unknown = ids.find((id) => !known.has(id));
    if (unknown) throw new Error(`${field} contains unknown id "${unknown}"`);
    patch[field] = ids;
  }
  return patch;
}

export function effectiveSkillIds(
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): string[] {
  if (grants.skillGrants !== undefined) {
    const known = new Set(skills.map(({ manifest }) => manifest.id));
    return sortedUnique(grants.skillGrants.filter((id): id is string => typeof id === "string" && known.has(id)));
  }
  return skills.filter(({ manifest }) => manifest.defaultEnabled).map(({ manifest }) => manifest.id).sort(compareDeterministically);
}

export function effectiveSkillToolIds(
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): string[] {
  const selected = new Set(effectiveSkillIds(skills, grants));
  if (grants.skillToolGrants !== undefined) {
    const known = new Set(skills.flatMap(({ manifest }) => manifest.tools));
    return sortedUnique(grants.skillToolGrants.filter((id): id is string => typeof id === "string" && known.has(id)));
  }
  return sortedUnique(
    skills.filter(({ manifest }) => selected.has(manifest.id)).flatMap(({ manifest }) => manifest.tools),
  );
}

export function decideBundledSkills(
  triggerText: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): SkillSelection {
  const haystack = triggerText.toLowerCase();
  const available = new Set(capabilities);
  const grantedSkills = new Set(effectiveSkillIds(skills, grants));
  const grantedTools = new Set(effectiveSkillToolIds(skills, grants));
  const decisions: SkillDecision[] = skills.map(({ manifest }) => {
    const triggered = manifest.triggerTerms.some((term) => haystack.includes(term.toLowerCase()));
    let reason: SkillSelectionReason;
    if (!triggered) reason = "trigger-mismatch";
    else if (!grantedSkills.has(manifest.id)) reason = "skill-denied";
    else if (!manifest.requiredCapabilities.every((capability) => available.has(capability))) reason = "capability-missing";
    else if (!manifest.tools.every((tool) => grantedTools.has(tool))) reason = "tool-denied";
    else reason = "selected";
    return {
      skillId: manifest.id,
      reason,
      requiredCapabilities: [...manifest.requiredCapabilities],
      declaredToolIds: [...manifest.tools],
    };
  });
  const selectedIds = new Set(decisions.filter((decision) => decision.reason === "selected").map((decision) => decision.skillId));
  const selectedSkills = skills.filter(({ manifest }) => selectedIds.has(manifest.id));
  return {
    selectedSkills,
    mountedSkillToolIds: sortedUnique(selectedSkills.flatMap(({ manifest }) => manifest.tools)),
    decisions,
  };
}

/** User-authored skills are hot-loaded on each turn so a just-recorded skill
 * works without restarting the desktop app. One hand-edited broken folder is
 * isolated instead of taking down every bot turn. */
export function loadUserSkills(root: string): BundledSkill[] {
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const skills: BundledSkill[] = [];
  for (const name of names) {
    try {
      const skill = loadSkillDirectory(join(root, name), { allowMissingTools: true });
      if (skill) skills.push(skill);
    } catch {
      // The recorder always writes atomically validated folders, but people
      // are free to edit them later. A malformed edit disables only itself.
    }
  }
  return skills;
}

export function mergeSkills(bundled: readonly BundledSkill[], user: readonly BundledSkill[]): BundledSkill[] {
  const byId = new Map(bundled.map((skill) => [skill.manifest.id, skill]));
  for (const skill of user) {
    if (!byId.has(skill.manifest.id)) byId.set(skill.manifest.id, skill);
  }
  return [...byId.values()];
}

export function skillInstructionsFor(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  grantsOrOptions: SkillGrantState & { includeRoot?: boolean } = {},
): string {
  const { includeRoot = false, ...grants } = grantsOrOptions;
  return renderSkillInstructions(selectBundledSkills(text, capabilities, skills, grants), { includeRoot });
}

export function selectBundledSkills(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  grants: SkillGrantState = {},
): BundledSkill[] {
  return decideBundledSkills(text, capabilities, skills, grants).selectedSkills;
}

export function renderSkillInstructions(
  selected: readonly BundledSkill[],
  { includeRoot = false }: { includeRoot?: boolean } = {},
): string {
  if (!selected.length) return "";
  return selected.map(({ manifest, instructions, directory }) =>
    `\n\n<openmaus-skill id=${JSON.stringify(manifest.id)} version=${JSON.stringify(manifest.version)}${includeRoot ? ` root=${JSON.stringify(directory)}` : ""}>\n${instructions}\n</openmaus-skill>`,
  ).join("");
}
