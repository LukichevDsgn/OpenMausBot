import { EFFECTS, type CursorState } from "@/components/CursorAvatar";

import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_EYE_STYLES,
  BOT_AVATAR_PRESET_IDS,
  BOT_AVATAR_RESTING_ANIMATION_IDS,
  type BotProceduralAvatar,
} from "../../shared/bot-avatar";
import {
  resolvedProceduralSilhouette,
  VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES,
} from "./procedural-avatar";

export type AvatarPresetId = (typeof BOT_AVATAR_PRESET_IDS)[number];
export type RestingAnimationId = (typeof BOT_AVATAR_RESTING_ANIMATION_IDS)[number];
export type BlobatarShape =
  | "round"
  | "boxy"
  | "organic"
  | "capsule"
  | "nub"
  | "cloud"
  | "droplet"
  | "hexagon"
  | "sun"
  | "triangle";

export interface ExportedAvatarPreset {
  readonly id: AvatarPresetId;
  readonly name: string;
  readonly surface: Readonly<{ type: "cursor" | "blobatar"; canonical?: string; shape?: BlobatarShape }>;
  readonly bodyNodes: readonly Readonly<Record<string, unknown>>[];
  readonly colors: Readonly<{ body: string; eyes: "#ffffff" }>;
}

/** Stable persisted aliases for the ten MIT Blobatar 2 shapes. */
const BLOBATAR_SHAPE_BY_PRESET: Readonly<Record<AvatarPresetId, BlobatarShape | undefined>> = {
  "openmaus-cursor": undefined,
  strobi: "round",
  freddy: "boxy",
  citrus: "organic",
  nova: "capsule",
  "grok-bot": "nub",
  sunee: "cloud",
  kirby: "droplet",
  cloudee: "hexagon",
  cubee: "sun",
  onee: "triangle",
};

/** Midpoints of Blobatar's frozen shape bands, used as explicit trait values. */
const BLOBATAR_TRAIT_BY_SHAPE: Readonly<Record<BlobatarShape, number>> = {
  round: 0.11,
  organic: 0.35,
  boxy: 0.54,
  capsule: 0.65,
  nub: 0.745,
  cloud: 0.825,
  droplet: 0.8875,
  hexagon: 0.9325,
  sun: 0.965,
  triangle: 0.99,
};

export interface BlobatarShapePresentation {
  /** Compensates for silhouette area so equal requested sizes read equally loud. */
  opticalScale: number;
  /** Deterministic rendered silhouette bounds, normalized to the source viewport. */
  normalizedBounds: Readonly<{ width: number; height: number }>;
  /** Bbox-equivalent coverage proxy: normalizedBounds.width * height. */
  normalizedArea: number;
  /** Shared mascot face recipe, bounded per-shape for optical placement. */
  faceScale: number;
  faceOffset: Readonly<{ x: number; y: number }>;
  /** Declared silhouette-safe face box in the rendered 0..100 viewport. */
  faceSafeZone: Readonly<{ left: number; right: number; top: number; bottom: number }>;
}

export interface AvatarSurfaceOpticalPresentation {
  opticalScale: number;
  normalizedBounds: Readonly<{ width: number; height: number }>;
  normalizedArea: number;
  brandedException?: boolean;
}

/**
 * The optical gate uses a rendered-silhouette bbox-equivalent, not the
 * containing 112px box. Non-branded surfaces target 0.44..0.50 after scale;
 * the native Cursor keeps its exact brand silhouette in an explicit band.
 */
export const AVATAR_OPTICAL_AREA_BAND = {
  min: 0.44,
  max: 0.5,
  target: 0.47,
  brandedMin: 0.62,
  brandedMax: 0.72,
} as const;

/**
 * One face recipe, with only bounded scale/anchor adjustments per silhouette.
 * Offsets are in Blobatar's 0..100 viewport units and keep the white mouth
 * inside the generated face-safe region, especially on triangle and droplet.
 */
