import { parse as parseYaml } from "yaml";
import { botProceduralAvatarSchema, type BotProceduralAvatar } from "../../shared/bot-avatar";
import { MAUS_COLOR_NAMES, MAUS_STATES, type MausColor, type MausState } from "./mascot";

export interface PendingTeamImportMember {
  key: string;
  name: string;
  title: string;
  description: string;
  appearance?: {
    color: MausColor;
    avatarDefinition?: BotProceduralAvatar;
    mascotExpression?: MausState;
  };
}

export interface PendingTeamImportRoom { name: string; members: string[]; defaultResponder: string; bulletin: string }
export interface PendingTeamImportPlaybook { name: string; summary: string; triggers: string[]; instructions: string }
export interface PendingTeamImportSkill { id: string; name: string; description: string; capabilities: string[]; tools: string[]; origin: string }
export interface PendingTeamImportRoutine { name: string; owner: string; prompt: string; schedule: string; runOn: string; duration: string; status: "Paused after import" }

export interface PendingTeamImport {
  manifest: unknown;
  kind: "team" | "package";
  name: string;
  description: string;
  authorName?: string;
  members: PendingTeamImportMember[];
  chiefOfStaff?: string;
  rooms: number;
  playbooks: number;
  routines: number;
  skills: number;
  apps: Array<{ label: string; optional: boolean }>;
  roomEntries: PendingTeamImportRoom[];
  playbookEntries: PendingTeamImportPlaybook[];
  skillEntries: PendingTeamImportSkill[];
  routineEntries: PendingTeamImportRoutine[];
}

// Mirrors the server's exported BOT_INSTRUCTIONS_MAX_CHARS boundary. This
// client-only preview must neither truncate nor accept more than the import
// parser that remains the trust boundary.
const BOT_INSTRUCTIONS_MAX_CHARS = 24_000;

export function isGrokRecipeFile(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["profile", "memory", "skills", "routines", "plugins"]
    .every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" && value.trim().length <= max ? value.trim() : "";
}

function boundedList(value: unknown, maxItems: number, maxText: number): string[] {
  return Array.isArray(value) ? value.slice(0, maxItems).map((item) => boundedText(item, maxText)).filter(Boolean) : [];
}

function humanSchedule(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Not specified";
  const schedule = value as Record<string, unknown>;
  if (schedule.type === "manual") return "Manual only";
  if (schedule.type === "daily") return `Daily at ${boundedText(schedule.time, 5) || "unspecified time"}`;
  if (schedule.type === "once" && typeof schedule.at === "number") return `Once · ${new Date(schedule.at).toLocaleString()}`;
  return "Not specified";
}

function responderLabel(value: unknown, agents: Map<string, string>): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Mentions only";
  const responder = value as Record<string, unknown>;
  if (responder.kind === "everyone") return "Everyone";
  if (responder.kind === "agent") return agents.get(boundedText(responder.agent, 64)) ?? "Named agent";
  return "Mentions only";
}

function safeAppearance(value: unknown): PendingTeamImportMember["appearance"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const color = MAUS_COLOR_NAMES.includes(source.color as MausColor) ? source.color as MausColor : undefined;
  const avatar = botProceduralAvatarSchema.safeParse(source.avatarDefinition);
  const mascotExpression = typeof source.mascotExpression === "string" && source.mascotExpression.trim().length <= 80 && MAUS_STATES.includes(source.mascotExpression.trim() as MausState)
    ? source.mascotExpression.trim() as MausState
    : undefined;
  if (!color && !avatar.success && !mascotExpression) return undefined;
  return {
    color: color ?? "green",
    ...(avatar.success ? { avatarDefinition: avatar.data } : {}),
    ...(mascotExpression ? { mascotExpression } : {}),
  };
}

