// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes the base coordination
// tools plus two Chief-only runtime-policy tools and routine proposal tools that
// let one bot talk to another, routed back through the harness so the
// harness stays the single owner of turns, permissions, and recursion
// limits:
//
//   list_bots()                          → the other bots in this section + their status
//   ask_bot(bot_id, msg)                 → send msg to that bot, wait, return its reply
//   delegate_bot(bot_id, msg, reason?, runtimePolicyOverride?) → hand the task to a peer ASYNC
//                                          immediately, the peer runs after your
//                                          current turn finishes, the user sees
//                                          the peer's reply as its own turn
//   create_bot(name, role, instructions) → Chiefs can add a specialist to
//                                          their own section
//   request_credential(id, reason?)       → show a secure, allowlisted key card
//   list_routines()                       → inspect this bot's scheduled work
//   propose_routine(...)                  → show a confirmation card for a new routine
//   propose_routine_action(...)           → show a confirmation card for a routine change
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
import readline from "node:readline";

import { CREDENTIAL_TARGETS, isCredentialTargetId } from "../../shared/credential-request.ts";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const DEPTH = Number(process.env.OMB_TURN_DEPTH ?? "0") || 0;
const MAX_CREATED_PER_TURN = 4;
let createdThisTurn = 0;

function boundedEnvInteger(name: string, min: number, max: number, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

// These values are copied from the server-owned admission snapshot. The
// defaults keep a proxy launched in isolation compatible with the legacy
// coordination contract, but the backend remains the final authority.
const RETRY_CAP = boundedEnvInteger("OMB_RETRY_CAP", 0, 1, 1);
const DELEGATION_CONCURRENCY = boundedEnvInteger("OMB_DELEGATION_CONCURRENCY", 1, 4, 4);
const HANDOFF_BYTE_CAP = boundedEnvInteger("OMB_HANDOFF_BYTE_CAP", 1_024, 12_000, 12_000);
const IS_CHIEF_OF_STAFF = process.env.OMB_CHIEF_OF_STAFF === "1";
const RETRY_GUIDANCE = RETRY_CAP === 0
  ? "No automatic evidence-changing retry is available."
  : `Up to ${RETRY_CAP} evidence-changing automatic retry is available.`;
const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// One flat object, deliberately free of oneOf/const/format: several agent
// CLIs flatten or drop JSON-Schema composition keywords when converting MCP
// tools into their provider's function-call format. Per-type rules live in
// descriptions and are enforced with guiding errors below.
const ROUTINE_SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    'Either {"type":"once","at":RFC3339} for one future run, {"type":"weekly","time":"HH:MM","weekdays":[...]} for chosen days, or {"type":"daily","time":"HH:MM"} to run every day. Sub-day intervals (every N minutes/hours) are not supported.',
  properties: {
    type: {
      type: "string",
      enum: ["once", "weekly", "daily"],
      description: "once = a single future run; weekly = chosen weekdays; daily = every day of the week.",
    },
    at: {
      type: "string",
      description:
        "Only for type once: future RFC3339 date-time with an explicit timezone offset, for example 2026-09-01T09:00:00+05:30 or 2026-09-01T03:30:00Z.",
    },
    time: {
      type: "string",
      description: "For type weekly or daily: local computer time in 24-hour HH:MM format, for example 09:00.",
    },
    weekdays: {
      type: "array",
      items: { type: "string", enum: WEEKDAYS },
      description: "Only for type weekly: which days the routine runs, in the computer's local timezone.",
    },
  },
  required: ["type"],
} as const;

const SHORT_WEEKDAYS = {
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
} as const satisfies Record<string, (typeof WEEKDAYS)[number]>;

const SUPPORTED_SCHEDULES =
  'Supported schedules: {"type":"once","at":"2026-09-01T09:00:00+05:30"} (future RFC3339 with explicit offset), ' +
  '{"type":"weekly","time":"09:00","weekdays":["monday","friday"]}, or {"type":"daily","time":"09:00"} for every day.';