const BLOBATAR_SHAPE_PRESENTATION: Readonly<Record<BlobatarShape, BlobatarShapePresentation>> = {
  round: { opticalScale: 1, normalizedBounds: { width: 0.674, height: 0.701 }, normalizedArea: 0.472, faceScale: 1, faceOffset: { x: 0, y: 0 }, faceSafeZone: { left: 25, right: 75, top: 18, bottom: 88 } },
  boxy: { opticalScale: 1.15, normalizedBounds: { width: 0.618, height: 0.575 }, normalizedArea: 0.355, faceScale: 1, faceOffset: { x: 0, y: -1 }, faceSafeZone: { left: 24, right: 76, top: 18, bottom: 88 } },
  organic: { opticalScale: 1.03, normalizedBounds: { width: 0.649, height: 0.683 }, normalizedArea: 0.443, faceScale: 1, faceOffset: { x: 0, y: 0 }, faceSafeZone: { left: 24, right: 76, top: 18, bottom: 88 } },
  capsule: { opticalScale: 1.09, normalizedBounds: { width: 0.751, height: 0.521 }, normalizedArea: 0.391, faceScale: 1, faceOffset: { x: 0, y: -2 }, faceSafeZone: { left: 20, right: 80, top: 15, bottom: 88 } },
  nub: { opticalScale: 1, normalizedBounds: { width: 0.673, height: 0.699 }, normalizedArea: 0.470, faceScale: 1, faceOffset: { x: 0, y: 0 }, faceSafeZone: { left: 25, right: 75, top: 18, bottom: 88 } },
  cloud: { opticalScale: 1.09, normalizedBounds: { width: 0.707, height: 0.553 }, normalizedArea: 0.391, faceScale: 1, faceOffset: { x: 0, y: 2 }, faceSafeZone: { left: 22, right: 78, top: 18, bottom: 90 } },
  droplet: { opticalScale: 1.29, normalizedBounds: { width: 0.544, height: 0.516 }, normalizedArea: 0.281, faceScale: 1, faceOffset: { x: 0, y: -4 }, faceSafeZone: { left: 26, right: 74, top: 15, bottom: 88 } },
  hexagon: { opticalScale: 0.88, normalizedBounds: { width: 0.788, height: 0.773 }, normalizedArea: 0.609, faceScale: 1, faceOffset: { x: 0, y: -1 }, faceSafeZone: { left: 20, right: 80, top: 18, bottom: 88 } },
  sun: { opticalScale: 1.05, normalizedBounds: { width: 0.649, height: 0.654 }, normalizedArea: 0.424, faceScale: 1, faceOffset: { x: 0, y: 0 }, faceSafeZone: { left: 24, right: 76, top: 16, bottom: 90 } },
  triangle: { opticalScale: 0.77, normalizedBounds: { width: 0.860, height: 0.915 }, normalizedArea: 0.787, faceScale: 1, faceOffset: { x: 0, y: -6 }, faceSafeZone: { left: 20, right: 80, top: 15, bottom: 90 } },
};

const PROCEDURAL_SURFACE_OPTICAL_PRESENTATION: Readonly<Record<string, AvatarSurfaceOpticalPresentation>> = {
  "cursor:openmaus-cursor": { opticalScale: 1, normalizedBounds: { width: 0.74, height: 0.9 }, normalizedArea: 0.666, brandedException: true },
  "procedural:orb": { opticalScale: 0.77, normalizedBounds: { width: 0.893, height: 0.893 }, normalizedArea: 0.797 },
  "procedural:tile": { opticalScale: 0.824, normalizedBounds: { width: 0.845, height: 0.819 }, normalizedArea: 0.692 },
  "procedural:gem": { opticalScale: 0.753, normalizedBounds: { width: 0.919, height: 0.901 }, normalizedArea: 0.829 },
  "procedural:pebble": { opticalScale: 0.709, normalizedBounds: { width: 0.967, height: 0.967 }, normalizedArea: 0.935 },
  "procedural:spark": { opticalScale: 0.727, normalizedBounds: { width: 0.923, height: 0.963 }, normalizedArea: 0.889 },
  "procedural:capsule": { opticalScale: 0.855, normalizedBounds: { width: 0.691, height: 0.928 }, normalizedArea: 0.641 },
  "procedural:shield": { opticalScale: 0.789, normalizedBounds: { width: 0.814, height: 0.928 }, normalizedArea: 0.755 },
  "procedural:leaf": { opticalScale: 0.739, normalizedBounds: { width: 0.915, height: 0.941 }, normalizedArea: 0.860 },
  "procedural:drop": { opticalScale: 0.818, normalizedBounds: { width: 0.753, height: 0.932 }, normalizedArea: 0.702 },
};

