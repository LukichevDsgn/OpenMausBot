import {
  DEFAULT_SILHOUETTE,
  type CursorSilhouette,
} from "@/components/CursorAvatar";
import {
  BOT_AVATAR_EXPRESSION_PRESETS,
  botProceduralAvatarSchema,
  type BotProceduralAvatar,
} from "../../shared/bot-avatar";

export const DEFAULT_PROCEDURAL_AVATAR: BotProceduralAvatar = {
  version: 1,
  seed: "default",
  silhouette: "cursor",
  eyeStyle: "balanced",
  mouthStyle: "soft",
  expressionPreset: "steady",
};

/** Returns a complete safe preset before applying an avatar-lab edit. */
export function proceduralAvatarDefinition(definition?: BotProceduralAvatar | null): BotProceduralAvatar {
  if (!definition) return DEFAULT_PROCEDURAL_AVATAR;
  return botProceduralAvatarSchema.safeParse(definition).success ? definition : DEFAULT_PROCEDURAL_AVATAR;
}

/** Changes only body geometry; persisted seed and face settings stay intact. */
export function patchProceduralAvatarSilhouette(
  definition: BotProceduralAvatar | null | undefined,
  silhouette: BotProceduralAvatar["silhouette"],
): BotProceduralAvatar {
  return { ...proceduralAvatarDefinition(definition), silhouette };
}

/** Changes only the legacy persisted face preset; visible geometry uses the shared face rig. */
export function patchProceduralAvatarExpression(
  definition: BotProceduralAvatar | null | undefined,
  expressionPreset: BotProceduralAvatar["expressionPreset"],
): BotProceduralAvatar {
  return { ...proceduralAvatarDefinition(definition), expressionPreset };
}

const authoredSilhouette = (
  name: string,
  markup: string,
  anchor: CursorSilhouette["anchor"] = { x: 114, y: 118, scale: 0.78 },
): CursorSilhouette => ({
  name,
  fit: "",
  body: markup.replace('fill="currentColor"', 'fill="{{GRADIENT}}"'),
  clip: markup.replace(' fill="currentColor"', ""),
  anchor,
});

const cursor: CursorSilhouette = {
  ...DEFAULT_SILHOUETTE,
  body: DEFAULT_SILHOUETTE.body.replace(/fill="#000000"/g, 'fill="{{GRADIENT}}"'),
};

export const PROCEDURAL_AVATAR_SILHOUETTES = {
  cursor,
  orb: authoredSilhouette(
    "orb",
    '<circle xmlns="http://www.w3.org/2000/svg" cx="114.27" cy="114.27" r="102" fill="currentColor"/>',
  ),
  tile: authoredSilhouette(
    "rounded tile",
    '<rect xmlns="http://www.w3.org/2000/svg" x="18" y="22" width="193" height="187" rx="61" fill="currentColor"/>',
  ),
  gem: authoredSilhouette(
    "soft gem",
    '<path xmlns="http://www.w3.org/2000/svg" d="M114 8 C137 8 199 67 207 91 C215 116 167 199 141 214 C116 228 29 190 17 164 C5 139 50 35 76 20 C87 13 101 8 114 8 Z" fill="currentColor"/>',
  ),
  pebble: authoredSilhouette(
    "pebble",
    '<path xmlns="http://www.w3.org/2000/svg" d="M78 15 C113 1 176 20 198 51 C222 85 211 149 187 183 C164 215 94 222 53 201 C13 181 1 118 18 77 C29 49 48 27 78 15 Z" fill="currentColor"/>',
  ),
  spark: authoredSilhouette(
    "soft spark",
    '<path xmlns="http://www.w3.org/2000/svg" d="M114 5 C128 5 138 51 151 61 C162 70 207 57 215 70 C223 83 187 112 184 127 C181 143 207 181 196 192 C185 204 147 179 132 184 C117 189 95 225 81 218 C67 211 74 166 65 153 C56 141 12 132 13 117 C14 102 59 95 69 84 C79 72 74 27 88 20 C97 15 105 5 114 5 Z" fill="currentColor"/>',
    { x: 114, y: 119, scale: 0.73 },
  ),
  capsule: authoredSilhouette(
    "capsule",
    '<rect xmlns="http://www.w3.org/2000/svg" x="35" y="8" width="158" height="212" rx="79" fill="currentColor"/>',
    { x: 114, y: 116, scale: 0.76 },
  ),
  shield: authoredSilhouette(
    "shield",
    '<path xmlns="http://www.w3.org/2000/svg" d="M114 10 Q117 10 120 12 L193 38 Q204 42 204 53 V102 C204 157 168 194 121 215 Q114 218 107 215 C60 194 24 157 24 102 V53 Q24 42 35 38 L108 12 Q111 10 114 10 Z" fill="currentColor"/>',
    { x: 114, y: 119, scale: 0.76 },
  ),
  leaf: authoredSilhouette(
    "leaf",
    '<path xmlns="http://www.w3.org/2000/svg" d="M205 18 C135 13 62 35 28 91 C2 134 23 190 67 211 C116 234 176 198 197 145 C211 110 210 57 205 18 Z" fill="currentColor"/>',
    { x: 112, y: 124, scale: 0.75 },
  ),
  moon: authoredSilhouette(
    "moon",
    '<path xmlns="http://www.w3.org/2000/svg" d="M185 26 C157 18 128 22 104 38 C69 61 51 104 59 144 C68 190 108 218 151 215 C178 213 200 198 216 177 C179 181 143 163 130 132 C115 96 134 54 185 26 Z" fill="currentColor"/>',
    { x: 110, y: 119, scale: 0.78 },
  ),
  hex: authoredSilhouette(
    "hex",
    '<path xmlns="http://www.w3.org/2000/svg" d="M61 12 H167 L216 64 V164 L167 216 H61 L12 164 V64 Z" fill="currentColor"/>',
    { x: 114, y: 116, scale: 0.78 },
  ),
  drop: authoredSilhouette(
    "drop",
    '<path xmlns="http://www.w3.org/2000/svg" d="M114 7 C114 7 28 96 28 148 C28 192 66 220 114 220 C162 220 200 192 200 148 C200 96 114 7 114 7 Z" fill="currentColor"/>',
    { x: 114, y: 121, scale: 0.76 },
  ),
} satisfies Record<BotProceduralAvatar["silhouette"], CursorSilhouette>;

