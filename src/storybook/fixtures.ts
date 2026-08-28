import {
  initialState,
  type AppState,
  type Bot,
  type Group,
  type InstanceInfo,
  type Message,
  type RuntimePolicy,
  type SkillCatalogEntry,
} from "@/state/store";
import type { RuntimeEvent } from "../../server/contracts.ts";
import type { InspectorPage } from "../../server/thread-events.ts";
import type { CompanionState, PhoneSetupController } from "@/components/PhoneSetupFlow";
import type { StorybookFakeResponseMap } from "./fetch-guard";

const FIXTURE_TIME = 1_735_689_600_000;

export const runtimePolicyAllowed: RuntimePolicy = {
  wallClockTimeoutMinutes: 45,
  idleTimeoutMinutes: 8,
  cancellationGraceSeconds: 15,
  retryCap: 1,
  maxToolAgentSteps: 240,
  delegationConcurrency: 3,
  freshSessionEnforcement: true,
  handoffByteCap: 12_000,
  cumulativeTokenPolicy: { mode: "soft", limit: 2_000_000 },
};

export const runtimePolicyLocked: RuntimePolicy = {
  ...runtimePolicyAllowed,
  idleTimeoutMinutes: 20,
  maxToolAgentSteps: 120,
  cumulativeTokenPolicy: { mode: "hard", limit: 1_000_000 },
};

export const fixtureInstances: InstanceInfo[] = [
  {
    instanceId: "claude-team",
    driverKind: "claudeAgent",
    displayName: "Claude",
    snapshot: { state: "available", authenticated: true, version: "ready", billing: "subscription" },
    models: {
      default: "claude-sonnet",
      options: [
        { id: "claude-sonnet", label: "Claude Sonnet" },
        { id: "claude-opus", label: "Claude Opus" },
      ],
    },
    capabilities: { agentsMcp: true, computerMcp: true, effortLevels: ["low", "medium", "high", "xhigh"] },
    access: "subscription",
  },
  {
    instanceId: "grok-lab",
    driverKind: "grokAgent",
    displayName: "Grok",
    snapshot: { state: "available", authenticated: true, version: "ready", billing: "metered" },
    models: { default: "grok-4", options: [{ id: "grok-4", label: "Grok 4" }] },
    capabilities: { agentsMcp: true, effortLevels: ["low", "medium", "high"] },
    access: "subscription",
  },
  {
    instanceId: "offline-local",
    driverKind: "codex",
    displayName: "Local model",
    snapshot: { state: "unavailable", reason: "Fixture only: provider is offline", setup: true },
    models: { default: "local-small", options: [{ id: "local-small", label: "Local Small" }] },
    capabilities: { effortLevels: ["low", "medium"] },
    access: "custom",
  },
];

export const fixtureSkills: SkillCatalogEntry[] = [
  {
    id: "release-notes",
    name: "Release notes",
    version: "1.2.0",
    description: "Turn a set of changes into a concise, reviewable release summary.",
    defaultEnabled: true,
    triggerTerms: ["release", "changelog"],
    requiredCapabilities: [],
    tools: ["Read"],
    origin: "built-in",
    status: "available",
    warnings: [],
    skippedFiles: [],
  },
  {
    id: "research-brief",
    name: "Research brief",
    version: "0.4.0",
    description: "Structure notes into an evidence-led brief with open questions.",
    defaultEnabled: false,
    triggerTerms: ["research", "brief"],
    requiredCapabilities: ["web"],
    tools: ["Read", "WebSearch"],
    origin: "recorded",
    status: "available",
    warnings: ["Web access is not part of this fixture."],
    skippedFiles: [],
  },
  {
    id: "empty-library",
    name: "Empty catalog example",
    version: "0.0.0",
    description: "A deliberately minimal skill for empty and overflow layout stories.",
    defaultEnabled: false,
    triggerTerms: [],
    requiredCapabilities: [],
    tools: [],
    origin: "imported",
    status: "available",
    warnings: [],
    skippedFiles: [],
  },
];

const optionMessage: Message = {
  id: "message-options",
  role: "bot",
  kind: "options",
  text: "Choose the shape of the next work item.",
  card: { title: "What should I optimize for?", subtitle: "Pick one direction.", options: ["Speed", "Depth", "A balanced pass"] },
  at: FIXTURE_TIME + 1_000,
};

