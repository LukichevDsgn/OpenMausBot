import { describe, expect, it } from "vitest";

import {
  EXPORTED_AVATAR_PRESETS,
  EXPORTED_RESTING_ANIMATION_IDS,
  AVATAR_OPTICAL_AREA_BAND,
  avatarEffectsAreActive,
  avatarSurfaceOpticalPresentation,
  blobatarShapeForPreset,
  blobatarShapePresentation,
  blobatarShapeTraits,
  blobatarTraitForPreset,
  exportedAnimationForState,
  exportedAvatarDefinition,
  hasShapeAgnosticAvatarEffect,
  randomizedAvatarSelection,
  resolvedAvatarSurfaceKey,
  usesNativeCursorAvatar,
} from "./avatar-presets";
import { VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES } from "./procedural-avatar";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_EYE_STYLES,
  BOT_AVATAR_PRESET_IDS,
  BOT_AVATAR_SILHOUETTES,
  botAvatarProfile,
  botProceduralAvatarSchema,
  generatedBotAvatar,
  type BotProceduralAvatar,
} from "../../shared/bot-avatar";
import { CURSOR_STATES } from "@/components/CursorAvatar";

describe("avatar rendering contract", () => {
  it("keeps the cursor plus all ten Blobatar shapes addressable", () => {
    expect(EXPORTED_AVATAR_PRESETS).toHaveLength(11);
    expect(EXPORTED_AVATAR_PRESETS.map((preset) => preset.id)).toEqual([...BOT_AVATAR_PRESET_IDS]);
    expect(new Set(EXPORTED_AVATAR_PRESETS.map((preset) => JSON.stringify(preset.surface))).size).toBe(11);
    expect(EXPORTED_AVATAR_PRESETS.every((preset) => preset.colors.eyes === "#ffffff")).toBe(true);
    expect(new Set(BOT_AVATAR_PRESET_IDS.slice(1).map(blobatarShapeForPreset)).size).toBe(10);
    expect(Object.keys(blobatarShapeTraits())).toHaveLength(10);
    expect(BOT_AVATAR_PRESET_IDS.slice(1).every((id) => blobatarTraitForPreset(id) !== null)).toBe(true);
    expect(blobatarTraitForPreset("citrus")).toBe(0.35);
    expect(blobatarTraitForPreset("freddy")).toBe(0.54);
    expect(usesNativeCursorAvatar("openmaus-cursor")).toBe(true);
  });

  it("gives every visible Blobatar shape bounded optical and face presentation data", () => {
    const shapes = BOT_AVATAR_PRESET_IDS.slice(1).map(blobatarShapeForPreset);
    expect(shapes.every((shape): shape is NonNullable<typeof shape> => shape !== null)).toBe(true);
    for (const shape of shapes) {
      if (!shape) continue;
      const presentation = blobatarShapePresentation(shape);
      expect(presentation.opticalScale).toBeGreaterThanOrEqual(0.7);
      expect(presentation.opticalScale).toBeLessThanOrEqual(1.3);
      expect(presentation.faceScale).toBeGreaterThanOrEqual(0.7);
      expect(presentation.faceScale).toBeLessThanOrEqual(1.1);
      expect(Math.abs(presentation.faceOffset.x)).toBeLessThanOrEqual(16);
      expect(Math.abs(presentation.faceOffset.y)).toBeLessThanOrEqual(16);
    }
  });

  it("keeps every visible rendered silhouette inside the optical area band", () => {
    const surfaces = [
      ...BOT_AVATAR_PRESET_IDS.map((avatarPresetId) => resolvedAvatarSurfaceKey({ avatarPresetId })),
      ...VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES.map((silhouette) => resolvedAvatarSurfaceKey({ silhouette })),
    ];

    expect(surfaces).toHaveLength(20);
    for (const surface of surfaces) {
      const metrics = avatarSurfaceOpticalPresentation(surface);
      expect(metrics.normalizedArea).toBeCloseTo(
        metrics.normalizedBounds.width * metrics.normalizedBounds.height,
        2,
      );
      const normalizedOpticalArea = metrics.normalizedArea * metrics.opticalScale ** 2;
      if (metrics.brandedException) {
        expect(normalizedOpticalArea).toBeGreaterThanOrEqual(AVATAR_OPTICAL_AREA_BAND.brandedMin);
        expect(normalizedOpticalArea).toBeLessThanOrEqual(AVATAR_OPTICAL_AREA_BAND.brandedMax);
      } else {
        expect(normalizedOpticalArea).toBeGreaterThanOrEqual(AVATAR_OPTICAL_AREA_BAND.min);
        expect(normalizedOpticalArea).toBeLessThanOrEqual(AVATAR_OPTICAL_AREA_BAND.max);
      }
    }
  });

  it("derives exactly twenty unique visible surfaces and hides legacy duplicates", () => {
    const visible = [
      ...BOT_AVATAR_PRESET_IDS.map((avatarPresetId) => ({ avatarPresetId })),
      ...VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES.map((silhouette) => ({ silhouette })),
    ];
    const surfaces = visible.map(resolvedAvatarSurfaceKey);

    expect(visible).toHaveLength(20);
    expect(new Set(surfaces).size).toBe(20);
    expect(surfaces).toContain("cursor:openmaus-cursor");
    expect(surfaces).not.toContain("procedural:cursor");
    expect(surfaces).not.toContain("procedural:moon");
    expect(surfaces).not.toContain("procedural:hex");
    expect(resolvedAvatarSurfaceKey({ silhouette: "cursor" })).toBe("cursor:openmaus-cursor");
  });

  it("maps every runtime state without consulting a resting animation choice", () => {
    expect(EXPORTED_RESTING_ANIMATION_IDS).toHaveLength(23);
    for (const state of CURSOR_STATES) {
      expect(exportedAnimationForState(state)).toBeTruthy();
      expect(exportedAnimationForState(state, "openmaus-cursor")).toBe(state);
    }
    expect(exportedAnimationForState("unknown")).toBe("idle");
    expect(exportedAnimationForState("alerting")).toBe("angry");
  });

  it("preserves definitions with no avatarPresetId and rejects unsafe persisted data", () => {
    const legacy = {
      version: 1 as const,
      seed: "legacy",
      silhouette: "gem" as const,
      eyeStyle: "wide" as const,
      mouthStyle: "soft" as const,
    };
    expect(exportedAvatarDefinition(legacy)).toEqual({});
    expect(botProceduralAvatarSchema.safeParse(legacy).success).toBe(true);
    expect(botProceduralAvatarSchema.safeParse({ ...legacy, extra: "nope" }).success).toBe(false);
    expect(generatedBotAvatar("stable-id")).toEqual(generatedBotAvatar("stable-id"));
  });

  it("keeps local and Blobatar selections when profile data is read back", () => {
    const local = {
      version: 1 as const,
      seed: "local",
      silhouette: "shield" as const,
      eyeStyle: "calm" as const,
      mouthStyle: "none" as const,
    };
    const blobatar = { ...local, avatarPresetId: "kirby" as const };
    expect(botAvatarProfile({ avatarDefinition: local }).avatarDefinition).toEqual(local);
    expect(botAvatarProfile({ avatarDefinition: blobatar }).avatarDefinition).toEqual(blobatar);
  });

  it("randomizes a non-identity valid tuple, including local shapes", () => {
    const current = { silhouette: "gem" as const, eyeStyle: "balanced" as const, color: "cyan" as const };
    const next = randomizedAvatarSelection(current, () => 0);
    expect(next).not.toEqual(current);
    const persisted: BotProceduralAvatar = {
      version: 1,
      seed: "randomized",
      silhouette: next.silhouette ?? "cursor",
      eyeStyle: next.eyeStyle,
      mouthStyle: "soft",
    };
    if (next.avatarPresetId) persisted.avatarPresetId = next.avatarPresetId;
    expect(botProceduralAvatarSchema.safeParse(persisted).success).toBe(true);
    expect(BOT_AVATAR_EYE_STYLES).toContain(next.eyeStyle);
    expect(BOT_AVATAR_COLORS).toContain(next.color);
    expect(BOT_AVATAR_SILHOUETTES).toContain(next.silhouette ?? current.silhouette);
  });

  it("canonicalizes hidden legacy shapes before randomization", () => {
    for (const random of [() => 0, () => 0.5, () => 0.999999]) {
      const next = randomizedAvatarSelection(
        { silhouette: "moon", eyeStyle: "balanced", color: "cyan" },
        random,
      );
      expect(next.silhouette === "cursor" || !next.silhouette || !["moon", "hex"].includes(next.silhouette)).toBe(true);
      expect(next.avatarPresetId === "openmaus-cursor" || next.silhouette !== "cursor").toBe(true);
    }
  });

  it("keeps shared effects available to non-Cursor shapes and parks static/reduced motion", () => {
    expect(hasShapeAgnosticAvatarEffect("alerting")).toBe(true);
    expect(hasShapeAgnosticAvatarEffect("celebrate")).toBe(true);
    expect(hasShapeAgnosticAvatarEffect("idle")).toBe(false);
    expect(avatarEffectsAreActive(true, false)).toBe(true);
    expect(avatarEffectsAreActive(false, false)).toBe(false);
    expect(avatarEffectsAreActive(true, true)).toBe(false);
  });
});
