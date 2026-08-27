export interface SearchableSkill {
  id: string;
  name: string;
  description: string;
  origin: "built-in" | "recorded" | "imported";
  source?: string;
}

/** `/skills` is a local composer command, never prompt text. Optional text
 * after it seeds the dialog search. Other slash commands remain untouched. */
export function skillsCommandQuery(text: string): string | null {
  const match = text.match(/^\s*\/skills(?:\s+([^\n]*))?\s*$/iu);
  return match ? (match[1]?.trim() ?? "") : null;
}

export function searchSkills<T extends SearchableSkill>(skills: readonly T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [...skills];
  return skills.filter((skill) => {
    const haystack = [skill.id, skill.name, skill.description, skill.origin, skill.source ?? ""].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function selectedSkillById<T extends { id: string }>(skills: readonly T[], id: string | null): T | null {
  return id ? skills.find((skill) => skill.id === id) ?? null : null;
}

/** A late accepted response may only clear the selection it actually sent. */
export function clearAcceptedSkill(current: string | null, accepted: string | undefined): string | null {
  return accepted && current === accepted ? null : current;
}

export function skillOriginLabel(origin: SearchableSkill["origin"]): string {
  if (origin === "built-in") return "Built in";
  if (origin === "recorded") return "Recorded";
  return "Imported";
}
