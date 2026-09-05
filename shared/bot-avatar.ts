import { z } from "zod";

/** The mascot is a first-class avatar choice; the other values crop an image. */
export const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/**
 * Procedural avatars extend the app's own mascot renderer.  The values are
 * deliberately small, versioned presets rather than arbitrary SVG: profiles
 * stay portable and persisted data can never inject markup into the renderer.
 */
export const BOT_AVATAR_SILHOUETTES = [
  "cursor",
  "orb",
  "tile",
  "gem",
  "pebble",
  "spark",
  "capsule",
  "shield",
  "leaf",
  "moon",
  "hex",
  "drop",
] as const;
export const BOT_AVATAR_EYE_STYLES = ["balanced", "wide", "calm"] as const;
export const BOT_AVATAR_MOUTH_STYLES = ["soft", "bold", "none"] as const;
export const BOT_AVATAR_PRESET_IDS = [
  "openmaus-cursor",
  "strobi",
  "freddy",
  "citrus",
  "nova",
  "grok-bot",
  "sunee",
  "kirby",
  "cloudee",
  "cubee",
  "onee",
] as const;
export const BOT_AVATAR_RESTING_ANIMATION_IDS = [
  "sleeping",
  "waking",
  "idle",
  "listening",
  "thinking",
  "searching",
  "working",
  "excited",
  "bored",
  "suspicious",
  "angry",
  "drowsy",
  "happy",
  "curious",
  "confused",
  "surprised",
  "proud",
  "shy",
  "sad",
  "laughing",
  "scared",
  "playful",
  "celebrate",
] as const;
export const BOT_AVATAR_EXPRESSION_PRESET_IDS = [
  "steady",
  "bright",
  "grin",
  "soft-focus",
  "wry",
  "side-eye",
  "open",
  "downcast",
  "serious",
  "warm",
  "alert",
  "delighted",
  "pondering",
  "listening",
  "skeptical",
  "surprised",
  "playful",
  "relieved",
  "confident",
  "resting",
] as const;
export const BOT_AVATAR_EXPRESSION_PRESETS = [
  { id: "steady", label: "Steady", expression: 0 },
  { id: "bright", label: "Bright", expression: 1 },
  { id: "grin", label: "Grin", expression: 2 },
  { id: "soft-focus", label: "Soft focus", expression: 3 },
  { id: "wry", label: "Wry", expression: 4 },
  { id: "side-eye", label: "Side-eye", expression: 5 },
  { id: "open", label: "Open", expression: 6 },
  { id: "downcast", label: "Downcast", expression: 7 },
  { id: "serious", label: "Serious", expression: 8 },
  { id: "warm", label: "Warm", expression: 9 },
  { id: "alert", label: "Alert", expression: 10 },
  { id: "delighted", label: "Delighted", expression: 11 },
  { id: "pondering", label: "Pondering", expression: 12 },
  { id: "listening", label: "Listening", expression: 13 },
  { id: "skeptical", label: "Skeptical", expression: 14 },
  { id: "surprised", label: "Surprised", expression: 15 },
  { id: "playful", label: "Playful", expression: 16 },
  { id: "relieved", label: "Relieved", expression: 17 },
  { id: "confident", label: "Confident", expression: 18 },
  { id: "resting", label: "Resting", expression: 19 },
] as const;
export const BOT_AVATAR_COLORS = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
] as const;
export const BOT_AVATAR_RESTING_STATES = ["happy", "curious", "playful", "proud", "idle", "shy"] as const;

export const botProceduralAvatarSchema = z.object({
  version: z.literal(1),
  seed: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  silhouette: z.enum(BOT_AVATAR_SILHOUETTES),
  eyeStyle: z.enum(BOT_AVATAR_EYE_STYLES),
  mouthStyle: z.enum(BOT_AVATAR_MOUTH_STYLES),
  expressionPreset: z.enum(BOT_AVATAR_EXPRESSION_PRESET_IDS).optional(),
  avatarPresetId: z.enum(BOT_AVATAR_PRESET_IDS).optional(),
  restingAnimationId: z.enum(BOT_AVATAR_RESTING_ANIMATION_IDS).optional(),
}).strict();

export type BotProceduralAvatar = z.infer<typeof botProceduralAvatarSchema>;
export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];
export type BotAvatarRestingState = (typeof BOT_AVATAR_RESTING_STATES)[number];
export type BotAvatarRestingAnimation = (typeof BOT_AVATAR_RESTING_ANIMATION_IDS)[number];

export interface GeneratedBotAvatar {
  definition: BotProceduralAvatar;
  color: BotAvatarColor;
  restingState: BotAvatarRestingState;
  restingAnimationId: BotAvatarRestingAnimation;
}

/** Stable FNV-1a plus a tiny PRNG: random once, deterministic everywhere after persistence. */
function seedHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function choose<const T extends readonly unknown[]>(values: T, random: () => number): T[number] {
  return values[Math.floor(random() * values.length)]!;
}

export function generatedBotAvatar(seed: string): GeneratedBotAvatar {
  const cleanSeed = seed.trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "openmaus";
  const random = seededRandom(seedHash(cleanSeed));
  const restingAnimationId = choose(BOT_AVATAR_RESTING_ANIMATION_IDS, random);
  return {
    definition: {
      version: 1,
      seed: cleanSeed,
      silhouette: choose(BOT_AVATAR_SILHOUETTES, random),
      eyeStyle: choose(BOT_AVATAR_EYE_STYLES, random),
      mouthStyle: choose(BOT_AVATAR_MOUTH_STYLES, random),
      expressionPreset: choose(BOT_AVATAR_EXPRESSION_PRESET_IDS, random),
      avatarPresetId: choose(BOT_AVATAR_PRESET_IDS, random),
      restingAnimationId,
    },
    color: choose(BOT_AVATAR_COLORS, random),
    restingState: choose(BOT_AVATAR_RESTING_STATES, random),
    restingAnimationId,
  };
}

/**
 * Custom avatars are deliberately limited to this app's attachment server.
 * Besides making persisted profiles portable across desktop/browser clients,
 * this prevents a bot profile from becoming an external tracking pixel or a
 * script-capable SVG.
 */
export const botAvatarUrlSchema = z
  .string()
  .regex(
    /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/,
    "must be a stored PNG, JPEG, GIF, or WebP attachment",
  );

export function botAvatarUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarUrlSchema.safeParse(url).success ? url : null;
}

/** Runtime-safe defaults for untrusted persisted/SSE profile data. */
export interface BotAvatarProfileInput {
  avatarUrl?: unknown;
  avatarCrop?: unknown;
  avatarDefinition?: unknown;
}

export interface BotAvatarProfile {
  avatarUrl?: string;
  avatarCrop: BotAvatarCrop;
  avatarDefinition?: BotProceduralAvatar;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const profile: BotAvatarProfile = {
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "mascot",
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  const definition = botProceduralAvatarSchema.safeParse(value.avatarDefinition);
  if (definition.success) profile.avatarDefinition = definition.data;
  return profile;
}
