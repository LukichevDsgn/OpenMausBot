import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  CANONICAL_FACE_CONTRACT,
  canonicalFaceBounds,
  canonicalFaceRecipeForState,
  MausAvatar,
} from "./Avatar";
import {
  DEFAULT_PROCEDURAL_AVATAR,
  proceduralAvatarPresentation,
  VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES,
} from "@/lib/procedural-avatar";

const definition = {
  ...DEFAULT_PROCEDURAL_AVATAR,
  seed: "parity-avatar",
  silhouette: "leaf" as const,
};

const surfaceFrom = (markup: string) =>
  markup.match(/data-avatar-surface="([^"]+)"/)?.[1];

describe("canonical procedural avatar face", () => {
  it("keeps the complete upright face inside every visible shape safe zone", () => {
    for (const silhouette of ["cursor", ...VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES] as const) {
      const presentation = proceduralAvatarPresentation({
        ...DEFAULT_PROCEDURAL_AVATAR,
        silhouette,
      });
      const bounds = canonicalFaceBounds(
        presentation.faceOffset,
        presentation.faceScale,
        presentation.opticalScale,
      );
      expect(presentation.faceScale * presentation.opticalScale, silhouette).toBeCloseTo(0.78, 6);
      expect(bounds.left, silhouette).toBeGreaterThanOrEqual(presentation.faceSafeZone.left);
      expect(bounds.right, silhouette).toBeLessThanOrEqual(presentation.faceSafeZone.right);
      expect(bounds.top, silhouette).toBeGreaterThanOrEqual(presentation.faceSafeZone.top);
      expect(bounds.bottom, silhouette).toBeLessThanOrEqual(presentation.faceSafeZone.bottom);
      expect(Object.values(bounds).every(Number.isFinite), silhouette).toBe(true);
    }
  });

  it("renders one white face rig and a silhouette-fitted gradient for every visible shape", () => {
    for (const silhouette of ["cursor", ...VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES] as const) {
      const markup = renderToStaticMarkup(createElement(MausAvatar, {
        color: "blue",
        avatarDefinition: { ...DEFAULT_PROCEDURAL_AVATAR, silhouette },
        state: "idle",
        size: 112,
        animated: false,
        trackPointer: false,
      }));
      expect(markup, silhouette).toContain('fill="#ffffff"');
      expect(markup, silhouette).toContain('stroke="#ffffff"');
      expect(markup, silhouette).toContain("linearGradient");
      expect(markup, silhouette).toContain(`data-avatar-surface="${proceduralAvatarPresentation({ ...DEFAULT_PROCEDURAL_AVATAR, silhouette }).surface}"`);
    }
  });

  it("routes mouth visibility and stroke controls through the canonical face rig", () => {
    const baseProps = {
      animated: false,
      color: "blue" as const,
      size: 112,
      trackPointer: false,
    };
    const defaultMarkup = renderToStaticMarkup(createElement(MausAvatar, baseProps));
    const hiddenMarkup = renderToStaticMarkup(
      createElement(MausAvatar, { ...baseProps, showMouth: false }),
    );
    const customStrokeMarkup = renderToStaticMarkup(
      createElement(MausAvatar, { ...baseProps, mouthStroke: 6.5 }),
    );

    expect(defaultMarkup).toContain(
      `stroke-width="${CANONICAL_FACE_CONTRACT.mouthStrokeWidth}"`,
    );
    expect(hiddenMarkup).not.toContain('stroke="#ffffff"');
    expect(customStrokeMarkup).toContain('stroke-width="6.5"');
  });

  it("derives representative reactions from runtime state", () => {
    expect(canonicalFaceRecipeForState("idle")).not.toEqual(canonicalFaceRecipeForState("happy"));
    expect(canonicalFaceRecipeForState("working")).toEqual(canonicalFaceRecipeForState("thinking"));
    expect(canonicalFaceRecipeForState("alerting")).toEqual(canonicalFaceRecipeForState("angry"));
    expect(canonicalFaceRecipeForState("sleeping")).not.toEqual(canonicalFaceRecipeForState("surprised"));
  });

  it("uses the same definition in list-sized, profile-sized, and BotAvatar renders", () => {
    const list = renderToStaticMarkup(createElement(MausAvatar, {
      color: "purple",
      avatarDefinition: definition,
      state: "working",
      size: 24,
      animated: false,
    }));
    const profile = renderToStaticMarkup(createElement(MausAvatar, {
      color: "purple",
      avatarDefinition: definition,
      state: "working",
      size: 112,
      animated: false,
    }));
    const shared = renderToStaticMarkup(createElement(BotAvatar, {
      bot: { name: "Mira", color: "purple", avatarDefinition: definition },
      state: "working",
      size: 44,
      animated: false,
    }));
    expect(surfaceFrom(list)).toBe("procedural:leaf");
    expect(surfaceFrom(profile)).toBe(surfaceFrom(list));
    expect(surfaceFrom(shared)).toBe(surfaceFrom(list));
  });

  it("does not replace a valid uploaded avatar", () => {
    const markup = renderToStaticMarkup(createElement(BotAvatar, {
      bot: {
        name: "Mira",
        color: "purple",
        avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
        avatarCrop: "circle",
        avatarDefinition: definition,
      },
      size: 44,
    }));
    expect(markup).toContain("<img");
    expect(markup).toContain("border-radius:50%");
    expect(markup).not.toContain("data-avatar-surface");
  });
});
