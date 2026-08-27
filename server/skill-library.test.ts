import { describe, expect, it } from "vitest";

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
    expect(skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone])).toContain("Use phone tools");
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
});