const approvalMessage: Message = {
  id: "message-approval",
  role: "bot",
  kind: "options",
  text: "Approval is waiting.",
  card: {
    title: "Run the validation suite",
    subtitle: "pnpm test --filter local-fixtures",
    options: ["Allow", "Deny"],
    requestId: "approval-fixture",
    tool: "Bash",
  },
  at: FIXTURE_TIME + 2_000,
};

const secretMessage: Message = {
  id: "message-secret",
  role: "bot",
  kind: "secret",
  text: "A provider key is needed for this isolated fixture.",
  secret: {
    target: "xaiApiKey",
    label: "xAI API key",
    description: "Fixture card only. No key is present or accepted by Storybook.",
    placeholder: "fixture-key",
    helpUrl: "https://example.invalid/fixture-help",
    requestKey: "secret-fixture",
  },
  at: FIXTURE_TIME + 3_000,
};

const makeBot = (overrides: Partial<Bot> & Pick<Bot, "id" | "name">): Bot => {
  const { id, name, ...rest } = overrides;
  return {
    id,
    threadId: `${id}-thread`,
    name,
    title: "A focused specialist",
    description: "A synthetic bot used only by the Storybook workshop.",
    notifications: true,
    color: "green",
    unread: false,
    busy: false,
    activity: "idle",
    modelSelection: { instanceId: "claude-team", model: "claude-sonnet", effort: "medium" },
    chiefOfStaff: false,
    runtimePolicy: runtimePolicyAllowed,
    messages: [],
    ...rest,
  };
};

export const fixtureBots: Bot[] = [
  makeBot({
    id: "chief",
    name: "Aster",
    title: "Chief of Staff",
    description: "Coordinates a small research and implementation pool.",
    color: "blue",
    chiefOfStaff: true,
    section: "Product",
    messages: [optionMessage, approvalMessage, secretMessage],
    tasks: [
      { threadId: "chief-thread", title: "Current coordination", createdAt: FIXTURE_TIME },
      { threadId: "chief-research", title: "Research notes", createdAt: FIXTURE_TIME - 86_400_000, usage: { input: 12_400, output: 4_800, costUsd: null, turns: 3 } },
    ],
  }),
  makeBot({
    id: "builder",
    name: "Mica",
    title: "Implementation specialist",
    description: "Keeps changes small, tested, and easy to review.",
    color: "purple",
    section: "Product",
    chiefRuntimePolicyLocked: true,
    runtimePolicy: runtimePolicyLocked,
    busy: true,
    activity: "working",
    messages: [
      { id: "builder-1", role: "user", kind: "text", text: "Keep this pass bounded and deterministic.", at: FIXTURE_TIME + 4_000 },
      { id: "builder-2", role: "bot", kind: "text", text: "I will leave a clear receipt and stop at the boundary.", at: FIXTURE_TIME + 5_000 },
    ],
  }),
  makeBot({
    id: "reviewer",
    name: "Vale",
    title: "Review partner",
    description: "Surfaces edge cases and asks for evidence when a state is ambiguous.",
    color: "orange",
    section: "Quality",
    modelSelection: { instanceId: "grok-lab", model: "grok-4", effort: "high" },
  }),
];

export const fixtureGroups: Group[] = [
  {
    id: "product-room",
    threadId: "product-room-thread",
    name: "Product room",
    memberIds: ["chief", "builder", "reviewer"],
    defaultResponder: { kind: "member", botId: "chief" },
    bulletin: "Keep decisions and handoffs visible.",
    unread: true,
    createdAt: FIXTURE_TIME,
    section: "Product",
    messages: [{ id: "room-1", role: "bot", kind: "text", text: "The next review starts from the shared fixture state.", at: FIXTURE_TIME + 6_000, from: { botId: "chief", name: "Aster", color: "blue" } }],
  },
];

export const fixtureTeamMapResponses = {
  populated: {
    collaborations: [{ groupId: "product-room", botIds: ["chief", "builder"], lastAt: FIXTURE_TIME + 7_000 }],
    queued: [{ sourceBotId: "chief", targetBotId: "reviewer", reason: "Review the bounded plan" }],
    running: [{ sourceBotId: "builder", targetBotId: "reviewer", threadId: "reviewer-thread", groupId: "product-room" }],
  },
  empty: { collaborations: [], queued: [], running: [] },
} as const;

const inspectorEvent: RuntimeEvent = {
  eventId: "fixture-event-1",
  provider: "claudeAgent",
  threadId: "chief-thread",
  createdAt: "2025-01-01T12:00:00.000Z",
  type: "turn.started",
  turnId: "fixture-turn-1",
};

