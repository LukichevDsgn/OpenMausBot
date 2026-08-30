import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROCEDURAL_AVATAR,
  patchProceduralAvatarExpression,
  patchProceduralAvatarSilhouette,
  PROCEDURAL_AVATAR_SILHOUETTES,
  proceduralAvatarPresentation,
  proceduralAvatarDefinition,
  resolvedProceduralSilhouette,
  VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES,
} from "./procedural-avatar";
import {
  BOT_AVATAR_EXPRESSION_PRESETS,
  BOT_AVATAR_SILHOUETTES,
  botProceduralAvatarSchema,
} from "../../shared/bot-avatar";

describe("procedural avatar edits", () => {
  it("creates a safe default when a missing definition is shaped", () => {
    expect(patchProceduralAvatarSilhouette(null, "orb")).toEqual({
      ...DEFAULT_PROCEDURAL_AVATAR,
      silhouette: "orb",
    });
  });

  it("patches only the silhouette and preserves the face recipe", () => {
    const source = {
      version: 1 as const,
      seed: "kept-seed",
      silhouette: "gem" as const,
      eyeStyle: "wide" as const,
      mouthStyle: "bold" as const,
    };

    expect(patchProceduralAvatarSilhouette(source, "pebble")).toEqual({
      ...source,
      silhouette: "pebble",
    });
    expect(proceduralAvatarDefinition(source)).toBe(source);
  });

  it("offers twelve original body geometries and keeps legacy ids", () => {
    expect(BOT_AVATAR_SILHOUETTES.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(PROCEDURAL_AVATAR_SILHOUETTES)).toEqual([...BOT_AVATAR_SILHOUETTES]);
    expect(new Set(Object.values(PROCEDURAL_AVATAR_SILHOUETTES).map((shape) => shape.body)).size)
      .toBe(BOT_AVATAR_SILHOUETTES.length);
    expect(VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES).toHaveLength(9);
    expect(VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES).not.toContain("cursor");
    expect(VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES).not.toContain("moon");
    expect(VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES).not.toContain("hex");
  });

  it("renders legacy cursor as branded and moon/hex through deterministic fallbacks", () => {
    expect(resolvedProceduralSilhouette("cursor")).toBe("cursor");
    expect(resolvedProceduralSilhouette("moon")).toBe("orb");
    expect(resolvedProceduralSilhouette("hex")).toBe("tile");
    expect(proceduralAvatarPresentation({ ...DEFAULT_PROCEDURAL_AVATAR, silhouette: "cursor" })).toMatchObject({
      surface: "openmaus-cursor",
      sourceSilhouette: "cursor",
    });
    expect(proceduralAvatarPresentation({ ...DEFAULT_PROCEDURAL_AVATAR, silhouette: "moon" })).toMatchObject({
      surface: "procedural:orb",
      sourceSilhouette: "moon",
      silhouette: PROCEDURAL_AVATAR_SILHOUETTES.orb,
    });
  });

  it("rounds Shield corners while keeping body and clip geometry identical", () => {
    const shield = PROCEDURAL_AVATAR_SILHOUETTES.shield;
    expect(shield.body).toContain("Q204 42");
    expect(shield.body).toContain("Q24 42");
    expect(shield.body).toContain("Q114 218");
    expect(shield.body).not.toContain("L207 43 V104");
    const bodyGeometry = shield.body.replace('fill="{{GRADIENT}}"', "").replace(/\s+/g, "");
    expect(bodyGeometry).toBe(shield.clip.replace(/\s+/g, ""));
  });

  it("keeps twenty named engine faces visually distinct in static previews", () => {
    expect(BOT_AVATAR_EXPRESSION_PRESETS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(BOT_AVATAR_EXPRESSION_PRESETS.map((preset) => preset.expression)).size)
      .toBe(BOT_AVATAR_EXPRESSION_PRESETS.length);
    const source = { ...DEFAULT_PROCEDURAL_AVATAR, expressionPreset: "steady" as const };
    const changed = patchProceduralAvatarExpression(source, "delighted");
    expect(changed).toMatchObject({ ...source, expressionPreset: "delighted" });
    expect(proceduralAvatarPresentation(changed).expression).toBe(11);
    expect(proceduralAvatarPresentation({ ...source, mouthStyle: "none" }).showMouth).toBe(true);
    expect(botProceduralAvatarSchema.safeParse(changed).success).toBe(true);
  });
});
