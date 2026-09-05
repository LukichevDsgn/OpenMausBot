import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CANONICAL_FACE_CONTRACT,
  canonicalFacePresentationForSurface,
  blobatarEffectMode,
  blobatarGazeOptions,
  BotAvatar,
  MausAvatar,
  avatarDefinitionForRegistryEntry,
  avatarBodyFingerprintForDefinition,
  bodyOpticalTokenForDefinition,
  blobatarPresetGeometry,
  nativeFaceBoundsForDefinition,
  nativeFaceScaleForDefinition,
  MIN_NATIVE_FACE_SCALE,
  CANONICAL_NATIVE_FACE_SCALE,
  BODY_OPTICAL_TOKEN,
  SELECTABLE_AVATAR_REGISTRY,
  SELECTABLE_AVATAR_REGISTRY_COUNT,
} from "./Avatar";
import { FACE_BOX } from "./CursorAvatar";
import { AVATAR_LAB_LIVE_PREVIEW_PROPS, AVATAR_LAB_STATIC_PREVIEW_PROPS, avatarLabPreviewDefinition, randomizeAvatarLabDraft } from "./AvatarLabDialog";
import { type BotProceduralAvatar } from "../../shared/bot-avatar";
import * as avatarCatalog from "@/lib/avatar-presets";
import { DEFAULT_PROCEDURAL_AVATAR, proceduralAvatarPresentation } from "@/lib/procedural-avatar";

const registryEntries = SELECTABLE_AVATAR_REGISTRY;
const definitions: BotProceduralAvatar[] = registryEntries.map((entry) => avatarDefinitionForRegistryEntry(entry, `test-${entry.id}`));

