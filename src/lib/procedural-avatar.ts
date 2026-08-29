import {
  DEFAULT_SILHOUETTE,
  type CursorSilhouette,
} from "@/components/CursorAvatar";
import {
  botProceduralAvatarSchema,
  type BotProceduralAvatar,
} from "../../shared/bot-avatar";

export const DEFAULT_PROCEDURAL_AVATAR: BotProceduralAvatar = {
  version: 1,
  seed: "openmaus",
  silhouette: "cursor",
};

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

type FaceSafeZone = Readonly<{
  left: number;
  right: number;
  top: number;
  bottom: number;
}>;

export type ProceduralAvatarPresentation = Readonly<{
  surface: string;
  silhouette: CursorSilhouette;
  opticalScale: number;
  normalizedBounds: Readonly<{ width: number; height: number }>;
  normalizedVisualArea: number;
  faceScale: number;
  faceOffset: Readonly<{ x: number; y: number }>;
  faceSafeZone: FaceSafeZone;
  brandedException?: true;
}>;

export const AVATAR_OPTICAL_AREA_BAND = {
  min: 0.46,
  max: 0.48,
  brandedMin: 0.62,
  brandedMax: 0.72,
} as const;

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

const SILHOUETTES = {
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
    '<path xmlns="http://www.w3.org/2000/svg" d="M114 8 L207 43 V104 C207 158 170 198 114 220 C58 198 21 158 21 104 V43 Z" fill="currentColor"/>',
    { x: 114, y: 119, scale: 0.76 },
  ),
  leaf: authoredSilhouette(
    "leaf",
    '<path xmlns="http://www.w3.org/2000/svg" d="M205 18 C135 13 62 35 28 91 C2 134 23 190 67 211 C116 234 176 198 197 145 C211 110 210 57 205 18 Z" fill="currentColor"/>',
    { x: 112, y: 124, scale: 0.75 },
  ),
  drop: authoredSilhouette(
    "drop",
    '<path xmlns="http://www.w3.org/2000/svg" d="M114 7 C114 7 28 96 28 148 C28 192 66 220 114 220 C162 220 200 192 200 148 C200 96 114 7 114 7 Z" fill="currentColor"/>',
    { x: 114, y: 121, scale: 0.76 },
  ),
} satisfies Record<(typeof VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES)[number] | "cursor", CursorSilhouette>;

const PRESENTATION = {
  cursor: { opticalScale: 1, normalizedBounds: { width: 0.74, height: 0.9 }, faceOffset: { x: 0, y: -3 }, faceSafeZone: { left: 34, right: 66, top: 29, bottom: 72 }, brandedException: true },
  orb: { opticalScale: 0.77, normalizedBounds: { width: 0.893, height: 0.893 }, faceOffset: { x: 0, y: 0 }, faceSafeZone: { left: 30, right: 70, top: 27, bottom: 80 } },
  tile: { opticalScale: 0.824, normalizedBounds: { width: 0.845, height: 0.819 }, faceOffset: { x: 0, y: -1 }, faceSafeZone: { left: 29, right: 71, top: 27, bottom: 80 } },
  gem: { opticalScale: 0.753, normalizedBounds: { width: 0.919, height: 0.901 }, faceOffset: { x: 0, y: -1 }, faceSafeZone: { left: 31, right: 69, top: 29, bottom: 78 } },
  pebble: { opticalScale: 0.709, normalizedBounds: { width: 0.967, height: 0.967 }, faceOffset: { x: 0, y: 0 }, faceSafeZone: { left: 30, right: 70, top: 28, bottom: 80 } },
  spark: { opticalScale: 0.727, normalizedBounds: { width: 0.923, height: 0.963 }, faceOffset: { x: 0, y: -1 }, faceSafeZone: { left: 31, right: 69, top: 28, bottom: 79 } },
  capsule: { opticalScale: 0.855, normalizedBounds: { width: 0.691, height: 0.928 }, faceOffset: { x: 0, y: -2 }, faceSafeZone: { left: 33, right: 67, top: 27, bottom: 79 } },
  shield: { opticalScale: 0.789, normalizedBounds: { width: 0.814, height: 0.928 }, faceOffset: { x: 0, y: -1 }, faceSafeZone: { left: 31, right: 69, top: 28, bottom: 79 } },
  leaf: { opticalScale: 0.739, normalizedBounds: { width: 0.915, height: 0.941 }, faceOffset: { x: 1, y: 1 }, faceSafeZone: { left: 31, right: 69, top: 30, bottom: 82 } },
  drop: { opticalScale: 0.818, normalizedBounds: { width: 0.753, height: 0.932 }, faceOffset: { x: 0, y: -4 }, faceSafeZone: { left: 32, right: 68, top: 24, bottom: 79 } },
} as const;

const RESOLVED_SILHOUETTE = {
  cursor: "cursor",
  orb: "orb",
  tile: "tile",
  gem: "gem",
  pebble: "pebble",
  spark: "spark",
  capsule: "capsule",
  shield: "shield",
  leaf: "leaf",
  moon: "orb",
  hex: "tile",
  drop: "drop",
} as const satisfies Record<BotProceduralAvatar["silhouette"], keyof typeof SILHOUETTES>;

export function proceduralAvatarDefinition(
  value?: BotProceduralAvatar | null,
): BotProceduralAvatar {
  return botProceduralAvatarSchema.safeParse(value).data ?? DEFAULT_PROCEDURAL_AVATAR;
}

export function resolvedProceduralSilhouette(
  silhouette: BotProceduralAvatar["silhouette"],
): keyof typeof SILHOUETTES {
  return RESOLVED_SILHOUETTE[silhouette];
}

export function proceduralAvatarPresentation(
  value?: BotProceduralAvatar | null,
): ProceduralAvatarPresentation {
  const definition = proceduralAvatarDefinition(value);
  const silhouette = resolvedProceduralSilhouette(definition.silhouette);
  const metrics = PRESENTATION[silhouette];
  return {
    surface: silhouette === "cursor" ? "openmaus-cursor" : `procedural:${silhouette}`,
    silhouette: SILHOUETTES[silhouette],
    ...metrics,
    // Body scales vary to equalize silhouette area. Counter-scale the face so
    // its final eye/stroke size is a constant 0.78 of the requested box.
    faceScale: 0.78 / metrics.opticalScale,
    normalizedVisualArea:
      metrics.normalizedBounds.width * metrics.normalizedBounds.height * metrics.opticalScale ** 2,
  };
}