interface NormalizedSchedule {
  schedule?: Json;
  error?: string;
}

/** Coerce obvious model variants before rejecting the schedule. */
function normalizeScheduleInput(args: Json): NormalizedSchedule {
  let raw = args.schedule;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: `The schedule must be a JSON object, not text. ${SUPPORTED_SCHEDULES}` };
    }
  }
  if (!jsonRecord(raw)) return { error: `The schedule must be a JSON object. ${SUPPORTED_SCHEDULES}` };
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  if (type === "once") {
    if (typeof raw.at !== "string" || !raw.at.trim()) {
      return { error: `A once schedule needs "at": a future RFC3339 date-time with an explicit offset, for example 2026-09-01T09:00:00+05:30.` };
    }
    return { schedule: { type: "once", at: raw.at.trim() } };
  }
  if (type === "weekly" || type === "daily") {
    const time = typeof raw.time === "string" ? raw.time.trim() : "";
    if (!time) return { error: `A ${type} schedule needs "time" in 24-hour HH:MM, for example 09:00.` };
    let weekdays: unknown[];
    if (type === "daily") {
      weekdays = Array.isArray(raw.weekdays) && raw.weekdays.length ? raw.weekdays : [...WEEKDAYS];
    } else {
      if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
        return { error: `A weekly schedule needs "weekdays", for example ["monday","friday"] — or use {"type":"daily"} to run every day.` };
      }
      weekdays = raw.weekdays;
    }
    const normalized: string[] = [];
    for (const day of weekdays) {
      const lower = String(day).trim().toLowerCase();
      const full = (WEEKDAYS as readonly string[]).includes(lower)
        ? lower
        : Object.hasOwn(SHORT_WEEKDAYS, lower)
          ? SHORT_WEEKDAYS[lower as keyof typeof SHORT_WEEKDAYS]
          : undefined;
      if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
      if (!normalized.includes(full)) normalized.push(full);
    }
    return { schedule: { type: "weekly", time, weekdays: normalized } };
  }
  if (type === "interval" || type === "cron" || type === "hourly" || type === "minutes") {
    return { error: `Routines cannot run on sub-day intervals. ${SUPPORTED_SCHEDULES} Pick the closest daily or weekly time and tell the user about this limit.` };
  }
  return { error: `Unknown schedule type "${type || "(missing)"}". ${SUPPORTED_SCHEDULES}` };
}

const ROUTINE_FIELDS_SCHEMA = {
  name: { type: "string", minLength: 1, maxLength: 80, description: "Short name shown in Routines." },
  instructions: {
    type: "string",
    minLength: 1,
    maxLength: 20_000,
    description: "The complete instructions the bot should follow each time the routine runs.",
  },
  schedule: ROUTINE_SCHEDULE_SCHEMA,
  run_on: {
    type: "string",
    enum: ["maus", "cloud"],
    description: "Where the routine runs. Defaults to maus (this OpenMausBot setup).",
  },
  duration_minutes: {
    type: "integer",
    minimum: 15,
    maximum: 240,
    description: "Maximum run duration in minutes. Defaults to 30.",
  },
} as const;

