import { describe, expect, it } from "vitest";

import { isGrokRecipeFile, teamImportPreview } from "./team-import";

describe("team import preview", () => {
  it("classifies only own-field full Grok recipes for server normalization", () => {
    const recipe = { profile: {}, memory: [], skills: [], routines: [], plugins: [] };
    expect(isGrokRecipeFile(recipe)).toBe(true);
    expect(isGrokRecipeFile(Object.create(recipe))).toBe(false);
    expect(isGrokRecipeFile({ ...recipe, plugins: undefined })).toBe(true);
    expect(isGrokRecipeFile({ format: "openmaus.package", version: 1 })).toBe(false);
  });

  it.each([1, 2])("previews version %s team files", (version) => {
    const preview = teamImportPreview({
      format: "openmaus.team",
      version,
      team: {
        name: " Engineering ",
        description: " Ships software ",
        members: [{ name: " Ada ", title: " Tech Lead " }],
        ...(version === 1
          ? { room: { name: "Engineering", bulletin: "", defaultResponder: { kind: "everyone" } } }
          : {}),
      },
    });

    expect(preview).toMatchObject({
      name: "Engineering",
      description: "Ships software",
      members: [{ name: "Ada", title: "Tech Lead" }],
    });
  });

  it("rejects unsupported and empty files", () => {
    expect(() => teamImportPreview({ format: "openmaus.team", version: 3, team: {} })).toThrow("not supported");
    expect(() =>
      teamImportPreview({ format: "openmaus.team", version: 2, team: { name: "Empty", members: [] } }),
    ).toThrow("no members");
  });

  it("previews the complete package setup before installation", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Lead Desk",
        summary: "Find qualified conversations.",
        agents: [
          { key: "scout", name: "Scout", title: "Researcher" },
          { key: "writer", name: "Writer", title: "Outreach" },
        ],
        chiefOfStaff: "scout",
        rooms: [{ name: "Research", members: ["scout"], bulletin: "Weekly bulletin", defaultResponder: { kind: "agent", agent: "scout" } }],
        playbooks: [{ name: "Source check", summary: "Verify claims", triggers: ["source"], instructions: "Keep citations." }, { name: "Second", summary: "S", triggers: ["s"], instructions: "S" }],
        routines: [{ name: "Weekly review", agent: "scout", prompt: "Review search results", runOn: "maus", schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 30, enabledAfterInstall: false }],
        requirements: {
          apps: [
            { label: "Reddit" },
            { label: "Google Sheets", optional: true },
          ],
        },
      },
    });

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      chiefOfStaff: "Scout",
      rooms: 1,
      playbooks: 2,
      routines: 1,
      skills: 0,
      apps: [
        { label: "Reddit", optional: false },
        { label: "Google Sheets", optional: true },
      ],
    });
    expect(preview.roomEntries[0]).toMatchObject({ name: "Research", members: ["Scout"], defaultResponder: "Scout", bulletin: "Weekly bulletin" });
    expect(preview.playbookEntries[0]).toMatchObject({ name: "Source check", triggers: ["source"], instructions: "Keep citations." });
    expect(preview.routineEntries[0]).toMatchObject({ name: "Weekly review", owner: "Scout", runOn: "maus", status: "Paused after import" });
  });

  it("counts portable package skills in the import preview", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Skillful team",
        agents: [{ key: "writer", name: "Writer", title: "" }],
        skills: { version: 1, entries: [{ id: "notes" }, { id: "research" }] },
      },
    });
    expect(preview.skills).toBe(2);
  });

  it("classifies manual-only package routines without suggesting a schedule", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Manual team",
        agents: [{ key: "reviewer", name: "Reviewer" }],
        routines: [{
          name: "Imported review",
          agent: "reviewer",
          prompt: "Review when asked.",
          runOn: "maus",
          schedule: { type: "manual" },
          durationMinutes: 30,
          enabledAfterInstall: false,
        }],
      },
    });
    expect(preview.routineEntries).toMatchObject([{
      name: "Imported review",
      schedule: "Manual only",
      status: "Paused after import",
    }]);
  });

  it("keeps bounded public identity fields and safe appearance data", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Grok-like bot",
        author: { name: "xAI" },
        agents: [{
          key: "grok",
          name: "Grok",
          title: "Research assistant",
          description: "Answer clearly, challenge assumptions, and show your work.",
          appearance: {
            color: "cyan",
            avatarDefinition: {
              version: 1,
              seed: "grok-bot",
              silhouette: "orb",
              eyeStyle: "calm",
              mouthStyle: "soft",
              expressionPreset: "warm",
              avatarPresetId: "grok-bot",
              restingAnimationId: "idle",
            },
            mascotExpression: "curious",
          },
        }],
      },
    });

    expect(preview).toMatchObject({
      authorName: "xAI",
      members: [{
        description: "Answer clearly, challenge assumptions, and show your work.",
        appearance: {
          color: "cyan",
          mascotExpression: "curious",
          avatarDefinition: { avatarPresetId: "grok-bot" },
        },
      }],
    });
  });

  it("previews all 6219 public instruction characters and rejects the 24000 cap plus one", () => {
    const preview = (description: string) => teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Alfred",
        agents: [{ key: "alfred", name: "Alfred", description }],
      },
    });
    const alfredInstructions = "A".repeat(6_219);
    expect(preview(alfredInstructions).members[0]?.description).toBe(alfredInstructions);
    expect(preview("A".repeat(24_001)).members[0]?.description).toBe("");
  });

  it("falls back when public identity or appearance values exceed client limits", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Bounded bot",
        author: { name: "a".repeat(101) },
        agents: [{
          name: "Bounded",
          title: "a".repeat(201),
          description: "a".repeat(24_001),
          appearance: {
            color: "not-a-color",
            mascotExpression: "a".repeat(81),
            avatarDefinition: {
              version: 1,
              seed: "a".repeat(81),
              silhouette: "<svg>",
              eyeStyle: "calm",
              mouthStyle: "soft",
            },
          },
        }],
      },
    });

    expect(preview.authorName).toBeUndefined();
    expect(preview.members[0]).toMatchObject({ name: "Bounded", title: "", description: "" });
    expect(preview.members[0]?.appearance).toBeUndefined();
  });

  it("previews a portable Markdown playbook", () => {
    const preview = teamImportPreview(`---
botmrr: 1
name: Lead Desk
summary: Find qualified conversations.
agents:
  - key: scout
    name: Scout
    title: Researcher
chiefOfStaff: scout
rooms: []
playbooks: []
routines: []
requirements:
  apps:
    - label: Reddit
---

# Lead Desk

## Activation

Create the team.`);

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      chiefOfStaff: "Scout",
      apps: [{ label: "Reddit", optional: false }],
    });
  });
});
