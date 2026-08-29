import { describe, expect, it } from "vitest";

import {
  AVATAR_OPTICAL_AREA_BAND,
  DEFAULT_PROCEDURAL_AVATAR,
  proceduralAvatarPresentation,
  resolvedProceduralSilhouette,
  VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES,
} from "./procedural-avatar";

describe("procedural avatar presentation", () => {
  it("gives every visible authored body one deterministic surface", () => {
    const surfaces = VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES.map((silhouette) =>
      proceduralAvatarPresentation({ ...DEFAULT_PROCEDURAL_AVATAR, silhouette }).surface
    );
    expect(VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES).toHaveLength(9);
    expect(new Set(surfaces).size).toBe(VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES.length);
  });

  it("normalizes every non-branded body into the same optical area band", () => {
    for (const silhouette of VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES) {
      const presentation = proceduralAvatarPresentation({
        ...DEFAULT_PROCEDURAL_AVATAR,
        silhouette,
      });
      expect(presentation.normalizedVisualArea, silhouette)
        .toBeGreaterThanOrEqual(AVATAR_OPTICAL_AREA_BAND.min);
      expect(presentation.normalizedVisualArea, silhouette)
        .toBeLessThanOrEqual(AVATAR_OPTICAL_AREA_BAND.max);
      expect(presentation.opticalScale).toBeGreaterThan(0);
      expect(presentation.silhouette.body).toContain("{{GRADIENT}}");
    }

    const cursor = proceduralAvatarPresentation(DEFAULT_PROCEDURAL_AVATAR);
    expect(cursor.brandedException).toBe(true);
    expect(cursor.normalizedVisualArea).toBeGreaterThanOrEqual(AVATAR_OPTICAL_AREA_BAND.brandedMin);
    expect(cursor.normalizedVisualArea).toBeLessThanOrEqual(AVATAR_OPTICAL_AREA_BAND.brandedMax);
  });

  it("renders retired stored ids through stable authored fallbacks", () => {
    expect(resolvedProceduralSilhouette("moon")).toBe("orb");
    expect(resolvedProceduralSilhouette("hex")).toBe("tile");
    expect(proceduralAvatarPresentation({ ...DEFAULT_PROCEDURAL_AVATAR, silhouette: "moon" }).surface)
      .toBe("procedural:orb");
    expect(proceduralAvatarPresentation({ ...DEFAULT_PROCEDURAL_AVATAR, silhouette: "hex" }).surface)
      .toBe("procedural:tile");
  });
});