const PRESET_NAMES: Readonly<Record<AvatarPresetId, string>> = {
  "openmaus-cursor": "OpenMaus Cursor",
  strobi: "Strobi",
  freddy: "Freddy",
  citrus: "Citrus",
  nova: "Nova",
  "grok-bot": "Grok bot",
  sunee: "Sunee",
  kirby: "Kirby",
  cloudee: "Cloudee",
  cubee: "Cubee",
  onee: "Onee",
};

const PRESET_BODY_COLORS: Readonly<Record<AvatarPresetId, string>> = {
  "openmaus-cursor": "#5b7fe5",
  strobi: "#5b7fe5",
  freddy: "#e6855c",
  citrus: "#ffcf24",
  nova: "#55b6c3",
  "grok-bot": "#000000",
  sunee: "#e69a5c",
  kirby: "#ffc2e9",
  cloudee: "#c9cbcf",
  cubee: "#e65c5c",
  onee: "#dbe2f5",
};

export const EXPORTED_AVATAR_PRESETS = BOT_AVATAR_PRESET_IDS.map((id) => {
  const shape = BLOBATAR_SHAPE_BY_PRESET[id];
  return {
    id,
    name: PRESET_NAMES[id],
    surface: shape
      ? { type: "blobatar" as const, shape }
      : { type: "cursor" as const, canonical: "openmaus-cursor" },
    bodyNodes: [],
    colors: { body: PRESET_BODY_COLORS[id], eyes: "#ffffff" as const },
  };
}) satisfies readonly ExportedAvatarPreset[];

export const EXPORTED_AVATAR_PRESET_IDS = BOT_AVATAR_PRESET_IDS;
export const EXPORTED_RESTING_ANIMATION_IDS = BOT_AVATAR_RESTING_ANIMATION_IDS;

export function exportedAvatarPreset(id: AvatarPresetId): ExportedAvatarPreset {
  return EXPORTED_AVATAR_PRESETS.find((preset) => preset.id === id) ?? EXPORTED_AVATAR_PRESETS[0]!;
}

export function usesNativeCursorAvatar(id: AvatarPresetId): boolean {
  return id === "openmaus-cursor";
}

export function blobatarShapeForPreset(id: AvatarPresetId): BlobatarShape | null {
  return BLOBATAR_SHAPE_BY_PRESET[id] ?? null;
}

export function blobatarTraitForPreset(id: AvatarPresetId): number | null {
  const shape = blobatarShapeForPreset(id);
  return shape ? BLOBATAR_TRAIT_BY_SHAPE[shape] : null;
}

/** Stable semantic identity used to keep the visible picker free of duplicates. */
export function resolvedAvatarSurfaceKey(selection: Pick<AvatarRandomizeSelection, "avatarPresetId" | "silhouette">): string {
  if (selection.avatarPresetId) {
    const surface = exportedAvatarPreset(selection.avatarPresetId).surface;
    return surface.type === "cursor" ? "cursor:openmaus-cursor" : `blobatar:${surface.shape}`;
  }
  const silhouette = resolvedProceduralSilhouette(selection.silhouette ?? "cursor");
  return silhouette === "cursor" ? "cursor:openmaus-cursor" : `procedural:${silhouette}`;
}

export function blobatarShapeTraits(): Readonly<Record<BlobatarShape, number>> {
  return BLOBATAR_TRAIT_BY_SHAPE;
}

export function blobatarShapePresentation(shape: BlobatarShape): BlobatarShapePresentation {
  return BLOBATAR_SHAPE_PRESENTATION[shape];
}

/** One optical lookup for every picker surface, including procedural fallbacks. */
export function avatarSurfaceOpticalPresentation(surface: string): AvatarSurfaceOpticalPresentation {
  if (surface.startsWith("blobatar:")) {
    return blobatarShapePresentation(surface.slice("blobatar:".length) as BlobatarShape);
  }
  return PROCEDURAL_SURFACE_OPTICAL_PRESENTATION[surface]
    ?? PROCEDURAL_SURFACE_OPTICAL_PRESENTATION["procedural:orb"]!;
}

