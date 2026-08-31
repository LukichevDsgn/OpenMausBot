/** The application avatar adapter. CursorAvatar is the one visible face
 * engine for both the branded mascot and every selectable silhouette. */
import React, { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CursorAvatar, DEFAULT_SILHOUETTE, EXPRESSIONS, FACE_BOX, FACE_CENTRE, GAZE, MOUTHS, MOUTH_STROKE, mouthFrame, type CursorAvatarHandle, type CursorSilhouette, type CursorState } from "./CursorAvatar";
import { _layout, _marks, type Mark } from "blobatar/internal";
import * as avatarCatalog from "@/lib/avatar-presets";
import { AVATAR_OPTICAL_AREA_BAND, avatarSurfaceOpticalPresentation, blobatarTraitForPreset, EXPORTED_AVATAR_PRESETS, type AvatarPresetId } from "@/lib/avatar-presets";
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { DEFAULT_PROCEDURAL_AVATAR, PROCEDURAL_AVATAR_SILHOUETTE_LABELS, proceduralAvatarPresentation, VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES } from "@/lib/procedural-avatar";
import { botAvatarProfile, type BotAvatarCrop, type BotProceduralAvatar } from "../../shared/bot-avatar";
import { BOT_AVATAR_PRESET_IDS } from "../../shared/bot-avatar";

export const FACE_X = 80;
export const FACE_Y = 102;
export const FACE_SCALE = 0.47;
export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

/** Compatibility contract for callers that inspect the old preview metadata.
 * Rendering itself is exclusively delegated to CursorAvatar below. */
export const CANONICAL_FACE_CONTRACT = { eyeWidth: 5, eyeHeight: 13, eyeGap: 9, eyeCenterY: 45, mouthWidth: 8, mouthCenterY: 68, mouthStrokeWidth: MOUTH_STROKE, minEyeMouthGap: 4, maxMouthWidthToEyeGap: 0.9, maxOpticalScale: 1.3, minOpticalScale: 0.7, maxFaceScale: 1.04, minFaceScale: 0.96, maxFaceOffset: 6 } as const;
export type CanonicalFacePresentation = { opticalScale: number; faceScale: number; faceOffset: Readonly<{ x: number; y: number }>; faceSafeZone: Readonly<{ left: number; right: number; top: number; bottom: number }> };
const SAFE_ZONES = {
  "openmaus-cursor": { left: 20, right: 80, top: 18, bottom: 88 },
  "procedural:orb": { left: 21, right: 79, top: 18, bottom: 86 },
  "procedural:tile": { left: 20, right: 80, top: 18, bottom: 86 },
  "procedural:gem": { left: 23, right: 77, top: 20, bottom: 84 },
  "procedural:pebble": { left: 21, right: 79, top: 19, bottom: 86 },
  "procedural:spark": { left: 23, right: 77, top: 20, bottom: 84 },
  "procedural:capsule": { left: 25, right: 75, top: 17, bottom: 85 },
  "procedural:shield": { left: 23, right: 77, top: 20, bottom: 84 },
  "procedural:leaf": { left: 24, right: 76, top: 22, bottom: 86 },
  "procedural:drop": { left: 25, right: 75, top: 18, bottom: 84 },
} satisfies Record<string, CanonicalFacePresentation["faceSafeZone"]>;
export function canonicalFacePresentationForSurface(surface: string): CanonicalFacePresentation {
  // SAFETY: Object.hasOwn narrows the dynamic surface to this finite table.
  const safeZone = Object.hasOwn(SAFE_ZONES, surface) ? SAFE_ZONES[surface as keyof typeof SAFE_ZONES] : SAFE_ZONES["procedural:orb"]!;
  return { opticalScale: avatarSurfaceOpticalPresentation(surface).opticalScale, faceScale: 1, faceOffset: { x: 0, y: 0 }, faceSafeZone: safeZone };
}
type FaceBounds = Readonly<{ left: number; right: number; top: number; bottom: number }>;
const NATIVE_LOOK_AROUND = 0.5;
const MAX_NATIVE_EYE_SCALE = 1.18;
/** Keep the native mascot face legible; fitting may only reduce from this
 * audited baseline when a future authored shape proves it cannot contain the
 * complete expression envelope. The deterministic suite fails that case. */
export const MIN_NATIVE_FACE_SCALE = 0.68;
export const CANONICAL_NATIVE_FACE_SCALE = 0.74;
const FACE_EPSILON = 1e-6;