const TOOLS = [
  {
    name: "list_bots",
    description:
      "List the other visible bots in your OpenMausBot section with their model and busy state. When you are Chief of Staff, this also includes effective runtime policy and whether the user locked Chief control. Call this before coordinating.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_bot",
    description:
      "Send one bounded QUESTION to another bot in your section and wait for its reply. Do NOT use ask_bot for architecture, implementation, fixing, audit, test matrices, or any other long-running workflow stage; use delegate_bot for those. ask_bot is only for a short factual clarification whose answer completes inside one peer turn. The other bot runs a full turn under its own model and permissions; the reply is returned as text. Returns promptly with a note if that bot is busy.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        routing_key: { type: "string", description: "Stable role address from list_bots, e.g. worker-1; use it if an old bot id is rejected." },
        bot_name: { type: "string", description: "Exact target display name, only for compatibility with an older roster." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "delegate_bot",
    description:
      `Hand one long-running stage to an existing bot in a fresh task. The message MUST be a compact handoff with exactly these headings: [OBJECTIVE], [BASE/WORKTREE] containing Base:, Worktree: and optional Access mode: read-only|writer, [ALLOWED FILES] with bullet-listed exact files, [FORBIDDEN SCOPE], [EXACT CHANGES], [VERIFICATION], [RECEIPT]. Omitted access mode keeps legacy writer semantics. Maximum ${HANDOFF_BYTE_CAP} UTF-8 bytes for this turn. Never include parent history, transcripts, logs or large documents. The peer runs after your current turn and the coordinator resumes with its result. Identical stage/evidence replay is rejected. A read-only label is not a sandbox: use a different worktree for concurrent readers. ${RETRY_GUIDANCE} Queue/fan-out is capped at ${DELEGATION_CONCURRENCY} successful delegations from this turn. Backend enforcement owns these limits.`,
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        routing_key: { type: "string", description: "Stable role address from list_bots, e.g. worker-1; use it if an old bot id is rejected." },
        bot_name: { type: "string", description: "Exact target display name, only for compatibility with an older roster." },
        message: { type: "string", description: `Seven-section handoff, at most ${HANDOFF_BYTE_CAP} UTF-8 bytes.` },
        reason: { type: "string", description: "Optional one-line reason for the delegation (shown to the user as a chip)." },
        runtimePolicyOverride: {
          type: "object",
          description: "Chief-only validated one-task runtime exception. It applies only to this fresh task, never changes bot defaults, and is refused when the user locked Chief control.",
          additionalProperties: true,
        },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "inspect_runtime_policy",
    description: "Chief-only server-authoritative view of visible workers in your section: effective policy, busy state, user lock, and bounded policy audit. Use it before adapting limits.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "patch_runtime_policy",
    description: "Chief-only persistent patch for one visible worker in your section. Requires a concrete reason, never changes the active turn, and applies only at the next admission. Use a delegate task override for a one-off exception; use this only when the pool's task character changed. The user's lock is authoritative.",
    inputSchema: {
      type: "object",
      properties: {
        target_bot_id: { type: "string", description: "Visible worker id from list_bots or inspect_runtime_policy." },
        runtimePolicy: { type: ["object", "null"], description: "Validated partial policy patch, or null to reset the worker to defaults." },
        reason: { type: "string", description: "Concrete non-sensitive reason for changing future admissions." },
      },
      required: ["target_bot_id", "runtimePolicy", "reason"],
    },
  },
  {
    name: "create_bot",
    description:
      "Create a specialist bot in your section. Only a section's Chief of Staff may use this. The new bot inherits the Chief's engine, starts with connected apps and automatic approvals disabled, and can then receive work through delegate_bot. Create only the smallest useful team (maximum four per turn).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short, unique display name for the specialist." },
        role: { type: "string", description: "The specialist's job title or role." },
        instructions: { type: "string", description: "What this specialist is responsible for and how it should work." },
      },
      required: ["name", "role", "instructions"],
    },
  },
  {
    name: "request_credential",
    description:
      "Ask the user for a supported API key through OpenMausBot's secure credential card. Use this instead of asking them to paste a secret into chat. The secret is saved by the desktop app and is never returned to you. After calling this tool, end the turn; OpenMausBot resumes the task after the user saves or declines.",
    inputSchema: {
      type: "object",
      properties: {
        credential_id: {
          type: "string",
          enum: Object.keys(CREDENTIAL_TARGETS),
          description: "The credential the current task requires.",
        },
        reason: {
          type: "string",
          description: "Optional short, non-sensitive explanation of why the task needs it.",
        },
      },
      required: ["credential_id"],
    },
  },
  {
    name: "list_routines",
    description:
      "List routines owned by this bot, including their ids, schedules, status, and next run. The result includes the computer's authoritative current time and timezone; use those when interpreting relative dates. Only call this when the user asks about routines or wants to change one.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "propose_routine",
    description:
      "Prepare a new routine after the user explicitly asks to schedule recurring or future work. Call list_routines first for relative dates or times so you use its authoritative current time and timezone. This only creates a durable confirmation card; it does NOT enable the routine. Resolve ambiguous dates, times, timezone, destination, or instructions with the user first, and always give one-time schedules an explicit RFC3339 offset. After calling it, end the turn and do not claim the routine exists until the user confirms the card.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: ROUTINE_FIELDS_SCHEMA,
      required: ["name", "instructions", "schedule"],
    },
  },
  {
    name: "propose_routine_action",
    description:
      "Prepare a user-requested change to one of this bot's existing routines. This only creates a durable confirmation card; it does NOT apply the change. Use list_routines first to get the routine id. After calling it, end the turn and do not claim the action completed until the user confirms the card.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        routine_id: { type: "string", minLength: 1, description: "Routine id from list_routines." },
        action: {
          type: "string",
          enum: ["update", "pause", "resume", "run_now", "delete"],
          description: "The requested action. Supply changes only for update.",
        },
        changes: {
          type: "object",
          additionalProperties: false,
          properties: ROUTINE_FIELDS_SCHEMA,
          description: "Fields to change when action is update. Omit for every other action.",
        },
      },
      required: ["routine_id", "action"],
    },
  },
];

