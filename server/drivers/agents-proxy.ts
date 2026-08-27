// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes five tools that
// let one bot talk to another, routed back through the harness so the
// harness stays the single owner of turns, permissions, and recursion
// limits:
//
//   list_bots()                          → the other bots in this section + their status
//   ask_bot(bot_id, msg)                 → send msg to that bot, wait, return its reply
//   delegate_bot(bot_id, msg, reason?)   → hand the task to a peer ASYNC: returns
//                                          immediately, the peer runs after your
//                                          current turn finishes, the user sees
//                                          the peer's reply as its own turn
//   create_bot(name, role, instructions) → Chiefs can add a specialist to
//                                          their own section
//   request_credential(id, reason?)       → show a secure, allowlisted key card
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
const RETRY_GUIDANCE = RETRY_CAP === 0
  ? "No automatic evidence-changing retry is available."
  : `Up to ${RETRY_CAP} evidence-changing automatic retry is available.`;

const TOOLS = [
  {
    name: "list_bots",
    description:
      "List the other bots (agents) in your OpenMausBot section you can message, with their model and whether they're busy. Call this before ask_bot to discover who's available.",
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
      `Hand one long-running stage to an existing bot in a fresh task. The message MUST be a compact handoff with exactly these headings: [OBJECTIVE], [BASE/WORKTREE] containing Base: and Worktree:, [ALLOWED FILES] with bullet-listed exact files, [FORBIDDEN SCOPE], [EXACT CHANGES], [VERIFICATION], [RECEIPT]. Maximum ${HANDOFF_BYTE_CAP} UTF-8 bytes for this turn. Never include parent history, transcripts, logs or large documents. The peer runs after your current turn and the coordinator resumes with its result. Identical stage/evidence replay is rejected. ${RETRY_GUIDANCE} Queue/fan-out is capped at ${DELEGATION_CONCURRENCY} successful delegations from this turn. Backend enforcement owns these limits.`,
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        routing_key: { type: "string", description: "Stable role address from list_bots, e.g. worker-1; use it if an old bot id is rejected." },
        bot_name: { type: "string", description: "Exact target display name, only for compatibility with an older roster." },
        message: { type: "string", description: `Seven-section handoff, at most ${HANDOFF_BYTE_CAP} UTF-8 bytes.` },
        reason: { type: "string", description: "Optional one-line reason for the delegation (shown to the user as a chip)." },
      },
      required: ["bot_id", "message"],
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
];

type Json = Record<string, unknown>;
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

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots in this section yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      const routing = b.routingKey ? `, routing_key: ${b.routingKey}` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}${routing}, model: ${b.model}${b.busy ? ", busy" : ""}]`;
    });
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
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
      ok(id, { tools: TOOLS });
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