const extendFaceBounds = (bounds: { left: number; right: number; top: number; bottom: number }, point: { x: number; y: number }) => {
  bounds.left = Math.min(bounds.left, point.x);
  bounds.right = Math.max(bounds.right, point.x);
  bounds.top = Math.min(bounds.top, point.y);
  bounds.bottom = Math.max(bounds.bottom, point.y);
};

/** Exact conservative envelope of the native CursorAvatar face at its widest
 * production eye scale.  It is built from the engine's exported expression
 * rings, authored gaze vectors, mouth specs and stroke, never from resting-eye
 * distance alone. */
export function nativeFaceEnvelope(options: { eyeScale?: number; showMouth?: boolean; mouthStroke?: number } = {}): FaceBounds {
  const eyeScale = Number.isFinite(options.eyeScale) ? Math.max(0.4, Math.min(MAX_NATIVE_EYE_SCALE, options.eyeScale ?? 1)) : MAX_NATIVE_EYE_SCALE;
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  EXPRESSIONS.forEach((expression, index) => {
    const authoredGaze = GAZE[index] ?? [0, 0];
    const rings = expression.map((ring) => ring.map(([x, y]) => {
      const shifted: [number, number] = [x + authoredGaze[0] * NATIVE_LOOK_AROUND, y + authoredGaze[1] * NATIVE_LOOK_AROUND];
      return shifted;
    }));
    for (const ring of rings) {
      const centre = ringCentre(ring);
      for (const [x, y] of ring) extendFaceBounds(bounds, { x: centre[0] + (x - centre[0]) * eyeScale, y: centre[1] + (y - centre[1]) * eyeScale });
    }
    if (options.showMouth === false) return;
    const spec = MOUTHS[index] ?? MOUTHS[0]!;
    const frame = mouthFrame(rings, spec);
    const cos = Math.cos(frame.angle);
    const sin = Math.sin(frame.angle);
    const points = [[-spec[0]!, 0], [0, spec[1]!], [spec[0]!, 0]] as const;
    const stroke = (options.mouthStroke ?? MOUTH_STROKE) / 2;
    for (const [localX, localY] of points) {
      const x = frame.x + localX * cos - localY * sin;
      const y = frame.y + localX * sin + localY * cos;
      extendFaceBounds(bounds, { x: x - stroke, y: y - stroke });
      extendFaceBounds(bounds, { x: x + stroke, y: y + stroke });
    }
  });
  return bounds;
}

/** Project native face-space bounds into the 0..100 presentation space used by
 * declared safe zones. */
export function canonicalFaceBoundsForPresentation(presentation: CanonicalFacePresentation, options: { gaze?: { x?: number; y?: number }; eyeScale?: number; showMouth?: boolean; mouthStroke?: number } = {}) {
  const envelope = nativeFaceEnvelope(options);
  const gx = Math.max(-1, Math.min(1, options.gaze?.x ?? 0)) * 13.2;
  const gy = Math.max(-1, Math.min(1, options.gaze?.y ?? 0)) * 8.4;
  const scale = presentation.faceScale * presentation.opticalScale;
  const projectX = (value: number) => 50 + ((value - FACE_CENTRE[0] + gx) / FACE_BOX) * 100 * scale;
  const projectY = (value: number) => 50 + ((value - FACE_CENTRE[1] + gy) / FACE_BOX) * 100 * scale;
  return { left: projectX(envelope.left), right: projectX(envelope.right), top: projectY(envelope.top + presentation.faceOffset.y), bottom: projectY(envelope.bottom + presentation.faceOffset.y) };
}
/** Legacy metadata helper; state visuals are never approximated here. */
export function canonicalFaceRecipeForState(state: MausState) { return { state, engine: "CursorAvatar" as const }; }
export function blobatarGazeOptions(trackPointer: boolean, animated: boolean, reducedMotion = false) { const active = trackPointer && animated && !reducedMotion; return { travel: active ? 3 : undefined, lookAt: active ? ("pointer" as const) : null }; }
export function blobatarEffectMode(animated: boolean, reducedMotion: boolean): "animated" | "static" { return animated && !reducedMotion ? "animated" : "static"; }
export function hasBlobatarStateEffect(state: string): boolean { return ["alerting", "celebrate", "success", "failure", "surprised"].includes(state); }

