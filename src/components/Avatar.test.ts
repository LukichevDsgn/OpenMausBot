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
import { MAUS_STATES } from "@/lib/mascot";

const definition = {
  ...DEFAULT_PROCEDURAL_AVATAR,
  seed: "parity-avatar",
  silhouette: "leaf" as const,
};

const surfaceFrom = (markup: string) =>
  markup.match(/data-avatar-surface="([^"]+)"/)?.[1];

const persistedSilhouettes = [
  "cursor",
  ...VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES,
  "moon",
  "hex",
] as const;

const canonicalFaceFrom = (markup: string) =>
  markup.slice(markup.lastIndexOf('<svg viewBox="0 0 100 100"'));

describe("canonical procedural avatar face", () => {
  it("keeps the complete upright face inside every visible shape safe zone", () => {
    for (const silhouette of persistedSilhouettes) {
      const presentation = proceduralAvatarPresentation({
        ...DEFAULT_PROCEDURAL_AVATAR,
        silhouette,
      });
      expect(presentation.faceScale * presentation.opticalScale, silhouette).toBeCloseTo(0.78, 6);
      for (const state of MAUS_STATES) {
        for (const gaze of [{ x: -1.5, y: -1 }, { x: 0, y: 0 }, { x: 1.5, y: 1 }]) {
          const bounds = canonicalFaceBounds(
            presentation.faceOffset,
            presentation.faceScale,
            presentation.opticalScale,
            { state, gaze },
          );
          const scope = `${silhouette}:${state}:${gaze.x},${gaze.y}`;
          expect(bounds.left, scope).toBeGreaterThanOrEqual(presentation.faceSafeZone.left);
          expect(bounds.right, scope).toBeLessThanOrEqual(presentation.faceSafeZone.right);
          expect(bounds.top, scope).toBeGreaterThanOrEqual(presentation.faceSafeZone.top);
          expect(bounds.bottom, scope).toBeLessThanOrEqual(presentation.faceSafeZone.bottom);
          expect(Object.values(bounds).every(Number.isFinite), scope).toBe(true);
        }
      }
    }
  });

  it("renders one white face rig and a silhouette-fitted gradient for every visible shape", () => {
    for (const silhouette of persistedSilhouettes) {
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

  it("keeps automatic canonical blinking active unless animation is paused", () => {
    const animatedMarkup = renderToStaticMarkup(createElement(MausAvatar, {
      color: "blue",
      state: "working",
      size: 44,
      animated: true,
      trackPointer: false,
    }));
    const pausedMarkup = renderToStaticMarkup(createElement(MausAvatar, {
      color: "blue",
      state: "working",
      size: 44,
      animated: false,
      trackPointer: false,
    }));

    expect(animatedMarkup).toContain("data-avatar-auto-blink");
    expect(pausedMarkup).not.toContain("data-avatar-auto-blink");
  });

  it("applies the same state, motion, gaze, and pause contract to every stored silhouette", () => {
    for (const silhouette of persistedSilhouettes) {
      const avatarDefinition = { ...DEFAULT_PROCEDURAL_AVATAR, silhouette };
      const animatedMarkup = renderToStaticMarkup(createElement(MausAvatar, {
        avatarDefinition,
        color: "cyan",
        state: "working",
        motion: "surprise",
        motionKey: 17,
        gaze: { x: 1, y: -1 },
        size: 44,
        animated: true,
        trackPointer: false,
      }));
      const pausedMarkup = renderToStaticMarkup(createElement(MausAvatar, {
        avatarDefinition,
        color: "cyan",
        state: "working",
        motion: "surprise",
        motionKey: 17,
        gaze: { x: 1, y: -1 },
        size: 44,
        animated: false,
        trackPointer: false,
      }));

      expect(animatedMarkup, silhouette).toContain('data-avatar-state="working"');
      expect(animatedMarkup, silhouette).toContain('data-avatar-motion="surprise"');
      expect(animatedMarkup, silhouette).toContain('data-avatar-motion-key="17"');
      expect(animatedMarkup, silhouette).toContain('data-avatar-animated="true"');
      expect(animatedMarkup, silhouette).toContain('data-avatar-face-state="working"');
      expect(animatedMarkup, silhouette).toContain("data-avatar-auto-blink");
      expect(pausedMarkup, silhouette).toContain('data-avatar-animated="false"');
      expect(pausedMarkup, silhouette).not.toContain("data-avatar-auto-blink");
      expect(pausedMarkup, silhouette).not.toContain("data-avatar-one-shot-blink");
    }
  });

  it("keeps the canonical face upright and optically equal at every app size", () => {
    for (const size of [16, 24, 32, 44, 64]) {
      const expectedEyeWidth = CANONICAL_FACE_CONTRACT.eyeWidth * 0.78 * size / 100;
      for (const silhouette of persistedSilhouettes) {
        const presentation = proceduralAvatarPresentation({
          ...DEFAULT_PROCEDURAL_AVATAR,
          silhouette,
        });
        const markup = renderToStaticMarkup(createElement(MausAvatar, {
          color: "purple",
          avatarDefinition: { ...DEFAULT_PROCEDURAL_AVATAR, silhouette },
          state: "surprised",
          gaze: { x: 1.5, y: -1 },
          turn: 135,
          size,
          animated: false,
          trackPointer: false,
        }));
        const faceMarkup = canonicalFaceFrom(markup);
        const renderedEyeWidth = CANONICAL_FACE_CONTRACT.eyeWidth
          * presentation.faceScale
          * presentation.opticalScale
          * size / 100;

        expect(renderedEyeWidth, `${silhouette}:${size}`).toBeCloseTo(expectedEyeWidth, 8);
        expect(faceMarkup, `${silhouette}:${size}`).toContain('data-canonical-avatar-face="true"');
        expect(faceMarkup, `${silhouette}:${size}`).not.toContain("rotate(");
        expect(faceMarkup, `${silhouette}:${size}`).not.toContain("scale(-");
      }
    }
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

  it("keeps legacy moon/orb and hex/tile surfaces identical across list, chat, profile, and preview sizes", () => {
    for (const [legacy, canonical] of [["moon", "orb"], ["hex", "tile"]] as const) {
      for (const size of [24, 32, 44, 64]) {
        const legacyMarkup = renderToStaticMarkup(createElement(MausAvatar, {
          color: "teal",
          avatarDefinition: { ...DEFAULT_PROCEDURAL_AVATAR, silhouette: legacy },
          state: "surprised",
          size,
          animated: false,
          trackPointer: false,
        }));
        const canonicalMarkup = renderToStaticMarkup(createElement(MausAvatar, {
          color: "teal",
          avatarDefinition: { ...DEFAULT_PROCEDURAL_AVATAR, silhouette: canonical },
          state: "surprised",
          size,
          animated: false,
          trackPointer: false,
        }));
        expect(surfaceFrom(legacyMarkup), `${legacy}:${size}`).toBe(surfaceFrom(canonicalMarkup));
        expect(canonicalFaceFrom(legacyMarkup), `${legacy}:${size}`)
          .toBe(canonicalFaceFrom(canonicalMarkup));
      }
    }
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