export const PROCEDURAL_AVATAR_SILHOUETTE_LABELS = {
  cursor: "Cursor",
  orb: "Orb",
  tile: "Tile",
  gem: "Gem",
  pebble: "Pebble",
  spark: "Spark",
  capsule: "Capsule",
  shield: "Shield",
  leaf: "Leaf",
  moon: "Moon",
  hex: "Hex",
  drop: "Drop",
} satisfies Record<BotProceduralAvatar["silhouette"], string>;

/**
 * The picker has one branded Cursor surface. These legacy ids stay valid in
 * persisted data, but are intentionally not offered as new choices.
 */
export const VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES = [
  "orb",
  "tile",
  "gem",
  "pebble",
  "spark",
  "capsule",
  "shield",
  "leaf",
  "drop",
] as const satisfies readonly BotProceduralAvatar["silhouette"][];

const LEGACY_PROCEDURAL_SILHOUETTE_FALLBACKS = {
  cursor: "cursor",
  moon: "orb",
  hex: "tile",
} as const;

/** Resolve old hidden ids for rendering without changing the stored record. */
export function resolvedProceduralSilhouette(
  silhouette: BotProceduralAvatar["silhouette"],
): BotProceduralAvatar["silhouette"] {
  return LEGACY_PROCEDURAL_SILHOUETTE_FALLBACKS[silhouette as keyof typeof LEGACY_PROCEDURAL_SILHOUETTE_FALLBACKS]
    ?? silhouette;
}

export function proceduralAvatarPresentation(definition?: BotProceduralAvatar | null) {
  const avatar = proceduralAvatarDefinition(definition);
  const resolvedSilhouette = resolvedProceduralSilhouette(avatar.silhouette);
  const expression = BOT_AVATAR_EXPRESSION_PRESETS.find(
    (preset) => preset.id === avatar.expressionPreset,
  )?.expression;
  return {
    /** Legacy cursor is the branded OpenMaus Cursor surface. */
    surface: resolvedSilhouette === "cursor" ? "openmaus-cursor" : `procedural:${resolvedSilhouette}`,
    sourceSilhouette: avatar.silhouette,
    silhouette: PROCEDURAL_AVATAR_SILHOUETTES[resolvedSilhouette],
    expression,
    eyeScale: avatar.eyeStyle === "wide" ? 1.18 : avatar.eyeStyle === "calm" ? 0.88 : 1,
    // Every visible mascot keeps the small white mark; the legacy "none"
    // value remains parseable but can no longer produce an eyes-only face.
    showMouth: true,
    mouthStroke: avatar.mouthStyle === "bold" ? 6.5 : 4,
  };
}
