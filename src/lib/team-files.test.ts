import { describe, expect, it } from "vitest";

import { buildExportRequest, buildExportScopeOptions, exportFilename } from "./team-files";

describe("team export helpers", () => {
  const bots = [
    { id: "ada", name: "Ada", section: "Engineering" },
    { id: "bea", name: "Bea", section: "Design" },
    { id: "hidden", name: "Hidden", hidden: true },
  ];
  const groups = [{ id: "eng", name: "Engineering room", memberIds: ["ada"], section: "Engineering" }];

  it("builds a project scope with relevant non-DM rooms", () => {
    const options = buildExportScopeOptions({ projectFilter: "Engineering", bots, groups });
    expect(options[0]).toMatchObject({
      key: "project:Engineering",
      scope: { botIds: ["ada"], groupIds: ["eng"] },
    });
  });

  it("keeps all active bots as an explicit final option", () => {
    const options = buildExportScopeOptions({ projectFilter: "all", bots, groups });
    expect(options.map((option) => option.category)).toEqual(["project", "project", "team", "bot", "bot", "other"]);
    expect(options.at(-1)).toMatchObject({ key: "all", category: "other", scope: "all" });
    expect(options.some((option) => option.scope === "all")).toBe(true);
  });

  it("omits empty teams and hidden bots without disturbing the final broad scope", () => {
    const options = buildExportScopeOptions({
      projectFilter: "Missing",
      bots,
      groups: [{ id: "empty", name: "Empty", memberIds: ["hidden"] }, ...groups],
    });
    expect(options.map((option) => option.key)).toEqual(["project:Design", "project:Engineering", "group:eng", "bot:ada", "bot:bea", "all"]);
    expect(options.at(-1)?.key).toBe("all");
    expect(options.some((option) => option.label === "Empty")).toBe(false);
    expect(options.some((option) => option.label === "Hidden")).toBe(false);
  });

  it("builds an exact package request and safe filename", () => {
    expect(buildExportRequest("  Notes Crew ", { botIds: ["ada"], groupIds: [] }, ["notes"])).toEqual({
      name: "Notes Crew",
      scope: { botIds: ["ada"], groupIds: [] },
      skillIds: ["notes"],
      format: "package",
    });
    expect(exportFilename("Résumé / Team 2026")).toBe("resume-team-2026.md");
    expect(exportFilename("  ")).toBe("openmaus-package.md");
  });
});
