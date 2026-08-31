import { describe, expect, it } from "vitest";

import { AVATAR_LAB_LIVE_PREVIEW_PROPS, AVATAR_LAB_STATIC_PREVIEW_PROPS, avatarLabPreviewIdentity } from "./AvatarLabDialog";
import { SELECTABLE_AVATAR_REGISTRY, SELECTABLE_AVATAR_REGISTRY_COUNT } from "./Avatar";
import { DEFAULT_PROCEDURAL_AVATAR } from "@/lib/procedural-avatar";

describe("Avatar Lab live previews", () => {
  it("keeps shape and eye-style options on the native idle animation", () => {
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).toEqual({ state: "idle", animated: true, trackPointer: false });
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS.animated).toBe(true);
    expect(SELECTABLE_AVATAR_REGISTRY).toHaveLength(SELECTABLE_AVATAR_REGISTRY_COUNT);
    expect(SELECTABLE_AVATAR_REGISTRY_COUNT).toBe(20);
  });

  it("keeps every option card canonical and disables autonomous timers", () => {
    expect(AVATAR_LAB_STATIC_PREVIEW_PROPS.expression).toBe(6);
    expect(AVATAR_LAB_STATIC_PREVIEW_PROPS.animated).toBe(false);
    expect(AVATAR_LAB_STATIC_PREVIEW_PROPS.autoBlink).toBe(false);
    expect(AVATAR_LAB_STATIC_PREVIEW_PROPS.autoExpression).toBe(false);
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("expression");
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("autoBlink");
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("autoExpression");
    expect(AVATAR_LAB_STATIC_PREVIEW_PROPS.expression).toBe(6);
  });

  it("leaves reduced-motion policy to the engine rather than disabling picker previews", () => {
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("paused");
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("reducedMotion");
  });

  it("remounts the live preview only when the selected silhouette identity changes", () => {
    const base = {
      ...DEFAULT_PROCEDURAL_AVATAR,
      seed: "test",
      silhouette: "orb" as const,
    };
    expect(avatarLabPreviewIdentity(base)).toBe("procedural:orb");
    expect(avatarLabPreviewIdentity({ ...base, eyeStyle: "wide" })).toBe("procedural:orb");
    expect(avatarLabPreviewIdentity({ ...base, avatarPresetId: "nova" })).toBe("preset:nova");
    expect(avatarLabPreviewIdentity({ ...base, silhouette: "shield" as const })).toBe("procedural:shield");
  });
});
