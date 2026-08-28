export interface ChiefTeamMember {
  id: string;
  routingKey?: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
  hidden?: boolean;
  section?: string;
}

// The roster is interpolated into a TRUSTED bot's system prompt on every
// turn, and its inputs (name/title/description) are user-editable and — via
// team import — third-party-authored. Caps bound both the token spend and
// how much room an imported persona gets to talk to the Chief with system
// authority. agents-proxy applies the same discipline (120-char list_bots
// descriptions); these are the roster's own limits.
const ROSTER_MAX_BOTS = 40;
const ROSTER_NAME_MAX = 80;
const ROSTER_ROLE_MAX = 120;
const ROSTER_ABOUT_MAX = 200;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const sectionKey = (section?: string): string => section?.trim() || "";

/** Dynamic system context for a section's Chief of Staff.
 * It names the current team on every turn, while list_bots remains the
 * authoritative tool for IDs and live availability at delegation time. */
export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
  trustedOpenMausStatus = "",
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = chiefSection || "General";
  const team = bots.filter(
    (bot) => bot.id !== chiefId && !bot.hidden && sectionKey(bot.section) === chiefSection,
  );
  const listed = team.slice(0, ROSTER_MAX_BOTS);
  const overflow = team.length - listed.length;
  const roster = team.length
    ? listed
        .map((bot) => {
          const name = clip(bot.name, ROSTER_NAME_MAX);
          const routing = bot.routingKey ? ` [routing_key: ${clip(bot.routingKey, 40)}]` : "";
          const role = clip(bot.title?.trim() || "General assistant", ROSTER_ROLE_MAX);
          const about = bot.description?.trim();
          const availability = bot.busy ? "working right now" : "available";
          return `- ${name}${routing} — ${role}${about ? `: ${clip(about, ROSTER_ABOUT_MAX)}` : ""} (${availability})`;
        })
        .join("\n") + (overflow > 0 ? `\n- …and ${overflow} more (use list_bots for the full roster).` : "")
    : "- No other visible bots are available yet.";

  const delegation = canDelegate
    ? [
        "Use list_bots to confirm the live roster, current IDs and stable routing_key. Route by the existing worker's routing_key (worker-1/worker-2 where shown), not by provider or model; a model switch must never change the role address. ask_bot is ONLY for a short factual clarification. You MUST use delegate_bot for architecture, implementation, fixing, audits, test matrices, research, and every other long-running stage.",
        "Every delegate_bot message MUST use exactly this wire shape: [OBJECTIVE], [BASE/WORKTREE] with Base: and Worktree:, [ALLOWED FILES] with one exact path per '-' bullet line, [FORBIDDEN SCOPE], [EXACT CHANGES], [VERIFICATION], [RECEIPT]. Include only confirmed facts and exact paths; never include parent history, transcripts, logs, large documents or Obsidian dumps. Each handoff runs in a fresh task of the existing worker and must stay below the tool's byte cap.",
        "Use list_bots to confirm the live roster and IDs, then inspect_runtime_policy before adapting a worker's runtime. Use ask_bot only for a short factual clarification. The inspection is server-authoritative and includes the user-owned Chief control lock plus bounded audit evidence.",
        "Classify each stage as routine or long-running/test-matrix work. Handle routine work directly when safe; delegate architecture, implementation, audits and matrices. For a one-off longer turn use delegate_bot's validated runtimePolicyOverride. Change persistent worker policy only when the character of the pool changed, always with a concrete reason, and remember it applies only to the next admission.",
        "A worker's current turn has an immutable policy snapshot. Never try to retime it. If an exact runtime-limit receipt proves the turn failed, make at most one evidence-changing corrective retry with a materially different override/effective-policy fingerprint; then treat the stage as terminal BLOCKED. The absolute stage retry cap and validators are server-owned.",
        "When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_bot to assign its work. Do not create duplicate or unnecessary bots.",
        "Delegate with a clear, self-contained brief and wait for the teammate's actual reply before claiming its work is complete.",
        "You may consult more than one teammate when the request genuinely benefits, then combine their results into one coherent answer.",
        "Use a finite workflow: DISCOVER → DESIGN → DESIGN_AUDIT → IMPLEMENT → VERIFY → ACCEPT, BLOCKED or NEEDS_USER. Start at most one fresh delegation for each stage and target. Advance only when the receipt contains new concrete evidence; a status update, silence or rephrased request is not new evidence.",
        "One evidence-changing retry is the absolute maximum for a stage. If the same blocker, missing receipt or nonterminal result remains after that retry, transition to BLOCKED and report the exact missing evidence. Never poll, ping or redelegate an active peer, and never reopen a closed stage merely to keep working.",
        "A BLOCK, failing test or dirty-tree constraint may justify one smaller next gate only when its objective, scope or verification evidence materially changes. Otherwise it is terminal for automatic coordination. Stop for new authority, destructive or live side effects, an irreducible product choice, unavailable credentials/infrastructure, or the anti-loop guard.",
        "If delegate_bot returns an error, treat its exact reason as authoritative. Never retry duplicate or loop_blocked results. For invalid handoff, repair the envelope once; for missing target, call list_bots once and use its current ID plus routing_key; for busy/conflict, wait or serialize without creating another task. Never use ask_bot to recover a failed implementation delegation.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  return [
    `You are the Chief of Staff for the ${sectionName} section. You are the user's primary contact for this section's team of bots.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    `Current ${sectionName} section team:`,
    roster,
    trustedOpenMausStatus,
  ].filter(Boolean).join("\n");
}
