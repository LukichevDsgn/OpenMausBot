import { describe, expect, it, vi } from "vitest";

import {
  GROK_BOT_INSTRUCTION_MAX_CHARS,
  GROK_BOT_RECIPE_MAX_BYTES,
  GROK_BOT_RESPONSE_MAX_BYTES,
  GROK_BOT_TEMPLATE_ENDPOINT,
  GROK_BOT_TIMEOUT_MS,
  fetchGrokBotPackage,
  fetchGrokBotTemplate,
  grokBotRecipeToPackage,
  isGrokBotRecipe,
  parseGrokBotUrl,
} from "./grok-bot-template.ts";

const shareId = "FU-Ev6_Ju4lFGWwWRD0GD";

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}

function key(field: number, wireType: number): number[] {
  return varint(field * 8 + wireType);
}

function text(field: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...key(field, 2), ...varint(bytes.length), ...bytes];
}

function message(field: number, value: number[]): number[] {
  return [...key(field, 2), ...varint(value.length), ...value];
}

function templateBytes(
  description = "  Public instructions — preserve this text.  ",
  id = shareId,
  published = 1,
): number[] {
  return [
    ...text(1, id),
    ...text(2, "Public Grok Bot"),
    ...text(3, "orb"),
    ...text(4, "blue"),
    ...key(10, 0),
    ...varint(published),
    ...text(11, "active-version-is-not-imported"),
    ...text(12, description),
  ];
}

function responseBytes(description?: string): Uint8Array {
  return new Uint8Array([
    ...message(1, templateBytes(description)),
    ...text(2, "Public owner"),
  ]);
}

function okResponse(bytes = responseBytes()): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "application/proto" } });
}

