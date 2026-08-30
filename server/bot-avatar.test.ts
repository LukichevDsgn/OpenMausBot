import { describe, expect, it } from "vitest";

import {
  botAvatarProfile,
  botAvatarCropSchema,
  botProceduralAvatarSchema,
  botAvatarUrlFromStoredPath,
  botAvatarUrlSchema,
  generatedBotAvatar,
} from "../shared/bot-avatar.ts";

describe("bot avatar profile schema", () => {
  it("accepts the four supported display shapes", () => {
    for (const crop of ["mascot", "circle", "rounded", "square"]) {
      expect(botAvatarCropSchema.parse(crop)).toBe(crop);
    }
    expect(botAvatarCropSchema.safeParse("hexagon").success).toBe(false);
  });

  it("only accepts app-owned raster attachments", () => {
    expect(botAvatarUrlSchema.parse("/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp"))
      .toContain("/api/attachments/");
    for (const value of [
      "https://tracker.example/avatar.png",
      "/api/attachments/avatar.svg",
      "/api/attachments/../../config.json",
      "data:image/png;base64,abc",
    ]) {
      expect(botAvatarUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("turns a saved attachment path into a safe serving URL", () => {
    expect(botAvatarUrlFromStoredPath("/tmp/attachments/abc-123.png"))
      .toBe("/api/attachments/abc-123.png");
    expect(botAvatarUrlFromStoredPath("C:\\data\\attachments\\abc-123.jpg"))
      .toBe("/api/attachments/abc-123.jpg");
    expect(botAvatarUrlFromStoredPath("/tmp/attachments/avatar.svg")).toBeNull();
  });

  it("falls back safely for malformed persisted data", () => {
    expect(botAvatarProfile({
      avatarUrl: "https://example.test/pixel.png",
      avatarCrop: "round",
      avatarDefinition: { version: 1, seed: "safe", silhouette: "custom-svg" },
    }))
      .toEqual({ avatarCrop: "mascot" });
  });

  it("accepts only versioned procedural preset ids", () => {
    const definition = {
      version: 1 as const,
      seed: "bot_123",
      silhouette: "gem" as const,
      eyeStyle: "calm" as const,
      mouthStyle: "none" as const,
      expressionPreset: "side-eye" as const,
      avatarPresetId: "freddy" as const,
      restingAnimationId: "thinking" as const,
    };
    expect(botProceduralAvatarSchema.parse(definition)).toEqual(definition);
    for (const malformed of [
      { ...definition, version: 2 },
      { ...definition, seed: "<svg>" },
      { ...definition, silhouette: "arbitrary" },
      { ...definition, eyeStyle: "laser" },
      { ...definition, mouthStyle: "markup" },
      { ...definition, expressionPreset: "<path>" },
      { ...definition, extra: "not-persisted" },
    ]) {
      expect(botProceduralAvatarSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("generates a stable, schema-valid avatar from the persisted seed", () => {
    const first = generatedBotAvatar(" bot/id ");
    const second = generatedBotAvatar(first.definition.seed);
    expect(first).toEqual(second);
    expect(first.definition.seed).toBe("bot-id");
    expect(botProceduralAvatarSchema.safeParse(first.definition).success).toBe(true);
  });
});