type Json = Record<string, unknown>;
type RoutineAction = "update" | "pause" | "resume" | "run_now" | "delete";

const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

// A model sometimes retries an identical failed tool call before it has
// incorporated the error. Keep that loop local to this provider turn: the
// second identical refusal must tell it to rebuild the call, not spend more
// tokens on another HTTP round trip.
const rejectedDelegations = new Set<string>();

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(HARNESS + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

function jsonRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function routineAction(value: unknown): RoutineAction | null {
  return value === "update" || value === "pause" || value === "resume" || value === "run_now" || value === "delete"
    ? value
    : null;
}

function routineFields(args: Json): { fields: Json; error?: string } {
  const fields: Json = {};
  if (typeof args.name === "string") fields.name = args.name.trim();
  if (typeof args.instructions === "string") fields.instructions = args.instructions.trim();
  if (args.schedule !== undefined && args.schedule !== null) {
    const normalized = normalizeScheduleInput(args);
    if (normalized.error) return { fields, error: normalized.error };
    fields.schedule = normalized.schedule;
  }
  if (typeof args.run_on === "string") fields.runOn = args.run_on;
  if (typeof args.duration_minutes === "number") fields.durationMinutes = args.duration_minutes;
  return { fields };
}

function confirmationResult(r: Json, fallback: string): { text: string } {
  const summary = typeof r.summary === "string" && r.summary.trim() ? `\n\n${r.summary.trim()}` : "";
  return {
    text: `A confirmation card is now visible to the user for ${fallback}.${summary}\n\nThis change has not been applied yet. End this turn and wait for the user to confirm or deny the card; do not claim the routine was created or changed before confirmation.`,
  };
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (!IS_CHIEF_OF_STAFF && (name === "inspect_runtime_policy" || name === "patch_runtime_policy")) {
    return { text: "only a visible section Chief of Staff can use runtime-policy tools", isError: true };
  }
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots in this section yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      const routing = b.routingKey ? `, routing_key: ${b.routingKey}` : "";
      const policy = IS_CHIEF_OF_STAFF && b.runtimePolicy
        ? `, policy lock: ${b.chiefRuntimePolicyLocked ? "locked" : "allowed"}`
        : "";
      return `- ${b.name}${role}${about} [id: ${b.id}${routing}, model: ${b.model}${b.busy ? ", busy" : ""}${policy}]`;
    });
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
  }
  if (name === "inspect_runtime_policy") {
    const r = await api(`/api/internal/runtime-policy?fromBotId=${encodeURIComponent(BOT_ID)}&fromThreadId=${encodeURIComponent(THREAD_ID)}`);
    const workers = (r.workers as Array<Json>) ?? [];
    if (!workers.length) return { text: "No visible workers in this section." };
    return {
      text: workers.map((worker) => `- ${worker.name} [id: ${worker.id}${worker.routingKey ? `, routing_key: ${worker.routingKey}` : ""}, ${worker.busy ? "busy" : "idle"}, Chief control: ${worker.chiefRuntimePolicyLocked ? "Locked" : "Allowed"}] policy=${JSON.stringify(worker.runtimePolicy)}${Array.isArray(worker.audit) && worker.audit.length ? ` audit=${JSON.stringify(worker.audit)}` : ""}`).join("\n"),
    };
  }
  if (name === "patch_runtime_policy") {
    const targetBotId = String(args.target_bot_id ?? "").trim();
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!targetBotId || !reason || !Object.prototype.hasOwnProperty.call(args, "runtimePolicy")) {
      return { text: "patch_runtime_policy needs target_bot_id, runtimePolicy, and reason.", isError: true };
    }
    const r = await api("/api/internal/runtime-policy", {
      method: "PATCH",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        targetBotId,
        runtimePolicy: args.runtimePolicy,
        reason,
      }),
    });
    return { text: `Runtime policy for ${targetBotId} patched for the next admission. Active turn unaffected: ${Boolean(r.activeTurnUnaffected)}. Audit: ${JSON.stringify(r.audit)}` };
  }
  if (name === "ask_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const routingKey = typeof args.routing_key === "string" ? args.routing_key.trim() : "";
    const botName = typeof args.bot_name === "string" ? args.bot_name.trim() : "";
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      toBotId,
      message,
      depth: DEPTH,
    };
    if (routingKey) body.toRoutingKey = routingKey;
    if (botName) body.toBotName = botName;
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (r.busy) return { text: `That bot is busy right now — try again after it finishes.` };
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "delegate_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const routingKey = typeof args.routing_key === "string" ? args.routing_key.trim() : "";
    const botName = typeof args.bot_name === "string" ? args.bot_name.trim() : "";
    const message = String(args.message ?? "").trim();
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!toBotId || !message) return { text: "delegate_bot needs bot_id and message.", isError: true };
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      toBotId,
      message,
      depth: DEPTH,
    };
    if (routingKey) body.toRoutingKey = routingKey;
    if (botName) body.toBotName = botName;
    if (reason) body.reason = reason;
    if (Object.prototype.hasOwnProperty.call(args, "runtimePolicyOverride")) {
      body.runtimePolicyOverride = args.runtimePolicyOverride;
    }
    const r = await api(`/api/internal/delegate-bot`, { method: "POST", body: JSON.stringify(body) });
    if (r.error) {
      const failureKey = `${toBotId}\n${routingKey}\n${botName}\n${message}`;
      const repeated = rejectedDelegations.has(failureKey);
      rejectedDelegations.add(failureKey);
      const terminalLoop = /same workflow stage|bounded retry/iu.test(String(r.error));
      const guidance = terminalLoop
        ? " This workflow stage is terminal for automatic coordination; report BLOCKED instead of retrying or rephrasing it."
        : repeated
          ? " Do not retry this identical call; rebuild the handoff only if its objective, scope or verification evidence materially changed."
          : " Read this exact reason before attempting another delegation.";
      return { text: `Couldn't queue the delegation: ${r.error}.${guidance}`, isError: true };
    }
    // Fire-and-forget by contract: the harness returns immediately, the
    // peer turn runs after our current turn finishes.
    return { text: typeof r.message === "string" ? r.message : "Delegation queued." };
  }
  if (name === "create_bot") {
    const botName = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    const instructions = String(args.instructions ?? "").trim();
    if (!botName || !role || !instructions) {
      return { text: "create_bot needs name, role, and instructions.", isError: true };
    }
    if (createdThisTurn >= MAX_CREATED_PER_TURN) {
      return { text: `You can create at most ${MAX_CREATED_PER_TURN} bots in one turn. Use the team you have before adding more.`, isError: true };
    }
    const r = await api(`/api/internal/create-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        name: botName,
        role,
        instructions,
      }),
    });
    createdThisTurn += 1;
    return {
      text: `Created @${r.name ?? botName} in ${r.section ?? "General"} [id: ${r.id}]. Assign work with delegate_bot.`,
    };
  }
  if (name === "request_credential") {
    const credentialId = args.credential_id;
    if (!isCredentialTargetId(credentialId)) {
      return { text: "request_credential needs a supported credential_id.", isError: true };
    }
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 240) : "";
    const r = await api("/api/internal/request-credential", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        credentialId,
        ...(reason ? { reason } : {}),
      }),
    });
    if (r.alreadyConfigured) {
      return { text: `${r.label ?? CREDENTIAL_TARGETS[credentialId].label} is already configured. Continue the task.` };
    }
    return {
      text: `A secure ${r.label ?? CREDENTIAL_TARGETS[credentialId].label} card is now visible to the user. End this turn; OpenMausBot will resume the task after they save or decline. Never ask them to paste the key into chat.`,
    };
  }
  if (name === "list_routines") {
    const query = new URLSearchParams({ fromBotId: BOT_ID, fromThreadId: THREAD_ID });
    const r = await api(`/api/internal/routines?${query.toString()}`);
    const routines = Array.isArray(r.routines) ? r.routines : [];
    const now = typeof r.now === "string" ? r.now : new Date().toISOString();
    const timeZone = typeof r.timeZone === "string" && r.timeZone ? r.timeZone : "local computer timezone";
    if (!routines.length) {
      return { text: `This bot has no routines. Current time: ${now}. Timezone: ${timeZone}.` };
    }
    return {
      text: `This bot's routines (current time: ${now}; timezone: ${timeZone}):\n${JSON.stringify(routines, null, 2)}`,
    };
  }
  if (name === "propose_routine") {
    const { fields: routine, error: scheduleError } = routineFields(args);
    if (scheduleError) return { text: scheduleError, isError: true };
    if (!routine.name || !routine.instructions || !routine.schedule) {
      return { text: "propose_routine needs name, instructions, and schedule.", isError: true };
    }
    const r = await api("/api/internal/routine-requests", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        action: "create",
        routine,
      }),
    });
    return confirmationResult(r, `the new routine “${routine.name}”`);
  }
  if (name === "propose_routine_action") {
    const routineId = String(args.routine_id ?? "").trim();
    const action = routineAction(args.action);
    if (!routineId || !action) {
      return { text: "propose_routine_action needs a routine_id and supported action.", isError: true };
    }
    const body: Json = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      action,
      routineId,
    };
    if (action === "update") {
      if (!jsonRecord(args.changes)) {
        return { text: "The update action needs at least one field in changes.", isError: true };
      }
      const { fields: changes, error: scheduleError } = routineFields(args.changes);
      if (scheduleError) return { text: scheduleError, isError: true };
      if (!Object.keys(changes).length) {
        return { text: "The update action needs at least one supported field in changes.", isError: true };
      }
      body.changes = changes;
    } else if (args.changes !== undefined) {
      return { text: `The ${action} action does not accept changes.`, isError: true };
    }
    const r = await api("/api/internal/routine-requests", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return confirmationResult(r, `${action.replace("_", " ")} on routine ${routineId}`);
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opengrokbot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: IS_CHIEF_OF_STAFF ? TOOLS : TOOLS.filter((tool) => !["inspect_runtime_policy", "patch_runtime_policy"].includes(tool.name)) });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, (params.arguments ?? {}) as Json);
        textResult(id, text, isError);
      } catch (e) {
        textResult(id, (e as Error).message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