describe("Grok Bot public import", () => {
  it("accepts only the two exact public deep-link forms", () => {
    expect(parseGrokBotUrl(`https://x.ai/bot/${shareId}`)).toEqual({ id: shareId });
    expect(parseGrokBotUrl(`https://x.ai/bot/${shareId}/`)).toEqual({ id: shareId });
    expect(parseGrokBotUrl(`grokbot://app/v1/bot-template?id=${shareId}`)).toEqual({ id: shareId });

    const rejected = [
      `https://user:x@x.ai/bot/${shareId}`,
      `https://x.ai:443/bot/${shareId}`,
      `https://x.ai/bot/${shareId}?id=extra`,
      `https://x.ai/bot/${shareId}?`,
      `https://x.ai/bot/${shareId}#fragment`,
      `https://x.ai/bot/${shareId}#`,
      `https://www.x.ai/bot/${shareId}`,
      `https://x.ai/not-a-bot/${shareId}`,
      `https://x.ai/bot/${shareId.slice(0, -1)}`,
      `grokbot://app/v1/bot-template?id=${shareId}&id=${shareId}`,
      `grokbot://app/v1/bot-template?id=${shareId}&extra=1`,
      `grokbot://app/v1/bot-template?id=${shareId}#`,
      `grokbot://app:99/v1/bot-template?id=${shareId}`,
      `grokbot://app/v1/bot-template/??id=${shareId}`,
    ];
    for (const value of rejected) expect(() => parseGrokBotUrl(value)).toThrow();
  });

  it("uses the fixed anonymous Connect v1 protobuf request and maps exact public instructions", async () => {
    let target = "";
    let init: RequestInit | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      target = String(url);
      init = options;
      return okResponse();
    }) as unknown as typeof fetch;

    const loaded = await fetchGrokBotPackage(`https://x.ai/bot/${shareId}`, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(target).toBe(GROK_BOT_TEMPLATE_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/proto", "connect-protocol-version": "1" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(GROK_BOT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(new Uint8Array([0x0a, 21, ...new TextEncoder().encode(shareId)]));

    const agent = loaded.package.agents[0]!;
    expect(loaded.package.agents).toHaveLength(1);
    expect(agent.name).toBe("Public Grok Bot");
    expect(agent.description).toBe("Public instructions — preserve this text.");
    expect(loaded.package.author.name).toBe("Public owner");
    expect(loaded.package.requirements).toEqual({ apps: [], capabilities: [] });
    expect(agent.appearance.color).toBe("blue");
    expect(agent.appearance.avatarDefinition).toBeDefined();
  });

  it("skips bounded unknown protobuf wire types but rejects malformed, truncated, or invalid known data", async () => {
    const unknown = [
      ...key(90, 0), ...varint(42),
      ...key(91, 1), 1, 2, 3, 4, 5, 6, 7, 8,
      ...key(92, 2), ...varint(3), 9, 8, 7,
      ...key(93, 5), 1, 2, 3, 4,
      ...key(94, 3), ...key(1, 0), ...varint(1), ...key(94, 4),
    ];
    const withUnknown = new Uint8Array([
      ...message(1, [...unknown, ...templateBytes()]),
      ...text(2, "owner"),
    ]);
    await expect(fetchGrokBotTemplate(`grokbot://app/v1/bot-template?id=${shareId}`, async () => okResponse(withUnknown))).resolves.toMatchObject({
      template: { shareId, published: true },
    });

    const malformed = [
      new Uint8Array([0x0a, 0x80]),
      new Uint8Array([...message(1, templateBytes()).slice(0, -1), ...text(2, "owner")]),
      new Uint8Array([...message(1, [...key(1, 0), ...varint(1), ...templateBytes()]), ...text(2, "owner")]),
    ];
    for (const bytes of malformed) {
      await expect(fetchGrokBotTemplate(`https://x.ai/bot/${shareId}`, async () => okResponse(bytes))).rejects.toThrow("response is invalid");
    }

    const missingRequiredFields = new Uint8Array([...message(1, [...text(12, "instructions")]), ...text(2, "owner")]);
    await expect(fetchGrokBotTemplate(`https://x.ai/bot/${shareId}`, async () => okResponse(missingRequiredFields))).rejects.toThrow("response is invalid");
    expect(GROK_BOT_RESPONSE_MAX_BYTES).toBeLessThanOrEqual(64 * 1024);
  });

  it("turns timeout, redirect, non-2xx, and actual-byte overflow into bounded errors", async () => {
    const url = `https://x.ai/bot/${shareId}`;
    await expect(fetchGrokBotTemplate(url, async () => { throw new Error("redirect"); })).rejects.toThrow("request failed");
    await expect(fetchGrokBotTemplate(url, async () => new Response(null, { status: 503 }))).rejects.toThrow("request failed");

    const tooLarge = new Uint8Array(GROK_BOT_RESPONSE_MAX_BYTES + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tooLarge);
        controller.close();
      },
    });
    await expect(fetchGrokBotTemplate(url, async () => new Response(stream, { status: 200 }))).rejects.toThrow("response is too large");
    await expect(fetchGrokBotTemplate(url, async () => new Response(new Uint8Array(), {
      status: 200,
      headers: { "content-length": String(GROK_BOT_RESPONSE_MAX_BYTES + 1) },
    }))).rejects.toThrow("response is too large");
  });

  it("accepts Alfred's exact 6219 public instruction characters without replacing them with a summary", async () => {
    const description = "A".repeat(6_219);
    const loaded = await fetchGrokBotPackage(`https://x.ai/bot/${shareId}`, async () => okResponse(responseBytes(description)));
    expect(loaded.package.agents[0]!.description).toBe(description);
    expect(loaded.package.summary).not.toBe(description);
    expect(GROK_BOT_INSTRUCTION_MAX_CHARS).toBe(24_000);
  });

  it("distinguishes mismatched, unpublished, empty, and instruction-cap failures", async () => {
    const url = `https://x.ai/bot/${shareId}`;
    const mismatch = new Uint8Array([
      ...message(1, templateBytes("instructions", "other-share-id-12345")),
      ...text(2, "owner"),
    ]);
    await expect(fetchGrokBotPackage(url, async () => okResponse(mismatch))).rejects.toThrow("response is invalid");
    await expect(fetchGrokBotPackage(url, async () => okResponse(new Uint8Array([
      ...message(1, templateBytes("instructions", shareId, 0)), ...text(2, "owner"),
    ])))).rejects.toThrow("profile is unpublished");
    await expect(fetchGrokBotPackage(url, async () => okResponse(responseBytes("   ")))).rejects.toThrow("instructions are empty");
    await expect(fetchGrokBotPackage(url, async () => okResponse(responseBytes("x".repeat(GROK_BOT_INSTRUCTION_MAX_CHARS + 1)))))
      .rejects.toThrow("instructions are too large");
  });
});

