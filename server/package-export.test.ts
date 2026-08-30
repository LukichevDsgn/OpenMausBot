import { describe, expect, it } from "vitest";

import { createBotPackageExport } from "./package-export.ts";
import type { BotRecord } from "./store.ts";
import type { BundledSkill } from "./skill-library.ts";

describe("package export", () => {
  it("keeps collaboration structure while excluding runtime authority and state", () => {
    const exported = createBotPackageExport({
      name: "Launch Crew",
      authorName: "Mira",
      bots: [
        {
          id: "private-id",
          threadId: "private-thread",
          name: "Lead",
          title: "Chief",
          description: "Coordinates",
          notifications: true,
          color: "purple",
          avatarDefinition: {
            version: 1,
            seed: "export-avatar",
            silhouette: "spark",
            eyeStyle: "wide",
            mouthStyle: "none",
          },
          unread: false,
          modelSelection: { instanceId: "private-engine", model: "secret-model", effort: "medium" },
          resumeCursors: { provider: "secret-session" },
          chiefOfStaff: true,
          composio: true,
          cwd: "/private/path",
          autoApprove: true,
          alwaysAllow: ["everything"],
          installedPackage: {
            id: "source",
            name: "Source",
            release: "1.0.0",
            requiredApps: [{ slug: "github", label: "GitHub", reason: "Read repositories.", optional: true }],
          },
          playbooks: [{ key: "launch", name: "Launch", summary: "Ship", triggers: ["launch plan"], instructions: "Verify the release." }],
          createdAt: 1,
        },
      ],
      groups: [{
        id: "private-room-id",
        threadId: "private-room-thread",
        name: "Launch Room",
        memberIds: ["private-id"],
        defaultResponder: { kind: "member", botId: "private-id" },
        bulletin: "Ship carefully.",
        unread: false,
        createdAt: 1,
      }],
      routines: [{
        id: "private-routine-id",
        name: "Release check",
        prompt: "Verify release readiness.",
        botId: "private-id",
        runOn: "maus",
        enabled: true,
        schedule: { type: "daily", time: "09:00", weekdays: [1] },
        durationMinutes: 30,
        nextRunAt: 123,
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    expect(exported).toMatchObject({
      format: "openmaus.package",
      package: {
        chiefOfStaff: "lead",
        requirements: { apps: [{ slug: "github" }] },
        rooms: [{ members: ["lead"], defaultResponder: { kind: "agent", agent: "lead" } }],
        routines: [{ agent: "lead", enabledAfterInstall: false }],
        playbooks: [{ key: "launch" }],
        agents: [{
          appearance: {
            avatarDefinition: {
              version: 1,
              seed: "export-avatar",
              silhouette: "spark",
              eyeStyle: "wide",
              mouthStyle: "none",
            },
          },
        }],
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(/private-id|private-thread|private-engine|secret-model|secret-session|private\/path|autoApprove|alwaysAllow|nextRunAt/);
  });

  it("shares one identical playbook definition across multiple bots", () => {
    const sharedPlaybook = {
      key: "qualify",
      name: "Qualify",
      summary: "Check fit",
      triggers: ["qualify lead"],
      instructions: "Check the lead against the stated criteria.",
    };
    const bot = (id: string, name: string): BotRecord => ({
      id,
      threadId: `thread-${id}`,
      name,
      title: "Researcher",
      description: "Researches leads",
      notifications: true,
      color: "green" as const,
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      playbooks: [sharedPlaybook],
      createdAt: 1,
    });

    const exported = createBotPackageExport({
      name: "Lead Crew",
      bots: [bot("one", "Scout"), bot("two", "Reviewer")],
      groups: [],
      routines: [],
    });

    expect(exported.package.playbooks).toHaveLength(1);
    expect(exported.package.agents.map((agent) => agent.playbooks)).toEqual([
      ["qualify"],
      ["qualify"],
    ]);
  });

  it("exports a manual-only routine as manual and paused", () => {
    const bot = {
      id: "manual-bot",
      threadId: "private-thread",
      name: "Manual Bot",
      title: "Reviewer",
      description: "Reviews on request.",
      notifications: true,
      color: "green" as const,
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" as const },
      resumeCursors: {},
      createdAt: 1,
    };
    const exported = createBotPackageExport({
      name: "Manual package",
      bots: [bot],
      groups: [],
      routines: [{
        id: "private-routine",
        name: "Review",
        prompt: "Review now.",
        botId: bot.id,
        runOn: "maus",
        enabled: false,
        schedule: { type: "manual" },
        durationMinutes: 30,
        nextRunAt: null,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    expect(exported.package.routines).toMatchObject([{
      schedule: { type: "manual" },
      enabledAfterInstall: false,
    }]);
  });

  it("exports only explicitly selected granted skills with portable markdown and no runtime state", () => {
    const skill: BundledSkill = {
      directory: "C:/app-wide/skills/portable-notes",
      origin: "recorded",
      metadata: { source: "github.com/example/portable-notes", importedAt: "2026-08-28T00:00:00.000Z" },
      manifest: {
        id: "portable-notes",
        name: "Portable Notes",
        version: "1.2.3",
        description: "Keep notes structured.",
        defaultEnabled: false,
        triggerTerms: ["notes"],
        requiredCapabilities: ["research"],
        tools: ["notes"],
      },
      instructions: "---\nname: portable-notes\ndescription: Keep notes structured.\n---\nWrite concise notes.",
    };
    const bot = (id: string, name: string, skillGrants?: string[]): BotRecord => ({
      id,
      threadId: `thread-${id}`,
      name,
      title: "Worker",
      description: "Works",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      ...(skillGrants ? { skillGrants } : {}),
      createdAt: 1,
    });
    const exported = createBotPackageExport({
      name: "Notes Crew",
      bots: [bot("one", "Writer", ["portable-notes"]), bot("two", "Other")],
      groups: [],
      routines: [],
      skillIds: ["portable-notes"],
      skills: [skill],
    });
    expect(exported.package.skills).toMatchObject({
      version: 1,
      entries: [{ id: "portable-notes", origin: "recorded", tools: ["notes"], requiredCapabilities: ["research"], instructions: skill.instructions }],
    });
    expect(exported.package.agents.map((agent) => agent.skillIds)).toEqual([["portable-notes"], undefined]);
    expect(JSON.stringify(exported)).not.toMatch(/C:\\app-wide|scripts|references|credentials|permission|absolute/);
    expect(() => createBotPackageExport({
      name: "Bad selection",
      bots: [bot("one", "Writer", ["portable-notes"])],
      groups: [],
      routines: [],
      skillIds: ["missing"],
      skills: [skill],
    })).toThrow(/Unknown skill id/);
  });

  it("preserves a selected skill dependency in the portable package", () => {
    const root: BundledSkill = {
      directory: "C:/app-wide/skills/research-root",
      origin: "recorded",
      manifest: {
        id: "research-root",
        name: "Research root",
        version: "1.0.0",
        description: "Lead research.",
        defaultEnabled: false,
        triggerTerms: ["research"],
        requiredCapabilities: [],
        tools: [],
        dependencies: ["source-check"],
      },
      instructions: "---\nname: research-root\ndescription: Lead research.\n---\nLead research.",
    };
    const bot: BotRecord = {
      id: "root-bot",
      threadId: "thread-root-bot",
      name: "Researcher",
      title: "Researcher",
      description: "Researches.",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      skillGrants: ["research-root"],
      createdAt: 1,
    };
    const exported = createBotPackageExport({
      name: "Research package",
      bots: [bot],
      groups: [],
      routines: [],
      skillIds: ["research-root"],
      skills: [root, { ...root, manifest: { ...root.manifest, id: "source-check", name: "Source check", dependencies: [] } }],
    });
    expect(exported.package.skills?.entries).toEqual([
      expect.objectContaining({ id: "research-root", dependencies: ["source-check"] }),
    ]);
  });
});