describe("native avatar engine", () => {
  it("keeps pointer and reduced-motion gating deterministic", () => {
    expect(blobatarGazeOptions(true, true)).toEqual({ travel: 3, lookAt: "pointer" });
    expect(blobatarGazeOptions(true, false)).toEqual({ travel: undefined, lookAt: null });
    expect(blobatarGazeOptions(true, true, true)).toEqual({ travel: undefined, lookAt: null });
    expect(blobatarEffectMode(true, false)).toBe("animated");
    expect(blobatarEffectMode(true, true)).toBe("static");
  });

  it("renders every selectable shape with exactly one visible native face", () => {
    expect(SELECTABLE_AVATAR_REGISTRY_COUNT).toBe(20);
    expect(registryEntries).toHaveLength(SELECTABLE_AVATAR_REGISTRY_COUNT);
    expect(new Set(registryEntries.map((entry) => entry.id)).size).toBe(SELECTABLE_AVATAR_REGISTRY_COUNT);
    for (const [index, definition] of definitions.entries()) {
      expect(registryEntries[index]?.kind).toMatch(/^(preset|procedural)$/);
      const markup = renderToStaticMarkup(createElement(MausAvatar, { color: "blue", avatarDefinition: definition, state: "idle", size: 44, animated: true, trackPointer: false }));
      expect((markup.match(/data-avatar-native-engine="CursorAvatar"/g) ?? [])).toHaveLength(1);
      expect(markup).toContain('data-avatar-contract="native-cursor-v1"');
      expect(markup).not.toContain("CanonicalFaceRig");
      expect(markup).not.toContain("data-canonical-avatar-face");
      expect(markup).not.toContain('eyeColor="transparent"');
      expect(markup).toContain("data-avatar-native-engine=\"CursorAvatar\"");
      expect(markup).toContain("#ffffff");
    }
  });

  it("keeps the authoritative Blobatar preset identities and exact body adapters", () => {
    const expected = {
      strobi: "round", freddy: "boxy", citrus: "organic", nova: "capsule", "grok-bot": "nub",
      sunee: "cloud", kirby: "droplet", cloudee: "hexagon", cubee: "sun", onee: "triangle",
    } as const;
    const presetEntries = registryEntries.filter((entry) => entry.kind === "preset" && entry.avatarPresetId !== "openmaus-cursor");
    expect(presetEntries).toHaveLength(10);
    for (const entry of presetEntries) {
      // SAFETY: the filtered registry excludes the sole non-Blobatar preset and all remaining ids are keys of expected.
      const id = entry.avatarPresetId! as keyof typeof expected;
      expect(avatarCatalog["blobatarShapeForPreset"](id)).toBe(expected[id]);
      expect(avatarCatalog["blobatarShapePresentation"](expected[id])).toBeDefined();
      const definition = avatarDefinitionForRegistryEntry(entry, `exact-${id}`);
      const markup = renderToStaticMarkup(createElement(MausAvatar, { color: "green", avatarDefinition: definition, size: 44, animated: false }));
      expect(markup).toContain(`data-avatar-silhouette="blobatar-${expected[id]}"`);
    }
    const fingerprints = new Set(presetEntries.map((entry) => avatarBodyFingerprintForDefinition(avatarDefinitionForRegistryEntry(entry, `exact-${entry.id}`))));
    expect(fingerprints).toHaveLength(10);
    expect(new Set(registryEntries.map((entry) => avatarBodyFingerprintForDefinition(avatarDefinitionForRegistryEntry(entry)))).size).toBe(20);
  });

  it("applies one registry optical token after geometric fitting, without changing face scale", () => {
    const ids = ["strobi", "freddy", "citrus", "nova", "grok-bot", "sunee", "kirby", "cloudee", "cubee", "onee"] as const;
    for (const id of ids) {
      const geometry = blobatarPresetGeometry(id);
      expect(geometry.opticalCorrection).toBe(1);
      expect(geometry.opticalToken).toBe(BODY_OPTICAL_TOKEN[`preset:${id}`]);
      expect(geometry.normalizedArea).toBeGreaterThanOrEqual(0.4);
      expect(geometry.normalizedArea).toBeLessThanOrEqual(1.2);
      expect(geometry.anchor.scale, id).toBeCloseTo(CANONICAL_NATIVE_FACE_SCALE, 6);
      expect(geometry.anchor.scale).toBeLessThanOrEqual(1.18);
      // Every authored mark stays a separate child (preserving overlap), while
      // all marks reference one user-space gradient definition.
      const markup = renderToStaticMarkup(createElement(MausAvatar, {
        color: "green", avatarDefinition: { ...DEFAULT_PROCEDURAL_AVATAR, avatarPresetId: id }, size: 64, animated: false,
      }));
      const gradientPaints = markup.match(/fill="url\(#mascot[^"]+-grad\)"/g) ?? [];
      expect(gradientPaints).toHaveLength(geometry.bodyMarkCount);
      expect(markup).toContain('gradientUnits="userSpaceOnUse"');
      expect(markup).toContain(`x1="${geometry.gradientSpace.x1}" y1="${geometry.gradientSpace.y1}" x2="${geometry.gradientSpace.x2}" y2="${geometry.gradientSpace.y2}"`);
      expect(markup).not.toContain('fill-rule="evenodd"');
    }
    // The previously underweight triangle is explicitly inside the same
    // audited occupancy band as its peers, while Cursor keeps its brand fit.
    expect(blobatarPresetGeometry("onee").normalizedArea).toBeGreaterThan(0.45);
    expect(blobatarPresetGeometry("cubee").normalizedArea).toBeGreaterThan(0.45);
  });

  it("has exactly one final body token for every selectable identity", () => {
    expect(Object.keys(BODY_OPTICAL_TOKEN)).toHaveLength(SELECTABLE_AVATAR_REGISTRY_COUNT);
    expect(BODY_OPTICAL_TOKEN["preset:openmaus-cursor"]).toBe(1);
    for (const entry of registryEntries) {
      const definition = avatarDefinitionForRegistryEntry(entry, `token-${entry.id}`);
      const token = bodyOpticalTokenForDefinition(definition);
      // SAFETY: registry ids are exactly the keys of BODY_OPTICAL_TOKEN by the assertion above.
      expect(token).toBe(BODY_OPTICAL_TOKEN[entry.id as keyof typeof BODY_OPTICAL_TOKEN]);
      expect(Number.isFinite(token)).toBe(true);
      expect(token).toBeGreaterThan(0.9);
      expect(token).toBeLessThan(1.6);
      const markup = renderToStaticMarkup(createElement(MausAvatar, { color: "green", avatarDefinition: definition, size: 44, animated: false }));
      // Optical correction belongs only to silhouette.fit; the native face
      // anchor is serialized independently and never contains this token.
      expect(markup).toContain('data-avatar-native-engine="CursorAvatar"');
      expect(markup).not.toContain(`scale(${token}) translate(-114 -114) translate(114 114) scale(${token})`);
    }
  });

  it("keeps the original Cursor gradient contract untouched", () => {
    const markup = renderToStaticMarkup(createElement(MausAvatar, { color: "green", avatarDefinition: DEFAULT_PROCEDURAL_AVATAR, size: 64, animated: false }));
    expect(markup).not.toContain('gradientUnits="userSpaceOnUse"');
    expect(markup).toContain('x1="1" y1="0" x2="0" y2="1"');
  });

  it("keeps Avatar Lab options on the live native idle contract in the normal suite", () => {
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).toEqual({ state: "idle", animated: true, trackPointer: false });
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("expression");
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("autoBlink");
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("autoExpression");
    expect(AVATAR_LAB_STATIC_PREVIEW_PROPS).toEqual({ state: "idle", animated: false, trackPointer: false, autoBlink: false, autoExpression: false, expression: 6 });
    const savedFace = { ...DEFAULT_PROCEDURAL_AVATAR, expressionPreset: "delighted" as const };
    expect(avatarLabPreviewDefinition(savedFace)).not.toHaveProperty("expressionPreset");
    expect(savedFace.expressionPreset).toBe("delighted");
  });

  it("ignores legacy expression presets unless an explicit override is supplied", () => {
    const steady = { ...DEFAULT_PROCEDURAL_AVATAR, expressionPreset: "steady" as const };
    const legacyAngry = { ...steady, expressionPreset: "alert" as const };
    const renderIdle = (avatarDefinition: BotProceduralAvatar) => renderToStaticMarkup(createElement(MausAvatar, {
      color: "green", avatarDefinition, state: "idle", animated: false, trackPointer: false, size: 64,
    }));
    expect(renderIdle(legacyAngry)).toBe(renderIdle(steady));
    expect(renderIdle(avatarLabPreviewDefinition(legacyAngry))).toBe(renderIdle(avatarLabPreviewDefinition(steady)));
    for (const state of ["working", "surprised", "alerting"] as const) {
      const markup = renderToStaticMarkup(createElement(MausAvatar, {
        color: "green", avatarDefinition: legacyAngry, state, animated: false, trackPointer: false, size: 64,
      }));
      expect(markup).toContain(`data-avatar-state="${state}"`);
      expect(markup).toContain('data-avatar-native-engine="CursorAvatar"');
    }
  });

  it("randomizes only body, color, and persisted eye geometry", () => {
    const base: BotProceduralAvatar = {
      ...DEFAULT_PROCEDURAL_AVATAR,
      avatarPresetId: "openmaus-cursor",
      expressionPreset: "steady",
      mouthStyle: "soft",
      restingAnimationId: "idle",
    };
    const samples = [
      [0.01, 0.1, 0.1],
      [0.42, 0.5, 0.5],
      [0.84, 0.9, 0.9],
    ] as const;
    const results = samples.map((values) => {
      let index = 0;
      return randomizeAvatarLabDraft(base, "green", () => values[index++] ?? 0.1);
    });
    const identityKey = (definition: BotProceduralAvatar) => definition.avatarPresetId ?? `procedural:${definition.silhouette}`;
    expect(new Set(results.map((result) => identityKey(result.definition))).size).toBeGreaterThan(1);
    expect(new Set(results.map((result) => result.definition.eyeStyle)).size).toBeGreaterThan(1);
    expect(new Set(results.map((result) => result.color)).size).toBeGreaterThan(1);
    for (const result of results) {
      expect(identityKey(result.definition)).not.toBe(identityKey(base));
      expect(result.definition.eyeStyle).not.toBe(base.eyeStyle);
      expect(result.color).not.toBe("green");
      expect(result.definition.expressionPreset).toBe(base.expressionPreset);
      expect(result.definition.mouthStyle).toBe(base.mouthStyle);
      expect(result.definition.restingAnimationId).toBe(base.restingAnimationId);
      const markup = renderToStaticMarkup(createElement(MausAvatar, {
        color: result.color,
        avatarDefinition: result.definition,
        state: "idle",
        motion: "none",
        animated: true,
        trackPointer: false,
        size: 64,
      }));
      expect(markup).toContain('data-avatar-state="idle"');
      expect(markup).toContain('data-avatar-motion="none"');
      expect(markup).toContain('data-avatar-native-engine="CursorAvatar"');
    }
  });

  it("keeps Nova inside the rendered container and Onee face safely raised", () => {
    const nova = blobatarPresetGeometry("nova");
    const sourceCentreX = (nova.sourceBounds.left + nova.sourceBounds.right) / 2;
    const sourceCentreY = (nova.sourceBounds.top + nova.sourceBounds.bottom) / 2;
    const fitted = {
      left: FACE_BOX / 2 + (nova.sourceBounds.left - sourceCentreX) * nova.fitScale,
      right: FACE_BOX / 2 + (nova.sourceBounds.right - sourceCentreX) * nova.fitScale,
      top: FACE_BOX / 2 + (nova.sourceBounds.top - sourceCentreY) * nova.fitScale,
      bottom: FACE_BOX / 2 + (nova.sourceBounds.bottom - sourceCentreY) * nova.fitScale,
    };
    expect(nova.opticalToken).toBe(BODY_OPTICAL_TOKEN["preset:nova"]);
    // Keep a deterministic inset from the SVG viewBox edge; the native
    // Cursor viewBox has 15 units of padding, so -10..238.5 is the safe
    // container contract for authored Blobatar bounds.
    expect(fitted.left).toBeGreaterThanOrEqual(-10);
    expect(fitted.right).toBeLessThanOrEqual(FACE_BOX + 10);
    expect(fitted.top).toBeGreaterThanOrEqual(-10);
    expect(fitted.bottom).toBeLessThanOrEqual(FACE_BOX + 10);

    const onee = blobatarPresetGeometry("onee");
    expect(onee.anchor.y).toBeLessThan(114);
    const definition = { ...DEFAULT_PROCEDURAL_AVATAR, avatarPresetId: "onee" as const };
    for (const size of [16, 24, 32, 44, 64]) {
      for (const state of ["idle", "surprised", "alerting"] as const) {
        const markup = renderToStaticMarkup(createElement(MausAvatar, {
          color: "green", avatarDefinition: definition, state, size, animated: true,
          motion: state === "surprised" ? "surprise" : state === "alerting" ? "alert" : "none",
          trackPointer: false,
        }));
        expect(markup).toContain('data-avatar-native-engine="CursorAvatar"');
        expect(markup).toContain(`data-avatar-state="${state}"`);
      }
    }
  });

  it("preserves the original Cursor silhouette without an outer scale", () => {
    const markup = renderToStaticMarkup(createElement(MausAvatar, { color: "green", avatarDefinition: { ...definitions[0]!, silhouette: "cursor", avatarPresetId: undefined }, size: 64, animated: true, trackPointer: false }));
    expect(markup).toContain('data-avatar-surface="openmaus-cursor"');
    expect(markup).toContain('viewBox="-15 -15 258.541 258.541"');
    expect(markup).not.toContain("transform:scale");
  });

  it("keeps the full runtime contract for every stored silhouette and freezes when requested", () => {
    const stored = [...definitions, ...(["moon", "hex"] as const).map((silhouette) => ({ version: 1 as const, seed: `legacy-${silhouette}`, silhouette, eyeStyle: "balanced" as const, mouthStyle: "soft" as const }))];
    for (const avatarDefinition of stored) {
      const live = renderToStaticMarkup(createElement(MausAvatar, { color: "cyan", avatarDefinition, state: "surprised", motion: "surprise", motionKey: 3, size: 44, animated: true, trackPointer: false }));
      const paused = renderToStaticMarkup(createElement(MausAvatar, { color: "cyan", avatarDefinition, state: "surprised", motion: "surprise", motionKey: 3, size: 44, animated: false, trackPointer: false }));
      expect(live).toContain('data-avatar-state="surprised"');
      expect(live).toContain('data-avatar-motion="surprise"');
      expect(live).toContain('data-avatar-animated="true"');
      expect(paused).toContain('data-avatar-animated="false"');
      expect(paused).toContain('data-avatar-native-engine="CursorAvatar"');
      expect(live).toContain('data-avatar-contract="native-cursor-v1"');
    }
  });

  it("flows mouth and eyeScale through the one native engine", () => {
    const base = { color: "purple" as const, avatarDefinition: definitions[12]!, state: "surprised" as const, size: 64, animated: false, trackPointer: false };
    const wide = renderToStaticMarkup(createElement(MausAvatar, { ...base, eyeScale: 1.18, mouthStroke: 6.5 }));
    const hidden = renderToStaticMarkup(createElement(MausAvatar, { ...base, showMouth: false }));
    expect(wide).toContain('data-avatar-eye-scale="1.18"');
    expect(wide).toContain('stroke-width="6.5"');
    expect(hidden).not.toContain('stroke-width="7.5"');
    expect(hidden).not.toContain('stroke="#ffffff"');
  });

  it("enumerates the full native engine contract for every registry entry", () => {
    for (const entry of registryEntries) {
      const definition = avatarDefinitionForRegistryEntry(entry);
      for (const size of [16, 24, 32, 44, 64]) {
        const idle = renderToStaticMarkup(createElement(MausAvatar, { color: "green", avatarDefinition: definition, state: "idle", size, animated: true, trackPointer: false }));
        const reaction = renderToStaticMarkup(createElement(MausAvatar, { color: "green", avatarDefinition: definition, state: "surprised", motion: "surprise", motionKey: 1, size, animated: true, trackPointer: false }));
        const frozen = renderToStaticMarkup(createElement(MausAvatar, { color: "green", avatarDefinition: definition, state: "working", size, animated: false, trackPointer: false }));
        expect(idle).toContain('data-avatar-native-engine="CursorAvatar"');
        expect(idle).toContain('data-avatar-contract="native-cursor-v1"');
        expect(reaction).toContain('data-avatar-state="surprised"');
        expect(reaction).toContain('data-avatar-motion="surprise"');
        expect(reaction).toContain('data-avatar-animated="true"');
        expect(frozen).toContain('data-avatar-animated="false"');
        expect(frozen).toContain('data-avatar-native-engine="CursorAvatar"');
      }
    }
  });

  it("keeps safe-zone bounds finite across all surfaces, sizes and eye extremes", () => {
    const epsilon = 1e-6;
    for (const [index, definition] of definitions.entries()) {
      const presentation = canonicalFacePresentationForSurface(proceduralAvatarPresentation(definition).surface);
      expect(presentation.opticalScale).toBeGreaterThanOrEqual(CANONICAL_FACE_CONTRACT.minOpticalScale);
      expect(presentation.opticalScale).toBeLessThanOrEqual(CANONICAL_FACE_CONTRACT.maxOpticalScale);
      for (const size of [16, 24, 32, 44, 64]) {
        expect(size).toBeGreaterThan(0);
        const bounds = nativeFaceBoundsForDefinition(definition);
        const numericBounds = [bounds.left, bounds.right, bounds.top, bounds.bottom];
        if (definition.avatarPresetId === "openmaus-cursor") {
          expect(numericBounds.every(Number.isFinite)).toBe(true);
          continue;
        }
        expect(bounds.left, `${registryEntries[index]?.id} left`).toBeGreaterThanOrEqual(bounds.faceSafeZone.left - epsilon);
        expect(bounds.right, `${registryEntries[index]?.id} right`).toBeLessThanOrEqual(bounds.faceSafeZone.right + epsilon);
        expect(bounds.top, `${registryEntries[index]?.id} top`).toBeGreaterThanOrEqual(bounds.faceSafeZone.top - epsilon);
        expect(bounds.bottom, `${registryEntries[index]?.id} bottom`).toBeLessThanOrEqual(bounds.faceSafeZone.bottom + epsilon);
        expect(numericBounds.every(Number.isFinite)).toBe(true);
        expect(nativeFaceScaleForDefinition(definition), `${registryEntries[index]?.id} face scale`).toBeGreaterThanOrEqual(MIN_NATIVE_FACE_SCALE);
      }
    }
  });

  it("keeps Nova expression 0 and procedural capsule inside the exact native envelope", () => {
    const cases = [
      definitions.find((definition) => definition.avatarPresetId === "nova")!,
      definitions.find((definition) => definition.silhouette === "capsule" && !definition.avatarPresetId)!,
    ];
    const scales = cases.map((definition) => nativeFaceScaleForDefinition(definition));
    expect(scales[0]).toBeCloseTo(CANONICAL_NATIVE_FACE_SCALE, 6);
    expect(scales[1]).toBeGreaterThanOrEqual(MIN_NATIVE_FACE_SCALE);
    for (const definition of cases) {
      const bounds = nativeFaceBoundsForDefinition(definition, { eyeScale: 1, showMouth: true, mouthStroke: 7.5 });
      expect(bounds.left).toBeGreaterThanOrEqual(bounds.faceSafeZone.left - 1e-6);
      expect(bounds.right).toBeLessThanOrEqual(bounds.faceSafeZone.right + 1e-6);
      expect(bounds.top).toBeGreaterThanOrEqual(bounds.faceSafeZone.top - 1e-6);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.faceSafeZone.bottom + 1e-6);
    }
  });

  it("keeps two visible native eyes and mouth geometry for every Blobatar expression sample", () => {
    const presetEntries = registryEntries.filter((entry) => entry.kind === "preset" && entry.avatarPresetId !== "openmaus-cursor");
    for (const entry of presetEntries) {
      for (const expression of [6, 0, 8]) {
        const markup = renderToStaticMarkup(createElement(MausAvatar, {
          color: "green",
          avatarDefinition: avatarDefinitionForRegistryEntry(entry, `expression-${entry.id}-${expression}`),
          expression,
          size: 44,
          animated: false,
          trackPointer: false,
        }));
        // SSR leaves native paths to the CursorAvatar draw loop, but the
        // contract must still serialize one body plus two eyes and a mouth.
        expect((markup.match(/<path(?:\s|>)/g) ?? []).length, `${entry.id} expression ${expression}`).toBeGreaterThanOrEqual(3);
        expect(markup).toContain('data-avatar-native-engine="CursorAvatar"');
        expect(markup).toContain('stroke-linecap="round"');
      }
    }
  });

  it("keeps every Lab option card static while the large preview stays unpinned", () => {
    expect(AVATAR_LAB_STATIC_PREVIEW_PROPS).toEqual({ state: "idle", animated: false, trackPointer: false, autoBlink: false, autoExpression: false, expression: 6 });
    expect(AVATAR_LAB_LIVE_PREVIEW_PROPS).not.toHaveProperty("expression");
  });

  it("preserves list/profile/chat parity and uploaded avatars", () => {
    const definition = definitions[15]!;
    const list = renderToStaticMarkup(createElement(MausAvatar, { color: "purple", avatarDefinition: definition, state: "working", size: 24, animated: false }));
    const profile = renderToStaticMarkup(createElement(MausAvatar, { color: "purple", avatarDefinition: definition, state: "working", size: 64, animated: false }));
    const chat = renderToStaticMarkup(createElement(BotAvatar, { bot: { name: "Mira", color: "purple", avatarDefinition: definition }, state: "working", size: 44, animated: false }));
    for (const markup of [list, profile, chat]) expect(markup).toContain('data-avatar-native-engine="CursorAvatar"');
    const uploaded = renderToStaticMarkup(createElement(BotAvatar, { bot: { name: "Mira", color: "purple", avatarUrl: "/api/attachments/avatar.webp", avatarCrop: "circle", avatarDefinition: definition }, size: 44 }));
    expect(uploaded).toContain("<img");
    expect(uploaded).not.toContain("data-avatar-native-engine");
  });
});