function safeMember(value: unknown, index: number): PendingTeamImportMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Bot ${index + 1} is invalid.`);
  const source = value as Record<string, unknown>;
  const name = boundedText(source.name, 100);
  if (!name) throw new Error(`Bot ${index + 1} does not have a name.`);
  return {
    key: boundedText(source.key, 100) || `member-${index + 1}`,
    name,
    title: boundedText(source.title, 200),
    description: boundedText(source.description, BOT_INSTRUCTIONS_MAX_CHARS),
    appearance: safeAppearance(source.appearance),
  };
}

/** Small client-side preview only; the server remains the trust boundary. */
export function teamImportPreview(manifest: unknown): PendingTeamImport {
  if (typeof manifest === "string") manifest = markdownPackage(manifest);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("This file does not contain a team.");
  }
  const root = manifest as Record<string, unknown>;
  if (root.format === "openmaus.package") return packagePreview(root, manifest);
  if (root.format !== "openmaus.team") throw new Error("This is not a BotMRR playbook or legacy OpenMaus team.");
  if (root.version !== 1 && root.version !== 2) throw new Error(`Team file version ${String(root.version)} is not supported.`);
  if (!root.team || typeof root.team !== "object" || Array.isArray(root.team)) {
    throw new Error("This team file is missing its team definition.");
  }
  const team = root.team as Record<string, unknown>;
  if (typeof team.name !== "string" || !team.name.trim()) throw new Error("This team does not have a name.");
  if (!Array.isArray(team.members) || team.members.length === 0) throw new Error("This team has no members.");
  if (team.members.length > 200) throw new Error("This team has too many members.");
  const members = team.members.map((member, index) => safeMember(member, index));
  return {
    manifest,
    kind: "team",
    name: team.name.trim(),
    description: typeof team.description === "string" ? team.description.trim() : "",
    members,
    rooms: root.version === 1 && team.room && typeof team.room === "object" ? 1 : 0,
    playbooks: 0,
    routines: 0,
    skills: 0,
    apps: [],
    roomEntries: [], playbookEntries: [], skillEntries: [], routineEntries: [],
  };
}

function markdownPackage(markdown: string): unknown {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error("This Markdown is missing its BotMRR frontmatter.");
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]);
  } catch {
    throw new Error("This Markdown has invalid YAML frontmatter.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("This Markdown is missing its BotMRR blueprint.");
  }
  const { botmrr, ...pkg } = metadata as Record<string, unknown>;
  if (botmrr !== 1) throw new Error("This BotMRR Markdown version is not supported.");
  return { format: "openmaus.package", version: 1, package: pkg };
}

function packagePreview(root: Record<string, unknown>, manifest: unknown): PendingTeamImport {
  if (root.version !== 1) throw new Error(`BotMRR playbook version ${String(root.version)} is not supported.`);
  if (!root.package || typeof root.package !== "object" || Array.isArray(root.package)) {
    throw new Error("This playbook is missing its team definition.");
  }
  const pkg = root.package as Record<string, unknown>;
  if (typeof pkg.name !== "string" || !pkg.name.trim()) throw new Error("This playbook does not have a name.");
  if (!Array.isArray(pkg.agents) || pkg.agents.length === 0) throw new Error("This playbook has no bots.");
  if (pkg.agents.length > 200) throw new Error("This playbook has too many bots.");
  const members = pkg.agents.map((agent, index) => safeMember(agent, index));
  const chiefKey = typeof pkg.chiefOfStaff === "string" ? pkg.chiefOfStaff : undefined;
  const chief = chiefKey
    ? (pkg.agents as Array<Record<string, unknown>>).find((agent) => agent.key === chiefKey)?.name
    : undefined;
  const agentNames = new Map(members.map((member) => [member.key, member.name]));
  const requirements = pkg.requirements && typeof pkg.requirements === "object" && !Array.isArray(pkg.requirements)
    ? pkg.requirements as Record<string, unknown>
    : {};
  const apps = Array.isArray(requirements.apps)
    ? requirements.apps.flatMap((app) => {
        if (!app || typeof app !== "object" || Array.isArray(app)) return [];
        const value = app as Record<string, unknown>;
        return typeof value.label === "string"
          ? [{ label: value.label.trim(), optional: value.optional === true }]
          : [];
      })
      : [];
  const skills = pkg.skills && typeof pkg.skills === "object" && !Array.isArray(pkg.skills) && Array.isArray((pkg.skills as Record<string, unknown>).entries)
    ? ((pkg.skills as Record<string, unknown>).entries as unknown[]).length
    : 0;
  const roomEntries = Array.isArray(pkg.rooms) ? pkg.rooms.slice(0, 30).flatMap((room) => {
    if (!room || typeof room !== "object" || Array.isArray(room)) return [];
    const value = room as Record<string, unknown>;
    return [{ name: boundedText(value.name, 100) || "Unnamed room", members: boundedList(value.members, 200, 64).map((key) => agentNames.get(key) ?? key), defaultResponder: responderLabel(value.defaultResponder, agentNames), bulletin: boundedText(value.bulletin, 12_000) }];
  }) : [];
  const playbookEntries = Array.isArray(pkg.playbooks) ? pkg.playbooks.slice(0, 80).flatMap((playbook) => {
    if (!playbook || typeof playbook !== "object" || Array.isArray(playbook)) return [];
    const value = playbook as Record<string, unknown>;
    return [{ name: boundedText(value.name, 100) || "Unnamed playbook", summary: boundedText(value.summary, 300), triggers: boundedList(value.triggers, 30, 100), instructions: boundedText(value.instructions, 24_000) }];
  }) : [];
  const skillEntries = pkg.skills && typeof pkg.skills === "object" && !Array.isArray(pkg.skills) && Array.isArray((pkg.skills as Record<string, unknown>).entries)
    ? ((pkg.skills as Record<string, unknown>).entries as unknown[]).slice(0, 30).flatMap((skill) => {
      if (!skill || typeof skill !== "object" || Array.isArray(skill)) return [];
      const value = skill as Record<string, unknown>;
      return [{ id: boundedText(value.id, 64), name: boundedText(value.name, 100), description: boundedText(value.description, 1_024), capabilities: boundedList(value.requiredCapabilities, 30, 120), tools: boundedList(value.tools, 30, 120), origin: boundedText(value.origin, 40) }];
    }) : [];
  const routineEntries = Array.isArray(pkg.routines) ? pkg.routines.slice(0, 50).flatMap((routine) => {
    if (!routine || typeof routine !== "object" || Array.isArray(routine)) return [];
    const value = routine as Record<string, unknown>;
    return [{ name: boundedText(value.name, 80) || "Unnamed routine", owner: agentNames.get(boundedText(value.agent, 64)) ?? boundedText(value.agent, 64), prompt: boundedText(value.prompt, 20_000), schedule: humanSchedule(value.schedule), runOn: boundedText(value.runOn, 20), duration: typeof value.durationMinutes === "number" ? `${value.durationMinutes} min` : "Not specified", status: "Paused after import" as const }];
  }) : [];
  return {
    manifest,
    kind: "package",
    name: pkg.name.trim(),
    description: typeof pkg.summary === "string" ? pkg.summary.trim() : "",
    ...(pkg.author && typeof pkg.author === "object" && !Array.isArray(pkg.author) && boundedText((pkg.author as Record<string, unknown>).name, 100)
      ? { authorName: boundedText((pkg.author as Record<string, unknown>).name, 100) }
      : {}),
    members,
    ...(typeof chief === "string" ? { chiefOfStaff: chief } : {}),
    rooms: Array.isArray(pkg.rooms) ? pkg.rooms.length : 0,
    playbooks: Array.isArray(pkg.playbooks) ? pkg.playbooks.length : 0,
    routines: Array.isArray(pkg.routines) ? pkg.routines.length : 0,
    skills,
    apps,
    roomEntries, playbookEntries, skillEntries, routineEntries,
  };
}