interface FixtureInspectorResponses {
  populated: InspectorPage;
  empty: InspectorPage;
}

export const fixtureInspectorResponses = {
  populated: { entries: [{ kind: "runtime", at: inspectorEvent.createdAt, data: inspectorEvent }], total: { runtime: 1, native: 0 } },
  empty: { entries: [], total: { runtime: 0, native: 0 } },
} satisfies FixtureInspectorResponses;

const fixturePhoneState: CompanionState = {
  enabled: false,
  keepAwake: false,
  port: 0,
  devices: [],
  pairing: null,
};

export const fixturePhoneController: PhoneSetupController = {
  state: fixturePhoneState,
  account: null,
  phase: "intro",
  email: "",
  code: "",
  codeSent: false,
  busy: false,
  accountBusy: false,
  error: null,
  accountError: null,
  pairingLink: null,
  secondsLeft: 0,
  address: undefined,
  pairingPort: 0,
  hostedReady: false,
  localFallback: false,
  tailscaleFallback: false,
  tailscaleAvailable: false,
  pairingExpired: false,
  setupTimedOut: false,
  setEmail: () => undefined,
  setCode: () => undefined,
  changeEmail: () => undefined,
  start: () => undefined,
  useLocal: () => undefined,
  useTailscale: () => undefined,
  requestCode: () => undefined,
  verifyCode: () => undefined,
  retryAccount: () => undefined,
  cancel: () => undefined,
  refreshCode: () => undefined,
  finish: () => undefined,
  skip: () => undefined,
  act: async () => undefined,
  accountAct: async () => undefined,
};

export function createFixtureState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    bots: fixtureBots,
    groups: fixtureGroups,
    instances: fixtureInstances,
    skills: fixtureSkills,
    selectedId: "chief",
    connected: true,
    error: null,
    ...overrides,
  };
}

const longText = "A long-content fixture keeps the real profile panel honest at narrow widths. ".repeat(12);

export const fixtureStates = {
  default: createFixtureState(),
  chiefLocked: createFixtureState({ bots: fixtureBots.map((bot) => bot.id === "chief" ? { ...bot, chiefRuntimePolicyLocked: true, runtimePolicy: runtimePolicyLocked } : bot) }),
  empty: createFixtureState({ bots: [], groups: [], skills: [], instances: [] }),
  loading: createFixtureState({ connected: false, bots: [], groups: [] }),
  error: createFixtureState({ connected: false, error: "Fixture error: the local catalog is unavailable." }),
  longContent: createFixtureState({
    bots: fixtureBots.map((bot) => bot.id === "chief" ? { ...bot, title: longText, description: longText, messages: [{ ...optionMessage, text: longText }] } : bot),
  }),
  sidebarEmpty: createFixtureState({ bots: [], groups: [] }),
  sidebarError: createFixtureState({ error: "Fixture error: the team list could not be loaded.", connected: false }),
  sidebarLongNames: createFixtureState({
    bots: fixtureBots.map((bot, index) => ({ ...bot, name: `${bot.name} · ${"Very long specialist name ".repeat(index + 2)}` })),
  }),
  computerDisconnected: createFixtureState({
    bots: fixtureBots.map((bot) => bot.id === "builder" ? { ...bot, busy: false, activity: "idle", computer: "vm" } : bot),
  }),
} satisfies Record<string, AppState>;

export const STORYBOOK_ALLOWED_FAKE_RESPONSES = {
  "/api/health": { body: JSON.stringify({ ok: true }) },
  "/api/team-map": { body: JSON.stringify(fixtureTeamMapResponses.populated) },
  "/api/bots/builder/local-computer": { body: JSON.stringify({ mode: "per-bot", max_instances: 1, image: false, create_supported: false, container: "missing", imageMatches: false, managed: true, network: "unknown", security: "unknown", persistence: "durable", desktopReady: false, ready: false, problem: "Fixture: desktop is disconnected", viewer_url: "" }) },
  "/api/threads/chief-thread/events": { body: JSON.stringify(fixtureInspectorResponses.populated) },
  "/api/threads/builder-thread/events": { body: JSON.stringify(fixtureInspectorResponses.empty) },
  "/api/connectors": { body: JSON.stringify({ services: {} }) },
  "/api/connectors/connected": { body: JSON.stringify({ services: {} }) },
  "/api/connectors/catalog": { body: JSON.stringify({ cards: [], source: "curated", configured: false, mode: "unavailable" }) },
} satisfies StorybookFakeResponseMap;
