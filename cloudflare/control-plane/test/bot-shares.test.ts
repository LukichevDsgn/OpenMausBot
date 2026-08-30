import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { createAuth } from "../src/auth";
import { BOT_SHARE_PUBLISH_BODY_MAX_BYTES } from "../src/bot-shares";
import { readConfig } from "../src/config";
import worker from "../src/index";

const BASE_URL = "https://auth.openmausbot.test";

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  rawBody?: string;
  bodyChunks?: string[];
  headers?: Record<string, string>;
}

async function call(path: string, options: CallOptions = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: BodyInit | undefined;
  if (options.bodyChunks) {
    const encoder = new TextEncoder();
    body = new ReadableStream({
      start(controller) {
        for (const chunk of options.bodyChunks ?? []) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  } else if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}${path}`, { method: options.method ?? "GET", headers, body });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signIn(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await call("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: { email, otp, name: email.split("@", 1)[0] },
  });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("Better Auth did not return a bearer");
  return token;
}

function packageMarkdown(name = "Research Team", summary = "A safe portable team.") {
  const frontmatter = stringifyYaml({
    botmrr: 1,
    id: "research-team",
    release: "1.0.0",
    name,
    tagline: "Research with a small focused team.",
    summary,
    category: "Research",
    author: { name: "OpenMausBot user" },
    license: "Unspecified",
    outcomes: ["Produce a reviewed brief."],
    setupMinutes: 3,
    requirements: { apps: [], capabilities: [] },
    agents: [{
      key: "researcher",
      name: "Researcher",
      title: "Research lead",
      description: "Find and synthesize evidence.",
      appearance: { color: "blue" },
    }],
    chiefOfStaff: "researcher",
  }, { lineWidth: 0 }).trim();
  return `---\n${frontmatter}\n---\n\n## Activation\n\nActivate.\n\n## Mission\n\n${summary}\n\n## Outcomes\n\n- Brief\n\n## Connections\n\n- None\n\n## Team\n\nResearcher\n\n## Chief of Staff\n\nresearcher\n\n## Completion rule\n\nReturn a brief.\n`;
}

async function createShare(token: string, markdown = packageMarkdown(), visibility?: "unlisted" | "private") {
  const body: { packageMarkdown: string; visibility?: "unlisted" | "private" } = { packageMarkdown: markdown };
  if (visibility) body.visibility = visibility;
  const response = await call("/v1/bot-shares", {
    method: "POST",
    token,
    body,
  });
  expect(response.status).toBe(201);
  return response.json<{ share: {
    id: string;
    visibility: "unlisted" | "private";
    activeVersion: number;
    name: string;
    summary: string;
    sha256: string;
    byteSize: number;
    shareUrl: string;
    packageUrl: string;
  } }>();
}

describe("bot share storage and account authority", () => {
  it("applies the immutable share schema", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bot_share%' ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(["bot_share_versions", "bot_shares"]);
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'bot_share%' ORDER BY name",
    ).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual([
      "bot_share_versions_advance_after_insert",
      "bot_share_versions_expected_active_before_insert",
    ]);
  });

  it("requires an account bearer and isolates owner lists and mutations", async () => {
    const owner = await signIn("share-owner@example.com");
    const other = await signIn("share-other@example.com");
    const installation = await call("/v1/installations", {
      method: "POST",
      token: owner,
      body: { clientInstanceId: crypto.randomUUID(), name: "Test PC", platform: "windows" },
    });
    const installationCredential = (await installation.json<{ credential: string }>()).credential;

    expect((await call("/v1/bot-shares", { method: "POST", body: { packageMarkdown: packageMarkdown() } })).status).toBe(401);
    expect((await call("/v1/bot-shares", { token: installationCredential })).status).toBe(401);

    const { share } = await createShare(owner);
    expect(share.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(share.visibility).toBe("unlisted");
    expect(share.activeVersion).toBe(1);
    expect(share.packageUrl).toBe(`https://accounts.openmausbot.com/v1/bot-shares/${share.id}/package`);
    expect((await call("/v1/bot-shares", { token: other }).then((response) => response.json<{ shares: unknown[] }>()))
      .shares).toEqual([]);
    expect((await call(`/v1/bot-shares/${share.id}/visibility`, {
      method: "POST",
      token: other,
      body: { visibility: "private" },
    })).status).toBe(404);
    expect((await call(`/v1/bot-shares/${share.id}`, { method: "DELETE", token: other })).status).toBe(404);
  });
});

describe("bot share lifecycle", () => {
  it("creates immutable versions, advances active with compare-and-swap, changes visibility, and tombstones", async () => {
    const token = await signIn("share-lifecycle@example.com");
    const firstMarkdown = packageMarkdown("Research Team", "First summary");
    const { share: created } = await createShare(token, firstMarkdown);

    const updatedResponse = await call(`/v1/bot-shares/${created.id}/versions`, {
      method: "POST",
      token,
      body: { packageMarkdown: packageMarkdown("Research Team 2", "Second summary"), expectedActiveVersion: 1 },
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json<{ share: { activeVersion: number; name: string } }>();
    expect(updated.share).toMatchObject({ activeVersion: 2, name: "Research Team 2" });

    const stale = await call(`/v1/bot-shares/${created.id}/versions`, {
      method: "POST",
      token,
      body: { packageMarkdown: packageMarkdown("Lost update"), expectedActiveVersion: 1 },
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "version_conflict" });

    const versions = await env.DB.prepare(
      "SELECT version, package_markdown FROM bot_share_versions WHERE share_id = ? ORDER BY version",
    ).bind(created.id).all<{ version: number; package_markdown: string }>();
    expect(versions.results.map((row) => row.version)).toEqual([1, 2]);
    expect(versions.results[0]?.package_markdown).toContain("First summary");

    const hidden = await call(`/v1/bot-shares/${created.id}/visibility`, {
      method: "POST",
      token,
      body: { visibility: "private" },
    });
    expect(hidden.status).toBe(200);
    expect((await call(`/v1/bot-shares/${created.id}/package`)).status).toBe(404);
    expect((await call(`/s/${created.id}`)).status).toBe(404);

    expect((await call(`/v1/bot-shares/${created.id}`, { method: "DELETE", token })).status).toBe(204);
    expect((await call(`/v1/bot-shares/${created.id}/package`)).status).toBe(404);
    const listed = await call("/v1/bot-shares", { token }).then((response) => response.json<{ shares: unknown[] }>());
    expect(listed.shares).toEqual([]);
    const retained = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM bot_share_versions WHERE share_id = ?",
    ).bind(created.id).first<{ count: number }>();
    expect(retained?.count).toBe(2);
  });

  it("serves only the active unlisted package and an escaped script-free landing page", async () => {
    const token = await signIn("share-public@example.com");
    const dangerous = `<img src=x onerror=alert(1)> & "quoted"`;
    const { share } = await createShare(token, packageMarkdown("<Unsafe & Bot>", dangerous));
    const pkg = await call(`/v1/bot-shares/${share.id}/package`);
    expect(pkg.status).toBe(200);
    expect(pkg.headers.get("content-type")).toContain("text/markdown");
    expect(pkg.headers.get("x-content-sha256")).toBe(share.sha256);
    expect(await pkg.text()).toContain(dangerous);

    const landing = await call(`/s/${share.id}`);
    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await landing.text();
    expect(html).toContain("&lt;Unsafe &amp; Bot&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain(encodeURIComponent(share.packageUrl));
  });
});

describe("bot share validation and request bounds", () => {
  it("stores only canonical valid BotMRR Markdown with sha256 and UTF-8 byte size", async () => {
    const token = await signIn("share-validation@example.com");
    const invalid = await call("/v1/bot-shares", {
      method: "POST",
      token,
      body: { packageMarkdown: "---\nbotmrr: 1\n---\nnot a package" },
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_package" });

    const markdown = packageMarkdown("UTF-8 мышь");
    const { share } = await createShare(token, markdown);
    const canonical = await call(`/v1/bot-shares/${share.id}/package`).then((response) => response.text());
    expect(share.byteSize).toBe(new TextEncoder().encode(canonical).byteLength);
    expect(share.sha256).toMatch(/^[0-9a-f]{64}$/);

    const smuggled = markdown.replace("botmrr: 1", "botmrr: 1\naccountToken: secret-value") +
      "\n<!-- transcript: private runtime memory -->";
    const { share: sanitized } = await createShare(token, smuggled);
    const stored = await call(`/v1/bot-shares/${sanitized.id}/package`).then((response) => response.text());
    expect(stored).not.toContain("accountToken");
    expect(stored).not.toContain("private runtime memory");
  });

  it("caps publish streaming and package bytes without weakening the global 16 KiB cap", async () => {
    const token = await signIn("share-limit@example.com");
    const tooLargePackage = packageMarkdown() + "\n<!--" + "x".repeat(1_000_000) + "-->";
    const packageResponse = await call("/v1/bot-shares", {
      method: "POST",
      token,
      body: { packageMarkdown: tooLargePackage },
    });
    expect(packageResponse.status).toBe(413);
    await expect(packageResponse.json()).resolves.toEqual({ error: "package_too_large" });

    const framingResponse = await call("/v1/bot-shares", {
      method: "POST",
      token,
      bodyChunks: ["x".repeat(BOT_SHARE_PUBLISH_BODY_MAX_BYTES), "x"],
    });
    expect(framingResponse.status).toBe(413);
    await expect(framingResponse.json()).resolves.toEqual({ error: "request_too_large" });

    const ordinary = await call("/v1/installations", {
      method: "POST",
      token,
      rawBody: JSON.stringify({ filler: "x".repeat(16 * 1024) }),
    });
    expect(ordinary.status).toBe(413);
    await expect(ordinary.json()).resolves.toEqual({ error: "request_too_large" });
  });
});