export const gradientFor = (color: MausColor): [string, string, string] => {
  const base = MAUS_COLORS[color] ?? MAUS_COLORS.green;
  const mix = (toward: string, amount: number) => { const a = Number.parseInt(base.slice(1), 16); const b = Number.parseInt(toward.slice(1), 16); const channel = (shift: number) => Math.round(((a >> shift) & 255) + ((((b >> shift) & 255) - ((a >> shift) & 255)) * amount)); return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`; };
  return [mix("#ffffff", 0.55), base, mix("#000000", 0.42)];
};
const CURSOR_SILHOUETTE: CursorSilhouette = { ...DEFAULT_SILHOUETTE, body: DEFAULT_SILHOUETTE.body.replace(/fill="#000000"/g, 'fill="{{GRADIENT}}"') };

/**
 * Exact Blobatar bodies are adapted from the package's documented adapter seam.
 * `_marks` gives body primitives followed by its two face marks; the latter are
 * deliberately discarded so CursorAvatar remains the only visible face engine.
 * No SVG/preset assets are copied into OpenMausBot (blobatar@2.7.0 is MIT).
 */
type MutableBlobatarBounds = { left: number; right: number; top: number; bottom: number };
type BlobatarBounds = Readonly<MutableBlobatarBounds>;
const emptyBounds = (): MutableBlobatarBounds => ({ left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
const extendBounds = (bounds: { left: number; right: number; top: number; bottom: number }, point: { x: number; y: number }) => {
  bounds.left = Math.min(bounds.left, point.x);
  bounds.right = Math.max(bounds.right, point.x);
  bounds.top = Math.min(bounds.top, point.y);
  bounds.bottom = Math.max(bounds.bottom, point.y);
};
const pathBounds = (d: string) => {
  const numbers = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  const bounds = emptyBounds();
  // Blobatar's authored paths use coordinate pairs (M/L/Q/C); including
  // control points is intentionally conservative for the face safe-zone.
  for (let index = 0; index + 1 < numbers.length; index += 2) extendBounds(bounds, { x: numbers[index]!, y: numbers[index + 1]! });
  return bounds;
};
const markBounds = (mark: Mark): BlobatarBounds => {
  if (mark.kind === "circle") return { left: mark.cx - mark.r, right: mark.cx + mark.r, top: mark.cy - mark.r, bottom: mark.cy + mark.r };
  return pathBounds(mark.d);
};
const mergeBounds = (target: { left: number; right: number; top: number; bottom: number }, source: BlobatarBounds) => {
  target.left = Math.min(target.left, source.left);
  target.right = Math.max(target.right, source.right);
  target.top = Math.min(target.top, source.top);
  target.bottom = Math.max(target.bottom, source.bottom);
};
const blobatarBounds = (layout: ReturnType<typeof _layout>, bodyMarks: readonly Mark[]): BlobatarBounds => {
  const bounds = emptyBounds();
  for (const mark of bodyMarks) mergeBounds(bounds, markBounds(mark));
  // Keep the analytic authored body envelope even when a path's control
  // points undershoot its rotated superellipse extrema.
  const radians = (layout.body.rot * Math.PI) / 180;
  const halfWidth = Math.sqrt((layout.body.rx * Math.cos(radians)) ** 2 + (layout.body.ry * Math.sin(radians)) ** 2);
  const halfHeight = Math.sqrt((layout.body.rx * Math.sin(radians)) ** 2 + (layout.body.ry * Math.cos(radians)) ** 2);
  mergeBounds(bounds, { left: layout.body.cx - halfWidth, right: layout.body.cx + halfWidth, top: layout.body.cy - halfHeight, bottom: layout.body.cy + halfHeight });
  return bounds;
};
const blobatarMark = (mark: Mark, painted: boolean) => mark.kind === "circle"
  ? `<circle cx="${mark.cx}" cy="${mark.cy}" r="${mark.r}"${painted ? ' fill="{{GRADIENT}}"' : ""}/>`
  : `<path d="${mark.d}"${painted ? ' fill="{{GRADIENT}}"' : ""}/>`;
const blobatarMarkCount = (marks: readonly Mark[]) => marks.length;

/**
 * The sole final perceived-mass correction for selectable bodies.  Geometric
 * fitting happens first; this table is applied once by the shared adapter and
 * never participates in face scale/anchor math.  Cursor is the immutable
 * reference at 1.0.  Values are intentionally explicit for every registry id
 * so a new selectable form cannot silently inherit a family-specific scale.
 */
export const BODY_OPTICAL_TOKEN = {
  "preset:openmaus-cursor": 1,
  "preset:strobi": 1.34,
  "preset:freddy": 1.38,
  "preset:citrus": 1.36,
  "preset:nova": 1.18,
  "preset:grok-bot": 1.3,
  "preset:sunee": 1.48,
  "preset:kirby": 1.34,
  "preset:cloudee": 1.4,
  "preset:cubee": 1.28,
  "preset:onee": 1.52,
  "procedural:orb": 1.08,
  "procedural:tile": 1.1,
  "procedural:gem": 1.08,
  "procedural:pebble": 1.06,
  "procedural:spark": 1.1,
  "procedural:capsule": 1.08,
  "procedural:shield": 1.08,
  "procedural:leaf": 1.12,
  "procedural:drop": 1.1,
} as const;

/** Kept as a compatibility export; family-specific multipliers are retired. */
export const BLOBATAR_OPTICAL_CORRECTION = {
  round: 1,
  boxy: 1,
  organic: 1,
  capsule: 1,
  nub: 1,
  cloud: 1,
  droplet: 1,
  hexagon: 1,
  sun: 1,
  triangle: 1,
} as const;

const ringCentre = (ring: readonly [number, number][]) => {
  // SAFETY: the accumulator is always the fixed two-coordinate centre tuple.
  const centre = ring.reduce((sum, point) => [sum[0] + point[0] / ring.length, sum[1] + point[1] / ring.length], [0, 0] as [number, number]);
  return centre;
};
export type BlobatarPresetGeometry = Readonly<{ sourceBounds: BlobatarBounds; geometricScale: number; opticalCorrection: number; fitScale: number; normalizedArea: number; anchor: CursorSilhouette["anchor"]; bodyMarkCount: number; opticalToken: number; gradientSpace: Readonly<{ x1: number; y1: number; x2: number; y2: number }> }>;
const blobatarSilhouetteCache = new Map<string, CursorSilhouette>();
const blobatarGeometryCache = new Map<string, BlobatarPresetGeometry>();
function blobatarSilhouetteForPreset(id: Exclude<AvatarPresetId, "openmaus-cursor">): CursorSilhouette {
  const cached = blobatarSilhouetteCache.get(id);
  if (cached) return cached;
  const bodyKind = avatarCatalog["blobatarShapeForPreset"](id);
  const trait = blobatarTraitForPreset(id);
  if (!bodyKind || trait === null) return DEFAULT_SILHOUETTE;
  const seed = `openmausbot-${id}`;
  const options = { traits: { ["shape"]: trait } } as const;
  const layout = _layout(seed, options);
  const marks = _marks(seed, options).marks;
  const bodyMarks = marks.slice(0, marks.length - layout.eyes.length);
  const presentation = avatarCatalog["blobatarShapePresentation"](bodyKind);
  const sourceBounds = blobatarBounds(layout, bodyMarks);
  const sourceWidth = Math.max(1, sourceBounds.right - sourceBounds.left);
  const sourceHeight = Math.max(1, sourceBounds.bottom - sourceBounds.top);
  const sourceArea = sourceWidth * sourceHeight;
  const geometricScale = FACE_BOX * Math.sqrt(AVATAR_OPTICAL_AREA_BAND.target / sourceArea);
  // SAFETY: every non-Cursor AvatarPresetId has an explicit preset registry token.
  const opticalToken = BODY_OPTICAL_TOKEN[`preset:${id}` as keyof typeof BODY_OPTICAL_TOKEN];
  const opticalCorrection = BLOBATAR_OPTICAL_CORRECTION[bodyKind];
  const scale = geometricScale;
  const finalScale = scale * opticalToken;
  const finalTx = FACE_BOX / 2 - ((sourceBounds.left + sourceBounds.right) / 2) * finalScale;
  const finalTy = FACE_BOX / 2 - ((sourceBounds.top + sourceBounds.bottom) / 2) * finalScale;
  const safe = presentation.faceSafeZone;
  const safeLeft = (safe.left / 100) * FACE_BOX;
  const safeRight = (safe.right / 100) * FACE_BOX;
  const safeTop = (safe.top / 100) * FACE_BOX;
  const safeBottom = (safe.bottom / 100) * FACE_BOX;
  // Fit against the definition's actual persisted eye geometry; each
  // presentation is then checked independently at its production eyeScale.
  const presetEyeScale = proceduralAvatarPresentation({ ...DEFAULT_PROCEDURAL_AVATAR, avatarPresetId: id }).eyeScale;
  const nativeEnvelope = nativeFaceEnvelope({ eyeScale: presetEyeScale, showMouth: true, mouthStroke: MOUTH_STROKE });
  const envelopeWidth = nativeEnvelope.right - nativeEnvelope.left;
  const envelopeHeight = nativeEnvelope.bottom - nativeEnvelope.top;
  const safeFaceScale = Math.min(
    (safeRight - safeLeft - 2 * FACE_EPSILON) / Math.max(1, envelopeWidth),
    (safeBottom - safeTop - 2 * FACE_EPSILON) / Math.max(1, envelopeHeight),
  );
  const eyeMidX = (layout.eyes[0]!.cx + layout.eyes[1]!.cx) / 2;
  const eyeMidY = (layout.eyes[0]!.cy + layout.eyes[1]!.cy) / 2;
  // Face scale starts from the authored eye spacing, then is capped by the
  // largest native all-expression envelope that fits this shape's safe zone.
  // The body optical token is deliberately absent from this calculation.
  // Blobatar faces share the immutable Cursor optical mass exactly. Geometry
  // supplies placement only; it never changes this canonical face scale.
  const faceScale = Math.min(CANONICAL_NATIVE_FACE_SCALE, safeFaceScale);
  const targetFaceX = finalTx + (eyeMidX + presentation.faceOffset.x) * finalScale;
  const targetFaceY = finalTy + (eyeMidY + presentation.faceOffset.y) * finalScale;
  const envelopeLeftOffset = nativeEnvelope.left - FACE_CENTRE[0];
  const envelopeRightOffset = nativeEnvelope.right - FACE_CENTRE[0];
  const envelopeTopOffset = nativeEnvelope.top - FACE_CENTRE[1];
  const envelopeBottomOffset = nativeEnvelope.bottom - FACE_CENTRE[1];
  const centreX = Math.max(safeLeft - envelopeLeftOffset * faceScale, Math.min(safeRight - envelopeRightOffset * faceScale, targetFaceX));
  const centreY = Math.max(safeTop - envelopeTopOffset * faceScale, Math.min(safeBottom - envelopeBottomOffset * faceScale, targetFaceY));
  const anchor = {
    // CursorAvatar renders the face in final FACE_BOX coordinates; silhouette
    // fit belongs only to body/clip and must not be inverted into the anchor.
    x: centreX,
    y: centreY,
    scale: faceScale,
  };
  // gradientSpace is consumed inside the same transformed body group. Keep
  // its endpoints in authored source space so silhouette.fit carries body
  // and paint together exactly once; post-fit coordinates would double the
  // translation/scale when gradientUnits is userSpaceOnUse.
  const gradientSpace = {
    x1: sourceBounds.right,
    y1: sourceBounds.top,
    x2: sourceBounds.left,
    y2: sourceBounds.bottom,
  };
  const geometry: BlobatarPresetGeometry = { sourceBounds, geometricScale, opticalCorrection, fitScale: finalScale, normalizedArea: (sourceArea * scale * scale * opticalToken * opticalToken) / (FACE_BOX * FACE_BOX), anchor, bodyMarkCount: blobatarMarkCount(bodyMarks), opticalToken, gradientSpace };
  blobatarGeometryCache.set(id, geometry);
  const silhouette: CursorSilhouette = {
    name: `blobatar-${bodyKind}`,
    fit: `translate(${finalTx} ${finalTy}) scale(${finalScale})`,
    body: bodyMarks.map((mark) => blobatarMark(mark, true)).join(""),
    clip: bodyMarks.map((mark) => blobatarMark(mark, false)).join(""),
    anchor,
    gradientSpace,
  };
  blobatarSilhouetteCache.set(id, silhouette);
  return silhouette;
}

export function blobatarPresetGeometry(id: Exclude<AvatarPresetId, "openmaus-cursor">): BlobatarPresetGeometry {
  blobatarSilhouetteForPreset(id);
  return blobatarGeometryCache.get(id)!;
}

/**
 * The single authoritative contract for selectable avatars. Every surface
 * (picker, profile, list, chat) adapts this registry to the same native
 * CursorAvatar engine; entries only declare identity and body geometry.
 */
export type SelectableAvatarRegistryEntry = Readonly<{
  id: string;
  kind: "preset" | "procedural";
  label: string;
  avatarPresetId?: AvatarPresetId;
  silhouette?: BotProceduralAvatar["silhouette"];
}>;

export const SELECTABLE_AVATAR_REGISTRY: readonly SelectableAvatarRegistryEntry[] = [
  ...BOT_AVATAR_PRESET_IDS.map((avatarPresetId) => ({
    id: `preset:${avatarPresetId}`,
    kind: "preset" as const,
    avatarPresetId,
    label: EXPORTED_AVATAR_PRESETS.find((preset) => preset.id === avatarPresetId)?.name ?? avatarPresetId,
  })),
  ...VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES.map((silhouette) => ({
    id: `procedural:${silhouette}`,
    kind: "procedural" as const,
    silhouette,
    label: PROCEDURAL_AVATAR_SILHOUETTE_LABELS[silhouette],
  })),
];

export const SELECTABLE_AVATAR_REGISTRY_COUNT = SELECTABLE_AVATAR_REGISTRY.length;

export type SelectableAvatarSurfaceId = keyof typeof BODY_OPTICAL_TOKEN;

/** Resolve the one final body token without touching native face geometry. */
export function bodyOpticalTokenForDefinition(definition: BotProceduralAvatar): number {
  if (definition.avatarPresetId) {
    // SAFETY: persisted preset ids are validated by the shared schema and the registry table covers all exported ids.
    const presetKey = `preset:${definition.avatarPresetId}` as SelectableAvatarSurfaceId;
    return BODY_OPTICAL_TOKEN[presetKey] ?? 1;
  }
  const presentation = proceduralAvatarPresentation(definition);
  // SAFETY: presentation.surface is the finite procedural surface key emitted by the canonical resolver.
  return BODY_OPTICAL_TOKEN[presentation.surface as SelectableAvatarSurfaceId] ?? 1;
}

function applyBodyOpticalToken(silhouette: CursorSilhouette, token: number): CursorSilhouette {
  if (token === 1) return silhouette;
  // Body and clip share this transform; the face anchor is deliberately not
  // transformed, so perceived-mass calibration can never leak into face size.
  const opticalFit = `translate(${FACE_BOX / 2 - FACE_BOX / 2 * token} ${FACE_BOX / 2 - FACE_BOX / 2 * token}) scale(${token})`;
  return { ...silhouette, fit: silhouette.fit ? `${silhouette.fit} ${opticalFit}` : opticalFit };
}

/** Fit an existing procedural face anchor against the same native envelope
 * used by Blobatar. Procedural artwork already lives in face space, so only
 * the adapter's final body fit and anchor are considered; the authored body
 * paths remain untouched. */
function fitProceduralFaceAnchor(
  silhouette: CursorSilhouette,
  surface: string,
  eyeScale: number,
  showMouth: boolean,
  mouthStroke: number,
): CursorSilhouette {
  const presentation = canonicalFacePresentationForSurface(surface);
  const safe = presentation.faceSafeZone;
  const safeLeft = (safe.left / 100) * FACE_BOX;
  const safeRight = (safe.right / 100) * FACE_BOX;
  const safeTop = (safe.top / 100) * FACE_BOX;
  const safeBottom = (safe.bottom / 100) * FACE_BOX;
  const envelope = nativeFaceEnvelope({ eyeScale, showMouth, mouthStroke });
  const safeFaceScale = Math.min(
    (safeRight - safeLeft - 2 * FACE_EPSILON) / Math.max(1, envelope.right - envelope.left),
    (safeBottom - safeTop - 2 * FACE_EPSILON) / Math.max(1, envelope.bottom - envelope.top),
  );
  const faceScale = Math.min(Math.max(MIN_NATIVE_FACE_SCALE, silhouette.anchor.scale), safeFaceScale);
  const leftOffset = (envelope.left - FACE_CENTRE[0]) * faceScale;
  const rightOffset = (envelope.right - FACE_CENTRE[0]) * faceScale;
  const topOffset = (envelope.top - FACE_CENTRE[1]) * faceScale;
  const bottomOffset = (envelope.bottom - FACE_CENTRE[1]) * faceScale;
  const centreX = Math.max(safeLeft - leftOffset, Math.min(safeRight - rightOffset, silhouette.anchor.x));
  const centreY = Math.max(safeTop - topOffset, Math.min(safeBottom - bottomOffset, silhouette.anchor.y));
  return {
    ...silhouette,
    anchor: {
      x: centreX,
      y: centreY,
      scale: faceScale,
    },
  };
}

/** Build the complete persisted definition expected by every adapter. */
export function avatarDefinitionForRegistryEntry(
  entry: SelectableAvatarRegistryEntry,
  seed = entry.id,
): BotProceduralAvatar {
  const safeSeed = seed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "avatar";
  if (entry.kind === "preset" && entry.avatarPresetId) {
    return { ...DEFAULT_PROCEDURAL_AVATAR, seed: safeSeed, silhouette: "cursor", avatarPresetId: entry.avatarPresetId };
  }
  if (entry.kind === "procedural" && entry.silhouette) {
    return { ...DEFAULT_PROCEDURAL_AVATAR, seed: safeSeed, silhouette: entry.silhouette };
  }
  return { ...DEFAULT_PROCEDURAL_AVATAR, seed: safeSeed };
}

function silhouetteFor(definition: BotProceduralAvatar): CursorSilhouette {
  if (definition.avatarPresetId === "openmaus-cursor" || (!definition.avatarPresetId && definition.silhouette === "cursor")) return CURSOR_SILHOUETTE;
  if (definition.avatarPresetId) return blobatarSilhouetteForPreset(definition.avatarPresetId);
  const normalized = { ...DEFAULT_PROCEDURAL_AVATAR, ...definition, silhouette: definition.silhouette };
  const presentation = proceduralAvatarPresentation(normalized);
  const bodyToken = bodyOpticalTokenForDefinition(normalized);
  const fitted = applyBodyOpticalToken(presentation.silhouette, bodyToken);
  return fitProceduralFaceAnchor(fitted, presentation.surface, presentation.eyeScale, true, MOUTH_STROKE);
}

/** Return the actual rendered native face envelope in the same 0..100 space as
 * a surface's declared safe zone. This is used by deterministic containment
 * tests and keeps the fit contract explicit without duplicating SVG geometry. */
export function nativeFaceBoundsForDefinition(definition: BotProceduralAvatar, options: { eyeScale?: number; showMouth?: boolean; mouthStroke?: number } = {}) {
  const normalized = { ...DEFAULT_PROCEDURAL_AVATAR, ...definition, silhouette: definition.silhouette };
  const presentation = proceduralAvatarPresentation(normalized);
  const silhouette = silhouetteFor(definition);
  const envelope = nativeFaceEnvelope({ eyeScale: options.eyeScale ?? presentation.eyeScale, showMouth: options.showMouth ?? true, mouthStroke: options.mouthStroke ?? MOUTH_STROKE });
  const projectX = (value: number) => (silhouette.anchor.x + (value - FACE_CENTRE[0]) * silhouette.anchor.scale) * 100 / FACE_BOX;
  const projectY = (value: number) => (silhouette.anchor.y + (value - FACE_CENTRE[1]) * silhouette.anchor.scale) * 100 / FACE_BOX;
  // SAFETY: presentation.surface is either the branded key or one of the finite procedural keys.
  const faceSafeZone = presentation.surface === "openmaus-cursor" ? SAFE_ZONES["openmaus-cursor"]! : Object.hasOwn(SAFE_ZONES, presentation.surface) ? SAFE_ZONES[presentation.surface as keyof typeof SAFE_ZONES]! : SAFE_ZONES["procedural:orb"]!;
  return { left: projectX(envelope.left), right: projectX(envelope.right), top: projectY(envelope.top), bottom: projectY(envelope.bottom), surface: presentation.surface, faceSafeZone };
}

export function nativeFaceScaleForDefinition(definition: BotProceduralAvatar): number {
  return silhouetteFor(definition).anchor.scale;
}

/** Stable test/audit fingerprint of the exact body adapter output. */
export function avatarBodyFingerprintForDefinition(definition: BotProceduralAvatar): string {
  const body = silhouetteFor(definition).body;
  let hash = 2166136261;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type MausAvatarHandle = CursorAvatarHandle;
export type MausAvatarProps = { color: MausColor; avatarDefinition?: BotProceduralAvatar | null; state?: MausState; expression?: number; size?: number; label?: string; motion?: MausMotion; motionKey?: number; turn?: number; gaze?: { x?: number; y?: number }; spring?: number; eyeScale?: number; showMouth?: boolean; mouthStroke?: number; forward?: boolean; lookAround?: number; trackPointer?: boolean; animated?: boolean; autoBlink?: boolean; autoExpression?: boolean; eyeSpacing?: number; faceX?: number; faceY?: number; faceScale?: number };
const MOTION_STATE = { arrive: "spawning", switch: "waking", customize: "proud", alert: "alerting", thinking: "thinking", working: "working", launch: "loading", success: "happy", celebrate: "celebrate", surprise: "surprised", failure: "sad", blink: "idle" } satisfies Partial<Record<MausMotion, MausState>>;

function MausAvatarComponent({ color, avatarDefinition, state = "idle", expression, size = 44, label, motion = "none", motionKey = 0, turn, gaze, spring, eyeScale, showMouth = true, mouthStroke = MOUTH_STROKE, forward = true, lookAround, trackPointer = true, animated = true, autoBlink = animated, autoExpression = animated }: MausAvatarProps, ref: React.Ref<MausAvatarHandle>) {
  const inner = useRef<CursorAvatarHandle>(null);
  const [motionState, setMotionState] = useState<MausState | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const definition = avatarDefinition ?? DEFAULT_PROCEDURAL_AVATAR;
  const presentation = proceduralAvatarPresentation(definition);
  const renderedState = motionState ?? state;
  // Persisted expression presets are legacy metadata only.  The native
  // CursorAvatar state machine owns the visible face unless an internal
  // caller deliberately supplies an explicit expression override.
  const renderedExpression = expression;
  const renderedSilhouette = silhouetteFor(definition);
  useImperativeHandle(ref, () => ({ blink: () => inner.current?.blink(), spin: (durationMs?: number) => inner.current?.spin(durationMs), setExpression: (index: number) => inner.current?.setExpression(index) }), []);
  useEffect(() => { if (!animated || motion === "none") return; const next = MOTION_STATE[motion]; if (!next) return; setMotionState(next); const timer = window.setTimeout(() => setMotionState(null), 1400); return () => window.clearTimeout(timer); }, [animated, motion, motionKey]);
  const pointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => { if (!trackPointer || !animated) return; const rect = event.currentTarget.getBoundingClientRect(); const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1; const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1; const range = forward ? 1 : 0.25; setPointer({ x: Math.max(-1, Math.min(1, x)) * range, y: Math.max(-1, Math.min(1, y)) * range }); };
  return <span className="inline-flex shrink-0" data-avatar-contract="native-cursor-v1" data-avatar-surface={presentation.surface} data-avatar-silhouette={renderedSilhouette.name} data-avatar-preset={definition.avatarPresetId ?? ""} data-avatar-state={renderedState} data-avatar-motion={motion} data-avatar-motion-key={motionKey} data-avatar-animated={animated ? "true" : "false"} data-avatar-native-engine="CursorAvatar" data-avatar-eye-scale={String(eyeScale ?? presentation.eyeScale)} onPointerMove={trackPointer && animated ? pointerMove : undefined} onPointerLeave={trackPointer && animated ? () => setPointer({ x: 0, y: 0 }) : undefined}>
    <CursorAvatar ref={inner} state={/* SAFETY: MausState and CursorState are the same persisted runtime union. */ renderedState as CursorState} expression={renderedExpression} size={size} silhouette={renderedSilhouette} gradient={gradientFor(color)} title={label ?? null} gaze={{ x: (gaze?.x ?? 0) + pointer.x, y: (gaze?.y ?? 0) + pointer.y }} lookAround={lookAround ?? 0.5} turn={turn} spring={spring} eyeScale={eyeScale ?? presentation.eyeScale} showMouth={showMouth} mouthStroke={mouthStroke} motion={animated ? 1 : 0} effects={animated} glyphs={animated} autoBlink={animated && autoBlink} autoExpression={animated && autoExpression} paused={!animated} />
  </span>;
}
export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export type BotAvatarProps = Omit<MausAvatarProps, "color"> & { bot: { name?: string; color: MausColor; avatarUrl?: string | null; avatarCrop?: BotAvatarCrop; avatarDefinition?: BotProceduralAvatar | null }; onImageError?: () => void };
export function BotAvatar({ bot, size = 44, label, onImageError, ...props }: BotAvatarProps) {
  const profile = botAvatarProfile(bot); const [failed, setFailed] = useState(false); useEffect(() => setFailed(false), [profile.avatarUrl]);
  if (profile.avatarCrop === "mascot" || !profile.avatarUrl || failed) return <MausAvatar {...props} color={bot.color} avatarDefinition={profile.avatarDefinition} size={size} label={label ?? bot.name} />;
  const radius = profile.avatarCrop === "circle" ? "50%" : profile.avatarCrop === "rounded" ? "22%" : "0";
  return <img src={profile.avatarUrl} alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")} width={size} height={size} draggable={false} onError={() => { setFailed(true); onImageError?.(); }} className="block shrink-0 bg-raised object-cover" style={{ width: size, height: size, borderRadius: radius }} />;
}
export function InitialsAvatar({ initials, size = 32 }: { initials: string; size?: number }) { return <div className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials}</div>; }
