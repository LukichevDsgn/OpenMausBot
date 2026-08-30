import { describe, expect, it } from "vitest";

import { packageAgentAsMember, parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import { BOT_INSTRUCTIONS_MAX_CHARS, importedMemberProfile } from "./team-manifest.ts";

const avatarDefinition = {
  version: 1,
  seed: "package-avatar",
  silhouette: "gem",
  eyeStyle: "calm",
  mouthStyle: "soft",
  expressionPreset: "pondering",
  avatarPresetId: "nova",
  restingAnimationId: "proud",
} as const;

const validPackage: any = {
  format: "openmaus.package",
  version: 1,
  package: {
    id: "research-desk",
    release: "1.0.0",
    name: "Research Desk",
    tagline: "Turn a question into a sourced brief.",
    summary: "A small research team.",
    category: "Research",
    author: { name: "OpenMausBot" },
    license: "MIT",
    outcomes: ["Produce a sourced brief."],
    setupMinutes: 3,
    requirements: { apps: [], capabilities: [] },
    agents: [
      {
        key: "lead",
        name: "Ada",
        title: "Research Lead",
        description: "Own the brief.",
        appearance: { color: "purple", avatarDefinition },
        playbooks: ["source-check"],
        autoApprove: true,
      },
    ],
    chiefOfStaff: "lead",
    rooms: [
      {
        key: "desk",
        name: "Research Desk",
        members: ["lead"],
        bulletin: "Cite sources.",
        defaultResponder: { kind: "agent", agent: "lead" },
      },
    ],
    playbooks: [
      {
        key: "source-check",
        name: "Source Check",
        summary: "Verify sources.",
        triggers: ["research brief"],
        instructions: "Separate facts from inference.",
      },
    ],
  },
};

describe("bot packages", () => {
  it("parses the complete portable structure and strips authority fields", () => {
    const parsed = parseBotPackage(validPackage);
    expect(parsed.package.rooms![0]?.defaultResponder).toEqual({ kind: "agent", agent: "lead" });
    expect(parsed.package.agents[0]).not.toHaveProperty("autoApprove");
    expect(packageAgentAsMember(parsed.package.agents[0]!)).toEqual({
      key: "lead",
      name: "Ada",
      title: "Research Lead",
      description: "Own the brief.",
      appearance: { color: "purple", avatarDefinition },
    });
  });

  it("round-trips one Chief-of-Staff-readable Markdown playbook", () => {
    const markdown = renderBotPackageMarkdown(parseBotPackage(validPackage));
    expect(markdown).toContain("## Activation");
    expect(markdown).toContain("Give this file to your Chief of Staff");
    expect(markdown).not.toContain("autoApprove");
    expect(parseBotPackage(markdown).package).toMatchObject({
      id: "research-desk",
      chiefOfStaff: "lead",
      agents: [{ key: "lead", name: "Ada" }],
    });
    expect(parseBotPackage(markdown).package.agents[0]?.appearance.avatarDefinition).toEqual(avatarDefinition);
  });

  it("keeps legacy packages without a procedural avatar valid", () => {
    const legacy = structuredClone(validPackage);
    delete legacy.package.agents[0].appearance.avatarDefinition;
    expect(parseBotPackage(legacy).package.agents[0]?.appearance).toEqual({ color: "purple" });
  });

  it("round-trips a paused manual-only routine without inventing a schedule", () => {
    const manual = structuredClone(validPackage);
    manual.package.routines = [{
      key: "manual-review",
      name: "Manual review",
      agent: "lead",
      prompt: "Review when asked.",
      runOn: "maus",
      schedule: { type: "manual" },
      durationMinutes: 30,
      enabledAfterInstall: false,
    }];
    const parsed = parseBotPackage(manual);
    expect(parsed.package.routines?.[0]?.schedule).toEqual({ type: "manual" });
    expect(renderBotPackageMarkdown(parsed)).toContain("**Schedule:** manual only");
  });

  it("keeps 6219-character agent instructions and rejects the shared cap plus one", () => {
    const alfredInstructions = "A".repeat(6_219);
    const accepted = structuredClone(validPackage);
    accepted.package.agents[0].description = alfredInstructions;
    expect(parseBotPackage(accepted).package.agents[0]?.description).toBe(alfredInstructions);

    const rejected = structuredClone(validPackage);
    rejected.package.agents[0].description = "A".repeat(BOT_INSTRUCTIONS_MAX_CHARS + 1);
    expect(() => parseBotPackage(rejected)).toThrow("agents.0.description is too long");
  });

  it("carries the package avatar into the exact imported bot profile", () => {
    const agent = parseBotPackage(validPackage).package.agents[0]!;
    const profile = importedMemberProfile(packageAgentAsMember(agent), new Set());
    expect(profile.avatarDefinition).toEqual(avatarDefinition);
  });

  it("rejects an unsupported procedural avatar preset at the package boundary", () => {
    expect(() => parseBotPackage({
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{
          ...validPackage.package.agents[0],
          appearance: {
            ...validPackage.package.agents[0].appearance,
            avatarDefinition: { ...avatarDefinition, silhouette: "raw-svg" },
          },
        }],
      },
    })).toThrow("appearance.avatarDefinition");
  });

  it("rejects dangling agent, room, playbook, chief, and routine references", () => {
    expect(() => parseBotPackage({
      ...validPackage,
      package: { ...validPackage.package, chiefOfStaff: "missing" },
    })).toThrow("Unknown Chief of Staff");
    expect(() => parseBotPackage({
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{ ...validPackage.package.agents[0], playbooks: ["missing"] }],
      },
    })).toThrow("unknown playbook");
  });

  it("round-trips bounded skill dependencies and keeps legacy packages without them valid", () => {
    const portable = structuredClone(validPackage);
    portable.package.agents[0].skillIds = ["research-root"];
    portable.package.skills = {
      version: 1,
      entries: [
        {
          id: "research-root",
          name: "Research root",
          version: "1.0.0",
          description: "Lead research.",
          defaultEnabled: false,
          triggerTerms: ["research"],
          requiredCapabilities: [],
          tools: [],
          dependencies: ["source-check"],
          origin: "recorded",
          instructions: "---\nname: research-root\ndescription: Lead research.\n---\nLead research.",
        },
      ],
    };
    const parsed = parseBotPackage(portable);
    expect(parsed.package.skills?.entries[0]?.dependencies).toEqual(["source-check"]);
    expect(parseBotPackage(renderBotPackageMarkdown(parsed)).package.skills?.entries[0]?.dependencies).toEqual(["source-check"]);

    const duplicate = structuredClone(portable);
    duplicate.package.skills.entries[0].dependencies = ["source-check", "source-check"];
    expect(() => parseBotPackage(duplicate)).toThrow(/Duplicate dependency/);
    const self = structuredClone(portable);
    self.package.skills.entries[0].dependencies = ["research-root"];
    expect(() => parseBotPackage(self)).toThrow(/depend on itself/);
    const tooMany = structuredClone(portable);
    tooMany.package.skills.entries[0].dependencies = Array.from({ length: 9 }, (_, index) => `dep-${index}`);
    expect(() => parseBotPackage(tooMany)).toThrow(/dependencies/);
  });
});
