import { generatedBotAvatar } from "../shared/bot-avatar.ts";
import { z } from "zod";
import { stringify as stringifyYaml } from "yaml";
import { parseBotPackage, type ParsedBotPackage } from "./bot-package.ts";
import { BOT_INSTRUCTIONS_MAX_CHARS } from "./team-manifest.ts";

export const GROK_BOT_TEMPLATE_ENDPOINT =
  "https://api2.cursor.sh/aiserver.v1.GrokBotService/GetPublicGrokBotTemplate";
export const GROK_BOT_RESPONSE_MAX_BYTES = 64 * 1024;
export const GROK_BOT_INSTRUCTION_MAX_CHARS = BOT_INSTRUCTIONS_MAX_CHARS;
export const GROK_BOT_TIMEOUT_MS = 10_000;
export const GROK_BOT_RECIPE_MAX_BYTES = 26_214_400;

const recipeText = (max: number) => z.string({ error: "must be text" })
  .trim()
  .min(1, { message: "is required" })
  .max(max, { message: "is too long" });

const grokBotRecipeSchema = z.object({
  profile: z.object({
    name: recipeText(100),
    description: recipeText(BOT_INSTRUCTIONS_MAX_CHARS),
    title: recipeText(200),
    avatarColor: recipeText(80).optional(),
    avatarShape: recipeText(80).optional(),
  }).strict(),
  memory: z.array(z.object({
    kind: z.enum(["profile", "log"]).optional(),
    createdAt: z.union([recipeText(80), z.number().finite()]).optional(),
    content: recipeText(BOT_INSTRUCTIONS_MAX_CHARS),
  }).strict()).max(200),
  skills: z.array(z.object({
    name: recipeText(100),
    description: recipeText(1_024),
    content: recipeText(256 * 1024),
  }).strict()).max(30),
  routines: z.array(z.object({
    name: recipeText(80),
    slug: recipeText(100),
    description: recipeText(2_000),
    content: recipeText(20_000),
  }).strict()).max(50),
  plugins: z.array(z.object({
    name: recipeText(100),
    description: recipeText(240).optional(),
    pluginId: recipeText(200),
  }).strict()).max(30),
}).strict();

export type GrokBotRecipe = z.infer<typeof grokBotRecipeSchema>;

export interface ParsedGrokBotUrl {
  id: string;
}

export interface GrokBotTemplate {
  shareId: string;
  name: string;
  avatarShape?: string;
  avatarColor?: string;
  published: boolean;
  activeVersion?: string;
  description: string;
}

export interface GrokBotTemplateResponse {
  template: GrokBotTemplate;
  ownerDisplayName?: string;
}

/** Parse only the two public, non-authenticated Grok Bot deep-link forms. */
export function parseGrokBotUrl(input: string): ParsedGrokBotUrl {
  if (typeof input !== "string") throw new Error("Enter a public Grok Bot link");
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a public Grok Bot link");
  }

  if (url.protocol === "https:") {
    const authority = raw.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? "";
    if (
      url.hostname !== "x.ai" ||
      authority.includes(":") ||
      url.username ||
      url.password ||
      url.port ||
      raw.includes("?") ||
      raw.includes("#")
    ) {
      throw new Error("Only public x.ai Grok Bot links are supported");
    }
    const match = url.pathname.match(/^\/bot\/([A-Za-z0-9_-]{21})\/?$/);
    if (!match) throw new Error("The x.ai link must point to a public Grok Bot");
    return { id: match[1]! };
  }

  if (url.protocol === "grokbot:") {
    if (
      url.hostname !== "app" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/v1/bot-template" ||
      url.hash ||
      raw.includes("#")
    ) {
      throw new Error("The Grok Bot app link is not supported");
    }
    const query = url.search.match(/^\?id=([A-Za-z0-9_-]{21})$/);
    if (!query) throw new Error("The Grok Bot app link must contain exactly one bot id");
    return { id: query[1]! };
  }

  throw new Error("Only public x.ai Grok Bot links are supported");
}

class ProtoReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  readVarint(): number {
    let value = 0;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) throw new Error("truncated protobuf");
      const byte = this.bytes[this.offset++]!;
      if (index === 9 && byte > 1) throw new Error("invalid protobuf varint");
      value += (byte & 0x7f) * 2 ** (7 * index);
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) throw new Error("invalid protobuf varint");
        return value;
      }
    }
    throw new Error("invalid protobuf varint");
  }

  readBytes(): Uint8Array {
    const length = this.readVarint();
    if (!Number.isSafeInteger(length) || length > GROK_BOT_RESPONSE_MAX_BYTES) {
      throw new Error("protobuf field is too large");
    }
    const end = this.offset + length;
    if (end > this.bytes.length) throw new Error("truncated protobuf");
    const value = this.bytes.slice(this.offset, end);
    this.offset = end;
    return value;
  }

  readString(): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.readBytes());
    } catch {
      throw new Error("invalid protobuf text");
    }
  }

  readFixed(length: 4 | 8): void {
    if (this.offset + length > this.bytes.length) throw new Error("truncated protobuf");
    this.offset += length;
  }

  readKey(): { field: number; wireType: number } {
    const key = this.readVarint();
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (!Number.isSafeInteger(field) || field < 1) throw new Error("invalid protobuf field key");
    return { field, wireType };
  }
}

function skipField(reader: ProtoReader, wireType: number, depth = 0): void {
  if (depth > 16) throw new Error("protobuf nesting is too deep");
  if (wireType === 0) {
    reader.readVarint();
    return;
  }
  if (wireType === 1) {
    reader.readFixed(8);
    return;
  }
  if (wireType === 2) {
    reader.readBytes();
    return;
  }
  if (wireType === 3) {
    for (;;) {
      if (reader.done) throw new Error("truncated protobuf group");
      const nested = reader.readKey();
      if (nested.wireType === 4) return;
      skipField(reader, nested.wireType, depth + 1);
    }
  }
  if (wireType === 4) throw new Error("unexpected protobuf group end");
  if (wireType === 5) {
    reader.readFixed(4);
    return;
  }
  throw new Error("unsupported protobuf wire type");
}

function decodeTemplate(bytes: Uint8Array): GrokBotTemplate {
  const reader = new ProtoReader(bytes);
  let shareId: string | undefined;
  let name: string | undefined;
  let avatarShape: string | undefined;
  let avatarColor: string | undefined;
  let published: boolean | undefined;
  let activeVersion: string | undefined;
  let description: string | undefined;
  const seen = new Set<number>();

  while (!reader.done) {
    const { field, wireType } = reader.readKey();
    if (field === 1 || field === 2 || field === 3 || field === 4 || field === 12) {
      if (wireType !== 2) throw new Error("invalid Grok Bot text field");
      if (seen.has(field)) throw new Error("duplicate Grok Bot field");
      seen.add(field);
      const value = reader.readString();
      if (field === 1) shareId = value;
      else if (field === 2) name = value;
      else if (field === 3) avatarShape = value;
      else if (field === 4) avatarColor = value;
      else description = value;
      continue;
    }
    if (field === 10) {
      if (wireType !== 0 || seen.has(field)) throw new Error("invalid Grok Bot published field");
      seen.add(field);
      const value = reader.readVarint();
      if (value !== 0 && value !== 1) throw new Error("invalid Grok Bot published value");
      published = value === 1;
      continue;
    }
    if (field === 11) {
      // The donor has changed the active-version message shape over time.
      // It is deliberately not imported; skip its bounded wire value while
      // retaining strict framing for every supported protobuf wire type.
      if (seen.has(field)) throw new Error("duplicate Grok Bot field");
      seen.add(field);
      if (wireType === 2) activeVersion = reader.readString();
      else skipField(reader, wireType);
      continue;
    }
    skipField(reader, wireType);
  }

  if (shareId === undefined || name === undefined || published === undefined || description === undefined) {
    throw new Error("Grok Bot response is missing required fields");
  }
  return { shareId, name, avatarShape, avatarColor, published, activeVersion, description };
}

function decodeResponse(bytes: Uint8Array): GrokBotTemplateResponse {
  const reader = new ProtoReader(bytes);
  let template: GrokBotTemplate | undefined;
  let ownerDisplayName: string | undefined;
  const seen = new Set<number>();
  while (!reader.done) {
    const { field, wireType } = reader.readKey();
    if (field === 1) {
      if (wireType !== 2 || seen.has(field)) throw new Error("invalid Grok Bot template field");
      seen.add(field);
      template = decodeTemplate(reader.readBytes());
    } else if (field === 2) {
      if (wireType !== 2 || seen.has(field)) throw new Error("invalid Grok Bot owner field");
      seen.add(field);
      ownerDisplayName = reader.readString();
    } else {
      skipField(reader, wireType);
    }
  }
  if (!template) throw new Error("Grok Bot response has no template");
  return { template, ownerDisplayName };
}

