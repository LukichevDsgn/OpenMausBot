import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";

describe("chiefOfStaffSystemPrompt roster caps", () => {
  it("clips oversized persona fields instead of interpolating them whole", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Atlas" },
        {
          id: "big",
          name: "N".repeat(500),
          title: "T".repeat(500),
          description: "D".repeat(10_000),
        },
      ],
      true,
    );
    // an imported 10KB description must not ride into the Chief's system
    // prompt — the roster line stays bounded
    const rosterLine = prompt.split("\n").find((line) => line.startsWith("- N"))!;
    expect(rosterLine.length).toBeLessThan(500);
    expect(rosterLine).toContain("…");
  });

  it("caps the roster length and says how many were left out", () => {
    const team = Array.from({ length: 60 }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}` }));
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }, ...team], true);
    expect(prompt).toContain("Bot 39");
    expect(prompt).not.toContain("Bot 40 —");
    expect(prompt).toContain("…and 20 more");
  });
});

describe("chiefOfStaffSystemPrompt", () => {
  const bots = [
    { id: "chief", name: "Atlas", title: "Operations" },
    { id: "writer", name: "Quill", title: "Writer", description: "Drafts concise copy" },
    { id: "coder", name: "Patch", title: "Engineer", busy: true },
    { id: "hidden", name: "Secret", hidden: true },
  ];

  it("describes visible teammates, roles, and availability", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(prompt).toContain("one Chief of Staff");
    expect(prompt).toContain("Quill — Writer: Drafts concise copy (available)");
    expect(prompt).toContain("Patch — Engineer (working right now)");
    expect(prompt).not.toContain("Secret");
    expect(prompt).not.toContain("Atlas —");
    expect(prompt).toContain("ask_bot is ONLY");
    expect(prompt).toContain("Use a finite workflow");
    expect(prompt).toContain("Every delegate_bot message MUST");
    expect(prompt).toContain("[OBJECTIVE]");
    expect(prompt).toContain("[ALLOWED FILES]");
    expect(prompt).toContain("never include parent history");
    expect(prompt).toContain("MUST use delegate_bot for architecture");
    expect(prompt).toContain("terminal for automatic coordination");
    expect(prompt).toContain("Stop for new authority");
    expect(prompt).toContain("One evidence-changing retry is the absolute maximum");
    expect(prompt).toContain("Never poll, ping or redelegate an active peer");
    expect(prompt).not.toContain("own the whole loop");
  });

  it("does not promise delegation when the engine cannot mount agent tools", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, false);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("Use ask_bot");
  });
});