describe("Grok Bot full recipe import", () => {
  const recipe = () => ({
    profile: {
      name: "Recipe Grok",
      description: "Use the complete published instructions.",
      title: "Research partner",
      avatarColor: "cyan",
      avatarShape: "orb",
    },
    memory: [{ kind: "profile", createdAt: "2026-08-29T00:00:00Z", content: "PRIVATE MEMORY SENTINEL" }],
    skills: [
      { name: "Source Check", description: "Verify public claims.", content: "Keep source URLs and confidence." },
      { name: "Source Check", description: "Verify a second time.", content: "Challenge the first conclusion." },
      { name: "!!!", description: "Fallback id.", content: "Use a deterministic fallback." },
    ],
    routines: [
      { name: "Review", slug: "weekly review", description: "Review findings.", content: "Prepare a concise brief." },
      { name: "Review again", slug: "weekly review", description: "Review again.", content: "Compare with the last brief." },
    ],
    plugins: [
      { name: "Google Drive", description: "Read approved files.", pluginId: "drive-plugin" },
      { name: "Google Drive", pluginId: "drive-plugin-2" },
    ],
  });

  it("strictly converts the full recipe into one permissionless package and excludes memory", () => {
    const loaded = grokBotRecipeToPackage(recipe());
    expect(loaded.package.agents).toMatchObject([{
      key: "grok-bot",
      name: "Recipe Grok",
      title: "Research partner",
      description: "Use the complete published instructions.",
      skillIds: ["source-check", "source-check-2", "skill-3"],
      appearance: { color: "cyan" },
    }]);
    expect(loaded.package.skills?.entries.map((skill) => ({
      id: skill.id,
      defaultEnabled: skill.defaultEnabled,
      capabilities: skill.requiredCapabilities,
      tools: skill.tools,
      origin: skill.origin,
      frontmatter: skill.instructions.startsWith(`---\nname: ${skill.id}\n`),
    }))).toEqual([
      { id: "source-check", defaultEnabled: false, capabilities: [], tools: [], origin: "imported", frontmatter: true },
      { id: "source-check-2", defaultEnabled: false, capabilities: [], tools: [], origin: "imported", frontmatter: true },
      { id: "skill-3", defaultEnabled: false, capabilities: [], tools: [], origin: "imported", frontmatter: true },
    ]);
    expect(loaded.package.routines).toMatchObject([
      { key: "weekly-review", schedule: { type: "manual" }, enabledAfterInstall: false },
      { key: "weekly-review-2", schedule: { type: "manual" }, enabledAfterInstall: false },
    ]);
    expect(loaded.package.requirements.apps).toMatchObject([
      { slug: "google-drive", label: "Google Drive", optional: true },
      { slug: "google-drive-2", label: "Google Drive", optional: true },
    ]);
    expect(JSON.stringify(loaded)).not.toContain("PRIVATE MEMORY SENTINEL");
  });

  it("uses own JSON fields only and returns stable malformed, cap, and byte-limit errors", () => {
    expect(isGrokBotRecipe(recipe())).toBe(true);
    expect(isGrokBotRecipe(Object.create({ profile: {}, memory: [], skills: [], routines: [], plugins: [] }))).toBe(false);
    expect(() => grokBotRecipeToPackage({ ...recipe(), extra: true })).toThrow("Grok Bot recipe is invalid");
    expect(() => grokBotRecipeToPackage({ ...recipe(), skills: Array.from({ length: 31 }, () => recipe().skills[0]) }))
      .toThrow(/skills.*Too big|skills.*too/i);
    expect(() => grokBotRecipeToPackage({ ...recipe(), plugins: [{ name: "Bad", pluginId: "" }] }))
      .toThrow(/plugins\.0\.pluginId/);
    expect(() => grokBotRecipeToPackage("x".repeat(GROK_BOT_RECIPE_MAX_BYTES + 1))).toThrow("recipe is too large");
  });
});
