import { describe, expect, it } from "vitest";

import { clearAcceptedSkill, searchSkills, selectedSkillById, skillsCommandQuery } from "./skills";

const skills = [
  { id: "phone-harness", name: "Phone Harness", description: "Control an Android phone", origin: "built-in" as const },
  { id: "expense", name: "File expense", description: "Submit a reviewed expense", origin: "recorded" as const },
  { id: "review-pr", name: "Review PR", description: "Review pull requests", origin: "imported" as const, source: "org/skills" },
];

describe("skills composer helpers", () => {
  it("recognizes only the local /skills command and keeps its search query", () => {
    expect(skillsCommandQuery("/skills")).toBe("");
    expect(skillsCommandQuery("  /skills phone  ")).toBe("phone");
    expect(skillsCommandQuery("please /skills")).toBeNull();
    expect(skillsCommandQuery("/skill")).toBeNull();
  });

  it("searches stable catalog metadata and resolves one exact selection", () => {
    expect(searchSkills(skills, "recorded expense").map((skill) => skill.id)).toEqual(["expense"]);
    expect(searchSkills(skills, "org review").map((skill) => skill.id)).toEqual(["review-pr"]);
    expect(selectedSkillById(skills, "phone-harness")?.name).toBe("Phone Harness");
    expect(selectedSkillById(skills, "missing")).toBeNull();
  });

  it("clears only the exact skill whose send was accepted", () => {
    expect(clearAcceptedSkill("expense", "expense")).toBeNull();
    expect(clearAcceptedSkill("phone-harness", "expense")).toBe("phone-harness");
    expect(clearAcceptedSkill("expense", undefined)).toBe("expense");
  });
});
