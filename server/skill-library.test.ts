import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideBundledSkills,
  effectiveSkillIds,
  effectiveSkillToolIds,
  filterSkillGrantState,
  parseSkillManifest,
  skillInstructionsFor,
  validateSkillGrantPatch,
  type BundledSkill,
} from "./skill-library.ts";
import { loadUserSkills, mergeSkills } from "./skill-library.ts";

const phone: BundledSkill = {
  directory: "/skills/phone-harness",
  instructions: "---\nname: phone-harness\ndescription: test\n---\nUse phone tools.",
  manifest: {
    id: "phone-harness",
    name: "Phone Harness",
    version: "0.1.0",
    description: "Control a phone",
    defaultEnabled: true,
    triggerTerms: ["android", "phone"],
    requiredCapabilities: ["phoneMcp"],
    tools: ["phone"],
  },
};

describe("bundled skill library", () => {
  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone]);
    expect(rendered).toContain("Use phone tools");
    expect(rendered).not.toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone], { includeRoot: true }))
      .toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", [], [phone])).toBe("");
    expect(skillInstructionsFor("Write a poem", ["phoneMcp"], [phone])).toBe("");
  });

  it("keeps defaults, explicit skill deny, explicit tool deny, and stale ids deterministic", () => {
    expect(effectiveSkillIds([phone])).toEqual(["phone-harness"]);
    expect(effectiveSkillToolIds([phone])).toEqual(["phone"]);
    expect(effectiveSkillIds([phone], { skillGrants: [] })).toEqual([]);
    expect(effectiveSkillToolIds([phone], { skillGrants: [], skillToolGrants: undefined })).toEqual([]);
    expect(filterSkillGrantState({ skillGrants: ["stale", "phone-harness"], skillToolGrants: ["stale", "phone"] }, [phone])).toEqual({
      skillGrants: ["phone-harness"],
      skillToolGrants: ["phone"],
    });
  });

  it("reports each gate and never mounts a declared tool without its grant", () => {
    expect(decideBundledSkills("Open my Android", ["phoneMcp"], [phone]).mountedSkillToolIds).toEqual(["phone"]);
    expect(decideBundledSkills("Open my Android", ["phoneMcp"], [phone], { skillGrants: [] }).decisions[0]).toMatchObject({
      reason: "skill-denied",
    });
    expect(decideBundledSkills("Open my Android", ["phoneMcp"], [phone], {
      skillGrants: ["phone-harness"],
      skillToolGrants: [],
    })).toMatchObject({ mountedSkillToolIds: [], decisions: [{ reason: "tool-denied" }] });
    expect(decideBundledSkills("Open my Android", [], [phone]).decisions[0]).toMatchObject({
      reason: "capability-missing",
    });
    expect(decideBundledSkills("Write a poem", ["phoneMcp"], [phone]).decisions[0]).toMatchObject({
      reason: "trigger-mismatch",
    });
  });

  it("validates and sorts new grant ids while rejecting unknown ids", () => {
    expect(validateSkillGrantPatch({ skillGrants: ["phone-harness", "phone-harness"], skillToolGrants: ["phone"] }, [phone])).toEqual({
      skillGrants: ["phone-harness"],
      skillToolGrants: ["phone"],
    });
    expect(validateSkillGrantPatch({ skillGrants: [] }, [phone])).toEqual({ skillGrants: [] });
    expect(() => validateSkillGrantPatch({ skillGrants: ["unknown"] }, [phone])).toThrow(/unknown id/);
    expect(() => validateSkillGrantPatch({ skillToolGrants: ["unknown"] }, [phone])).toThrow(/unknown id/);
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...phone.manifest,
      id: "other-skill",
    }, "/skills/phone-harness")).toThrow(/invalid id/);
  });

  it("requires a validated tool declaration", () => {
    expect(() => parseSkillManifest({ ...phone.manifest, tools: ["bad tool"] }, "/skills/phone-harness")).toThrow(/invalid tools/);
    expect(() => parseSkillManifest({ ...phone.manifest, tools: undefined }, "/skills/phone-harness")).toThrow(/invalid tools/);
  });

  it("loads a recorded skill without letting a broken sibling disable it", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-skills-"));
    const valid = join(root, "file-expense");
    mkdirSync(valid);
    writeFileSync(join(valid, "manifest.json"), JSON.stringify({
      id: "file-expense", name: "File expense", version: "1.0.0", description: "File expenses",
      defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [],
    }));
    writeFileSync(join(valid, "SKILL.md"), "---\nname: file-expense\ndescription: File expenses\n---\nDo it safely.\n");
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "manifest.json"), "not json");
    writeFileSync(join(broken, "SKILL.md"), "broken");

    expect(loadUserSkills(root).map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
  });

  it("does not let a user skill shadow a bundled skill id", () => {
    expect(mergeSkills([phone], [{ ...phone, instructions: "user replacement" }])).toEqual([phone]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});