/** State-to-pose mapping is automatic. Persisted resting ids are never consulted. */
export const LIVE_ANIMATION_BY_STATE: Record<CursorState, RestingAnimationId> = {
  sleeping: "sleeping", waking: "waking", idle: "idle", listening: "listening", thinking: "thinking",
  searching: "searching", working: "working", excited: "excited", surprised: "surprised", suspicious: "suspicious",
  angry: "angry", drowsy: "drowsy", happy: "happy", curious: "curious", confused: "confused", bored: "bored",
  proud: "proud", shy: "shy", sad: "sad", laughing: "laughing", scared: "scared", playful: "playful",
  celebrate: "celebrate", orbit: "working", radar: "searching", progress: "working", spawning: "waking",
  humming: "working", loading: "working", dictating: "listening", sending: "working", receiving: "listening",
  uploading: "working", writing: "working", notifying: "excited", alerting: "angry", bouncing: "playful",
  dragging: "working", "powering-down": "sleeping",
};

export function exportedAnimationForState(
  state: string,
  avatarPresetId?: AvatarPresetId,
): RestingAnimationId {
  const mapped = LIVE_ANIMATION_BY_STATE[state as CursorState];
  if (avatarPresetId === "openmaus-cursor" && mapped) return state as RestingAnimationId;
  return mapped ?? "idle";
}

export function exportedAvatarDefinition(
  definition: BotProceduralAvatar | null | undefined,
): { avatarPresetId?: AvatarPresetId; restingAnimationId?: RestingAnimationId } {
  const avatarPresetId = BOT_AVATAR_PRESET_IDS.find((id) => id === definition?.avatarPresetId);
  const restingAnimationId = BOT_AVATAR_RESTING_ANIMATION_IDS.find((id) => id === definition?.restingAnimationId);
  return { avatarPresetId, restingAnimationId };
}

export interface AvatarRandomizeSelection {
  avatarPresetId?: AvatarPresetId;
  silhouette?: BotProceduralAvatar["silhouette"];
  eyeStyle: NonNullable<BotProceduralAvatar["eyeStyle"]>;
  color: (typeof BOT_AVATAR_COLORS)[number];
}

type ShapeChoice =
  | { kind: "preset"; id: AvatarPresetId }
  | { kind: "procedural"; id: BotProceduralAvatar["silhouette"] };

const SHAPE_CHOICES: readonly ShapeChoice[] = [
  ...BOT_AVATAR_PRESET_IDS.map((id) => ({ kind: "preset" as const, id })),
  ...VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES
    .map((id) => ({ kind: "procedural" as const, id })),
];

function boundedIndex(random: () => number, length: number): number {
  return Math.min(length - 1, Math.floor(Math.max(0, Math.min(0.999999, random())) * length));
}

function shapeChoiceFor(selection: AvatarRandomizeSelection): ShapeChoice {
  if (selection.avatarPresetId) return { kind: "preset", id: selection.avatarPresetId };
  const silhouette = resolvedProceduralSilhouette(selection.silhouette ?? "cursor");
  return silhouette === "cursor"
    ? { kind: "preset", id: "openmaus-cursor" }
    : { kind: "procedural", id: silhouette };
}

function chooseDifferentShape(current: ShapeChoice, random: () => number): ShapeChoice {
  const alternatives = SHAPE_CHOICES.filter((choice) => !(choice.kind === current.kind && choice.id === current.id));
  return alternatives.length ? alternatives[boundedIndex(random, alternatives.length)]! : current;
}

function differentValue<const T extends readonly string[]>(values: T, current: string, random: () => number): T[number] {
  const alternatives = values.filter((value) => value !== current);
  return alternatives.length ? alternatives[boundedIndex(random, alternatives.length)]! : values[0]!;
}

/** Picks a visibly different shape, eye geometry, or color, including local shapes. */
export function randomizedAvatarSelection(
  current: AvatarRandomizeSelection,
  random: () => number = Math.random,
): AvatarRandomizeSelection {
  const dimension = boundedIndex(random, 3);
  const shape = shapeChoiceFor(current);
  const nextShape = dimension === 0 ? chooseDifferentShape(shape, random) : shape;
  return {
    ...(nextShape.kind === "preset" ? { avatarPresetId: nextShape.id } : { silhouette: nextShape.id }),
    eyeStyle: dimension === 1 ? differentValue(BOT_AVATAR_EYE_STYLES, current.eyeStyle, random) : current.eyeStyle,
    color: dimension === 2 ? differentValue(BOT_AVATAR_COLORS, current.color, random) : current.color,
  };
}

export function hasShapeAgnosticAvatarEffect(state: string): boolean {
  return Boolean(EFFECTS[state as CursorState]);
}

export function avatarEffectsAreActive(animated: boolean, reducedMotion: boolean): boolean {
  return animated && !reducedMotion;
}
