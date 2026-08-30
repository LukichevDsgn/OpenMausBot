import { describe, expect, it } from "vitest";

import { fetchSkillFromSource } from "./skill-fetch.ts";

const rootUrl = "https://api.github.com/repos/owner/repo/contents/";
const listingUrls = {
  skills: "https://api.github.com/repos/owner/repo/contents/skills",
  alpha: "https://api.github.com/repos/owner/repo/contents/skills/alpha",
  beta: "https://api.github.com/repos/owner/repo/contents/skills/beta",
};

function fixtureFetcher(alphaManifest: string, betaManifest: string): typeof fetch {
  const listings = new Map<string, unknown>([
    [rootUrl, [{ type: "dir", name: "skills", path: "skills" }]],
    [listingUrls.skills, [
      { type: "dir", name: "alpha", path: "skills/alpha" },
      { type: "dir", name: "beta", path: "skills/beta" },
    ]],
    [listingUrls.alpha, [
      { type: "file", name: "SKILL.md", path: "skills/alpha/SKILL.md", download_url: "https://fixtures.invalid/alpha" },
    ]],
    [listingUrls.beta, [
      { type: "file", name: "SKILL.md", path: "skills/beta/SKILL.md", download_url: "https://fixtures.invalid/beta" },
    ]],
  ]);
  const files = new Map([
    ["https://fixtures.invalid/alpha", alphaManifest],
    ["https://fixtures.invalid/beta", betaManifest],
  ]);
  return async (input) => {
    const url = String(input);
    if (files.has(url)) return new Response(files.get(url), { status: 200 });
    const listing = listings.get(url);
    return new Response(listing === undefined ? "not found" : JSON.stringify(listing), {
      status: listing === undefined ? 404 : 200,
    });
  };
}

describe("skill import review corrections", () => {
  it("rejects an insecure direct raw manifest before fetching", async () => {
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests += 1;
      return new Response("unsafe", { status: 200 });
    };
    await expect(
      fetchSkillFromSource("http://raw.githubusercontent.com/o/r/main/skills/unsafe/SKILL.md", fetcher),
    ).resolves.toMatchObject({ error: expect.any(String) });
    expect(requests).toBe(0);
  });

  it("matches case-insensitive name keys using the last duplicate", async () => {
    const fetcher = fixtureFetcher(
      "---\nname: alpha\ndescription: alpha fixture\n---\n",
      "---\nname: first-name\nName: beta\ndescription: beta fixture\n---\n",
    );
    await expect(fetchSkillFromSource("npx skills add owner/repo --skill beta", fetcher)).resolves.toMatchObject({
      skills: [{ source: "github.com/owner/repo/skills/beta" }],
    });
    await expect(fetchSkillFromSource("npx skills add owner/repo --skill first-name", fetcher)).resolves.toEqual({
      error: "requested skill(s) not found: first-name",
    });
  });

  it("ignores name declarations after the first frontmatter block", async () => {
    const fetcher = fixtureFetcher(
      "---\nname: alpha\ndescription: alpha fixture\n---\n",
      "---\nname: gamma\ndescription: gamma fixture\n---\n\nBody example:\nname: beta\n",
    );
    await expect(fetchSkillFromSource("npx skills add owner/repo --skill beta", fetcher)).resolves.toEqual({
      error: "requested skill(s) not found: beta",
    });
  });
});