function encodeShareId(shareId: string): Uint8Array {
  const value = new TextEncoder().encode(shareId);
  const result = new Uint8Array(2 + value.length);
  result[0] = 0x0a;
  result[1] = value.length;
  result.set(value, 2);
  return result;
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > GROK_BOT_RESPONSE_MAX_BYTES) {
    throw new Error("Grok Bot response is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > GROK_BOT_RESPONSE_MAX_BYTES) throw new Error("Grok Bot response is too large");
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function fetchGrokBotTemplate(input: string, fetcher: typeof fetch = fetch): Promise<GrokBotTemplateResponse> {
  const { id } = parseGrokBotUrl(input);
  let response: Response;
  try {
    response = await fetcher(GROK_BOT_TEMPLATE_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "connect-protocol-version": "1",
      },
      body: encodeShareId(id),
      redirect: "error",
      signal: AbortSignal.timeout(GROK_BOT_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Grok Bot request failed");
  }
  if (!response.ok) throw new Error("Grok Bot request failed");
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(response);
    return decodeResponse(bytes);
  } catch (error) {
    if (error instanceof Error && error.message === "Grok Bot response is too large") throw error;
    throw new Error("Grok Bot response is invalid");
  }
}

function publicTemplate(response: GrokBotTemplateResponse, expectedShareId: string): GrokBotTemplate {
  const template = response.template;
  if (template.shareId !== expectedShareId) throw new Error("Grok Bot response is invalid");
  const name = template.name.trim();
  const description = template.description.trim();
  if (!template.published) throw new Error("Grok Bot profile is unpublished");
  if (!description) throw new Error("Grok Bot public instructions are empty");
  if (template.description.length > GROK_BOT_INSTRUCTION_MAX_CHARS || description.length > GROK_BOT_INSTRUCTION_MAX_CHARS) {
    throw new Error("Grok Bot public instructions are too large");
  }
  if (!name || name.length > 100) throw new Error("Grok Bot response is invalid");
  return { ...template, name, description };
}

const MAUS_COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"] as const;

export function grokBotTemplateToPackage(
  template: GrokBotTemplate,
  expectedShareId = template.shareId,
  ownerDisplayName?: string,
): ParsedBotPackage {
  const publicProfile = publicTemplate({ template, ownerDisplayName }, expectedShareId);
  const avatarSeed = [
    "grok",
    publicProfile.avatarShape?.trim() || "avatar",
    publicProfile.avatarColor?.trim() || "color",
    publicProfile.shareId,
  ].join("-");
  const avatar = generatedBotAvatar(avatarSeed);
  const publicColor = publicProfile.avatarColor?.trim().toLowerCase();
  const importedColor = MAUS_COLORS.find((color) => color === publicColor) ?? avatar.color;
  const author = ownerDisplayName?.trim();
  return parseBotPackage({
    format: "openmaus.package",
    version: 1,
    package: {
      id: `grok-${publicProfile.shareId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      release: "1.0.0",
      name: publicProfile.name,
      tagline: "Public Grok Bot profile instructions",
      summary: "Imported from the public Grok Bot profile.",
      category: "Grok Bot",
      author: { name: author && author.length <= 100 ? author : "Grok" },
      license: "Public profile",
      outcomes: ["Follow the public profile instructions."],
      setupMinutes: 1,
      requirements: { apps: [], capabilities: [] },
      agents: [{
        key: "grok-bot",
        name: publicProfile.name,
        title: "Grok Bot",
        description: publicProfile.description,
        appearance: {
          color: importedColor,
          avatarDefinition: avatar.definition,
        },
      }],
    },
  });
}

export async function fetchGrokBotPackage(input: string, fetcher: typeof fetch = fetch): Promise<ParsedBotPackage> {
  const { id } = parseGrokBotUrl(input);
  const response = await fetchGrokBotTemplate(input, fetcher);
  return grokBotTemplateToPackage(response.template, id, response.ownerDisplayName);
}

function recipeInput(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    throw new Error("Grok Bot recipe is invalid");
  }
  if (Buffer.byteLength(serialized, "utf8") > GROK_BOT_RECIPE_MAX_BYTES) {
    throw new Error("Grok Bot recipe is too large");
  }
  try {
    // Reparse even object input. This drops prototypes/accessors and ensures
    // schema reads only the own JSON data supplied at the import boundary.
    return JSON.parse(serialized);
  } catch {
    throw new Error("Grok Bot recipe is invalid JSON");
  }
}

export function isGrokBotRecipe(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["profile", "memory", "skills", "routines", "plugins"]
    .every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function portableSlug(value: string, fallback: string, used: Set<string>): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56) || fallback;
  let slug = stem;
  for (let suffix = 2; used.has(slug); suffix += 1) {
    const suffixText = `-${suffix}`;
    slug = `${stem.slice(0, 64 - suffixText.length)}${suffixText}`;
  }
  used.add(slug);
  return slug;
}

/** Convert one complete, published Grok Bot recipe into the existing BotMRR
 * package substrate. Memories and credentials deliberately have no output
 * field, and manual routines have no invented wall-clock schedule. */
export function grokBotRecipeToPackage(value: unknown): ParsedBotPackage {
  const parsed = grokBotRecipeSchema.safeParse(recipeInput(value));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new Error(`Grok Bot recipe is invalid${path}: ${issue?.message ?? "invalid value"}`);
  }
  const recipe = parsed.data;
  const agentKey = "grok-bot";
  const skillIds = new Set<string>();
  const skills = recipe.skills.map((skill, index) => {
    const id = portableSlug(skill.name, `skill-${index + 1}`, skillIds);
    const frontmatter = stringifyYaml({ name: id, description: skill.description }, { lineWidth: 0 }).trim();
    return {
      id,
      name: skill.name,
      version: "1.0.0",
      description: skill.description,
      defaultEnabled: false,
      triggerTerms: [skill.name],
      requiredCapabilities: [],
      tools: [],
      origin: "imported" as const,
      source: "grok-recipe",
      instructions: `---\n${frontmatter}\n---\n\n${skill.content}`,
    };
  });
  const routineKeys = new Set<string>();
  const routines = recipe.routines.map((routine, index) => ({
    key: portableSlug(routine.slug, `routine-${index + 1}`, routineKeys),
    name: routine.name,
    agent: agentKey,
    prompt: `${routine.description}\n\n${routine.content}`,
    runOn: "maus" as const,
    schedule: { type: "manual" as const },
    durationMinutes: 30,
    enabledAfterInstall: false as const,
  }));
  const pluginSlugs = new Set<string>();
  const apps = recipe.plugins.map((plugin, index) => ({
    slug: portableSlug(plugin.name, `plugin-${index + 1}`, pluginSlugs),
    label: plugin.name,
    reason: plugin.description || `Connect ${plugin.name} after import.`,
    optional: true,
  }));
  const avatarSeed = [
    "grok-recipe",
    recipe.profile.avatarShape || "avatar",
    recipe.profile.avatarColor || "color",
    recipe.profile.name,
  ].join("-");
  const avatar = generatedBotAvatar(avatarSeed);
  const requestedColor = recipe.profile.avatarColor?.toLowerCase();
  const importedColor = MAUS_COLORS.find((color) => color === requestedColor) ?? avatar.color;
  const packageIds = new Set<string>();
  const packageId = portableSlug(recipe.profile.name, "grok-bot", packageIds);

  return parseBotPackage({
    format: "openmaus.package",
    version: 1,
    package: {
      id: `grok-recipe-${packageId}`,
      release: "1.0.0",
      name: recipe.profile.name,
      tagline: recipe.profile.title.slice(0, 160),
      summary: "Imported from a complete published Grok Bot recipe.",
      category: "Grok Bot",
      author: { name: "Grok" },
      license: "Imported recipe",
      outcomes: ["Follow the imported recipe instructions."],
      setupMinutes: Math.min(240, Math.max(1, apps.length * 2 + 1)),
      requirements: { apps, capabilities: [] },
      agents: [{
        key: agentKey,
        name: recipe.profile.name,
        title: recipe.profile.title,
        description: recipe.profile.description,
        appearance: { color: importedColor, avatarDefinition: avatar.definition },
        ...(skills.length ? { skillIds: skills.map((skill) => skill.id) } : {}),
      }],
      ...(skills.length ? { skills: { version: 1 as const, entries: skills } } : {}),
      ...(routines.length ? { routines } : {}),
    },
  });
}
