import { ChevronDown, ChevronLeft, Crown, FolderOpen, Lock, LockOpen, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, chiefRuntimePolicyLocked, runtimePolicySignature, useStore, type Bot, type RuntimePolicy } from "@/state/store";
import { stateForBot } from "@/lib/mascot";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { PillDropdown, type PillDropdownOption } from "./PillDropdown";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { requestNotificationPermission } from "@/lib/notify";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { shortPath } from "@/lib/short-path";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { VoiceSettings } from "./VoiceSettings";
import { SettingsRow } from "./SettingsPrimitives";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

/** What this bot has spent across its tasks. Cost is captioned by how the
 * engine is billed — on a subscription the figure is an equivalent. */
function BotUsageCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  if (usage.turns === 0) return null;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-medium text-ink">Usage</div>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          All bots →
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Turns</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Tokens</div>
          <div className="mt-0.5 tabular-nums text-ink" title={`${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`}>
            {formatTokens(usage.input + usage.output)}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Cost</div>
          <div className="mt-0.5 tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : "—"}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd) ? `Cost ${costCaption(instance?.snapshot.billing)}.` : "This engine doesn't report a price; tokens are counted."}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Working folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where this bot runs its shell and file tools.</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private bot workspace</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Choose…
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[12.5px]")}
            placeholder="Private bot workspace — or an absolute path"
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          New tasks start here. This task is pinned to {pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : "the home folder"} — start a new task to use the new folder.
        </div>
      )}
    </div>
  );
}

interface MemoryTopic {
  name: string;
  bytes: number;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the bot believes. Fetched on expand, not on mount: settings opens for
 * every bot and most visits never look at memory — and an expand also
 * re-reads, so notes the bot wrote mid-session show up on the next open. */
function MemoryCard({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [saving, setSaving] = useState(false);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    try {
      const result: { text: string; truncated: boolean; topics: MemoryTopic[] } = await api(
        `/api/bots/${bot.id}/memory`,
      );
      setText(result.text);
      setTruncated(result.truncated);
      setTopics(result.topics);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result: { truncated: boolean } = await api(`/api/bots/${bot.id}/memory`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      setTruncated(result.truncated);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const openTopic = async (name: string) => {
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <button
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <div>
          <div className="text-[15px] font-medium text-ink">Memory</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Notes this bot keeps between tasks — plain files you can edit.
          </div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[13px] text-ink-secondary">Loading…</div>}

      {open && !loading && topic && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">memory/{topic.name}</span>
            <button
              onClick={() => setTopic(null)}
              className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              Back
            </button>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12.5px] leading-relaxed text-ink">
            {topic.text}
          </pre>
        </div>
      )}

      {open && !loading && !topic && (
        <div className="mt-3">
          <textarea
            className={cn(inputCls, "min-h-[160px] resize-y font-mono text-[12.5px] leading-relaxed")}
            value={text}
            placeholder="Nothing remembered yet. The bot writes durable notes here — or add your own."
            aria-label="Bot memory"
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {truncated && (
              <span className="text-[11.5px] text-ink-secondary">
                Over the budget — only the top of this file loads each turn.
              </span>
            )}
          </div>
          {topics.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Topic files
              </div>
              <div className="overflow-hidden rounded-lg border border-hairline/40">
                {topics.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => void openTopic(entry.name)}
                    className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60"
                  >
                    <span className="truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

const FALLBACK_RUNTIME_POLICY: RuntimePolicy = {
  wallClockTimeoutMinutes: 0,
  idleTimeoutMinutes: 20,
  cancellationGraceSeconds: 5,
  retryCap: 1,
  maxToolAgentSteps: 0,
  delegationConcurrency: 4,
  freshSessionEnforcement: false,
  handoffByteCap: 12_000,
  cumulativeTokenPolicy: { mode: "disabled", limit: 1_000_000 },
};

function copyRuntimePolicy(policy?: RuntimePolicy): RuntimePolicy {
  return {
    ...(policy ?? FALLBACK_RUNTIME_POLICY),
    cumulativeTokenPolicy: {
      ...(policy?.cumulativeTokenPolicy ?? FALLBACK_RUNTIME_POLICY.cumulativeTokenPolicy),
    },
  };
}

function sameRuntimePolicy(a: RuntimePolicy, b: RuntimePolicy): boolean {
  return a.wallClockTimeoutMinutes === b.wallClockTimeoutMinutes
    && a.idleTimeoutMinutes === b.idleTimeoutMinutes
    && a.cancellationGraceSeconds === b.cancellationGraceSeconds
    && a.retryCap === b.retryCap
    && a.maxToolAgentSteps === b.maxToolAgentSteps
    && a.delegationConcurrency === b.delegationConcurrency
    && a.freshSessionEnforcement === b.freshSessionEnforcement
    && a.handoffByteCap === b.handoffByteCap
    && a.cumulativeTokenPolicy.mode === b.cumulativeTokenPolicy.mode
    && a.cumulativeTokenPolicy.limit === b.cumulativeTokenPolicy.limit;
}

function numberInputValue(value: number): number | string {
  return Number.isFinite(value) ? value : "";
}

function RuntimeControlsCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [expanded, setExpanded] = useState(false);
  const [base, setBase] = useState<RuntimePolicy>(() => copyRuntimePolicy(bot.runtimePolicy));
  const [draft, setDraft] = useState<RuntimePolicy>(() => copyRuntimePolicy(bot.runtimePolicy));
  const [status, setStatus] = useState<"clean" | "saving" | "saved" | "error">("clean");
  const [error, setError] = useState<string | null>(null);
  const [chiefLockSaving, setChiefLockSaving] = useState(false);
  const [chiefLockError, setChiefLockError] = useState<string | null>(null);
  const policySignature = runtimePolicySignature(bot.runtimePolicy);

  useEffect(() => {
    const next = copyRuntimePolicy(bot.runtimePolicy);
    setBase(next);
    setDraft(next);
    setStatus("clean");
    setError(null);
  }, [bot.id, policySignature]);

  const updateNumber = (key: keyof Pick<RuntimePolicy, "wallClockTimeoutMinutes" | "idleTimeoutMinutes" | "cancellationGraceSeconds" | "retryCap" | "maxToolAgentSteps" | "delegationConcurrency" | "handoffByteCap">, value: string) => {
    setDraft((current) => ({ ...current, [key]: value === "" ? Number.NaN : Number(value) }));
    setStatus("clean");
    setError(null);
  };

  const updateToken = (patch: Partial<RuntimePolicy["cumulativeTokenPolicy"]>) => {
    setDraft((current) => ({
      ...current,
      cumulativeTokenPolicy: { ...current.cumulativeTokenPolicy, ...patch },
    }));
    setStatus("clean");
    setError(null);
  };

  const save = async (reset: boolean) => {
    type RuntimePolicyPatch = Partial<Omit<RuntimePolicy, "cumulativeTokenPolicy">> & {
      cumulativeTokenPolicy?: Partial<RuntimePolicy["cumulativeTokenPolicy"]>;
    };
    const runtimePolicy: RuntimePolicyPatch = {};
    if (!reset) {
      const scalarKeys = [
        "wallClockTimeoutMinutes",
        "idleTimeoutMinutes",
        "cancellationGraceSeconds",
        "retryCap",
        "maxToolAgentSteps",
        "delegationConcurrency",
        "freshSessionEnforcement",
        "handoffByteCap",
      ] as const;
      const setChangedScalar = <K extends (typeof scalarKeys)[number]>(key: K) => {
        if (draft[key] !== base[key]) runtimePolicy[key] = draft[key];
      };
      for (const key of scalarKeys) setChangedScalar(key);
      const tokenPatch: Partial<RuntimePolicy["cumulativeTokenPolicy"]> = {};
      if (draft.cumulativeTokenPolicy.mode !== base.cumulativeTokenPolicy.mode) {
        tokenPatch.mode = draft.cumulativeTokenPolicy.mode;
      }
      if (draft.cumulativeTokenPolicy.limit !== base.cumulativeTokenPolicy.limit) {
        tokenPatch.limit = draft.cumulativeTokenPolicy.limit;
      }
      if (Object.keys(tokenPatch).length) runtimePolicy.cumulativeTokenPolicy = tokenPatch;
      if (!Object.keys(runtimePolicy).length) {
        setStatus("clean");
        return;
      }
    }

    setStatus("saving");
    setError(null);
    try {
      const result: { bot: Bot } = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ runtimePolicy: reset ? null : runtimePolicy }),
      });
      const next = copyRuntimePolicy(result.bot.runtimePolicy);
      setBase(next);
      setDraft(next);
      dispatch({ type: "botPatched", bot: result.bot });
      setStatus("saved");
    } catch (cause) {
      // Keep the server bot and reducer untouched when validation rejects the
      // draft. The user can correct it and explicitly save again.
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const dirty = !sameRuntimePolicy(base, draft);
  const saving = status === "saving";
  const chiefLocked = chiefRuntimePolicyLocked(bot);
  const chiefControlLabel = chiefLocked
    ? "Allow the Chief to adapt limits"
    : "Prevent the Chief from adapting limits";
  const chiefControlTitle = chiefLocked
    ? "Locked · click to allow the Chief to adapt limits"
    : "Allowed · click to prevent the Chief from adapting limits";

  const toggleChiefControl = async () => {
    setChiefLockSaving(true);
    setChiefLockError(null);
    try {
      const result: { bot: Bot } = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ chiefRuntimePolicyLocked: !chiefLocked }),
      });
      dispatch({ type: "botPatched", bot: result.bot });
    } catch (cause) {
      setChiefLockError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChiefLockSaving(false);
    }
  };
  type TokenMode = RuntimePolicy["cumulativeTokenPolicy"]["mode"];
  const tokenOptions: Array<PillDropdownOption<TokenMode>> = [
    { id: "disabled", label: "Disabled", value: "disabled" },
    { id: "soft", label: "Soft warning", value: "soft" },
    { id: "hard", label: "Hard cap", value: "hard" },
  ];
  const tokenSummary = draft.cumulativeTokenPolicy.mode === "disabled"
    ? "Tokens off"
    : `${draft.cumulativeTokenPolicy.mode === "soft" ? "Soft" : "Hard"} · ${draft.cumulativeTokenPolicy.limit.toLocaleString()}`;

  return (
    <SettingsRow
      className="rounded-xl bg-card p-4"
      title="Runtime controls"
      description="Limits, recovery, and token budget for future turns."
      control={(
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse runtime controls" : "Expand runtime controls"}
          title={expanded ? "Collapse runtime controls" : "Expand runtime controls"}
          onClick={() => setExpanded((current) => !current)}
          className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <ChevronDown size={17} aria-hidden="true" className={cn("transition-transform", expanded && "rotate-180")} />
        </button>
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full bg-inset px-2 py-1 text-[11.5px] text-ink-secondary">
            {draft.wallClockTimeoutMinutes === 0 ? "Turn cap off" : `${draft.wallClockTimeoutMinutes}m turn`}
          </span>
          <span className="rounded-full bg-inset px-2 py-1 text-[11.5px] text-ink-secondary">{draft.idleTimeoutMinutes}m idle</span>
          <span className="rounded-full bg-inset px-2 py-1 text-[11.5px] text-ink-secondary">{draft.delegationConcurrency} delegates</span>
          <span className="rounded-full bg-inset px-2 py-1 text-[11.5px] text-ink-secondary">{tokenSummary}</span>
          {dirty && <span className="rounded-full bg-accent/10 px-2 py-1 text-[11.5px] text-accent">Unsaved</span>}
        </div>

        <SettingsRow
          className={cn(
            "rounded-lg border px-3 py-2.5",
            chiefLocked ? "border-danger/40 bg-danger/10" : "border-hairline/40 bg-inset",
          )}
          title={<span className={chiefLocked ? "text-danger" : undefined}>Chief control</span>}
          description={chiefLocked
            ? <span className="text-danger">Locked · the Chief cannot adapt this bot's limits.</span>
            : "Allowed · the Chief may adapt limits for future tasks."}
          leading={(
            <span className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md",
              chiefLocked ? "bg-danger/15 text-danger" : "bg-control text-ink-secondary",
            )}>
              {chiefLocked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
            </span>
          )}
          control={(
            <button
              type="button"
              role="switch"
              aria-checked={chiefLocked}
              aria-label={chiefControlLabel}
              title={chiefControlTitle}
              disabled={chiefLockSaving}
              onClick={() => void toggleChiefControl()}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
                chiefLocked
                  ? "bg-danger focus-visible:ring-danger/50"
                  : "bg-control focus-visible:ring-hairline/70",
              )}
            >
              <span className={cn(
                "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                chiefLocked ? "left-[21px]" : "left-[3px]",
              )} />
            </button>
          )}
        />
        {chiefLockError && <div className="text-[12px] text-danger">{chiefLockError}</div>}

        {expanded && (
          <div className="space-y-3">
            <section className="rounded-xl border border-hairline/40 bg-inset p-3">
              <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Turn limits</div>
              <div className="mt-3 space-y-3">
                <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Wall clock" description="Minutes · 0 disables · max 1,440">
                  <input aria-label="Wall clock timeout" className={inputCls} type="number" min={0} max={1_440} step={1} disabled={saving} value={numberInputValue(draft.wallClockTimeoutMinutes)} onChange={(event) => updateNumber("wallClockTimeoutMinutes", event.currentTarget.value)} />
                </SettingsRow>
                <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Idle timeout" description="Minutes · 1–1,440">
                  <input aria-label="Idle timeout" className={inputCls} type="number" min={1} max={1_440} step={1} disabled={saving} value={numberInputValue(draft.idleTimeoutMinutes)} onChange={(event) => updateNumber("idleTimeoutMinutes", event.currentTarget.value)} />
                </SettingsRow>
                <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Cancel grace" description="Seconds · 1–120">
                  <input aria-label="Cancel grace" className={inputCls} type="number" min={1} max={120} step={1} disabled={saving} value={numberInputValue(draft.cancellationGraceSeconds)} onChange={(event) => updateNumber("cancellationGraceSeconds", event.currentTarget.value)} />
                </SettingsRow>
                <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Tool & agent steps" description="0 disables · 1–1,000">
                  <input aria-label="Tool and agent steps" className={inputCls} type="number" min={0} max={1_000} step={1} disabled={saving} value={numberInputValue(draft.maxToolAgentSteps)} onChange={(event) => updateNumber("maxToolAgentSteps", event.currentTarget.value)} />
                </SettingsRow>
              </div>
            </section>

            <section className="rounded-xl border border-hairline/40 bg-inset p-3">
              <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Recovery & coordination</div>
              <div className="mt-3 space-y-3">
                <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Retries" description="Automatic · 0–1">
                  <input aria-label="Retries" className={inputCls} type="number" min={0} max={1} step={1} disabled={saving} value={numberInputValue(draft.retryCap)} onChange={(event) => updateNumber("retryCap", event.currentTarget.value)} />
                </SettingsRow>
                <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Delegation" description="Concurrent agents · 1–4">
                  <input aria-label="Delegation concurrency" className={inputCls} type="number" min={1} max={4} step={1} disabled={saving} value={numberInputValue(draft.delegationConcurrency)} onChange={(event) => updateNumber("delegationConcurrency", event.currentTarget.value)} />
                </SettingsRow>
                <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Handoff size" description="UTF-8 bytes · 1,024–12,000">
                  <input aria-label="Handoff size" className={inputCls} type="number" min={1_024} max={12_000} step={1} disabled={saving} value={numberInputValue(draft.handoffByteCap)} onChange={(event) => updateNumber("handoffByteCap", event.currentTarget.value)} />
                </SettingsRow>
                <SettingsRow
                  className="rounded-lg border border-hairline/30 bg-card p-3"
                  title="Fresh session"
                  description="Start each turn from bounded replay."
                  control={(
                    <button
                      type="button"
                      role="switch"
                      aria-checked={draft.freshSessionEnforcement}
                      aria-label="Fresh session each turn"
                      disabled={saving}
                      onClick={() => {
                        setDraft((current) => ({ ...current, freshSessionEnforcement: !current.freshSessionEnforcement }));
                        setStatus("clean");
                        setError(null);
                      }}
                      className={cn(
                        "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50",
                        draft.freshSessionEnforcement ? "bg-accent" : "bg-control",
                      )}
                    >
                      <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", draft.freshSessionEnforcement ? "left-[21px]" : "left-[3px]")} />
                    </button>
                  )}
                />
              </div>
            </section>

            <section className="rounded-xl border border-hairline/40 bg-inset p-3">
              <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Token budget</div>
              <div className="mt-3 space-y-3">
                <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Policy" description="Disabled, warning, or hard cap. Soft warns once; hard requests a stop after the provider reports a sample.">
                  <PillDropdown
                    value={draft.cumulativeTokenPolicy.mode}
                    options={tokenOptions}
                    disabled={saving}
                    ariaLabel="Cumulative token policy"
                    onChange={(mode) => updateToken({ mode })}
                  />
                </SettingsRow>
                {draft.cumulativeTokenPolicy.mode !== "disabled" && (
                  <SettingsRow className="rounded-lg border border-hairline/30 bg-card p-3" title="Token limit" description="1,000–10,000,000">
                    <input aria-label="Token limit" className={inputCls} type="number" min={1_000} max={10_000_000} step={1} disabled={saving} value={numberInputValue(draft.cumulativeTokenPolicy.limit)} onChange={(event) => updateToken({ limit: event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value) })} />
                  </SettingsRow>
                )}
              </div>
            </section>

            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void save(false)} disabled={saving || !dirty} className="min-w-0 w-full flex-1 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => void save(true)}
                disabled={saving}
                aria-label="Reset runtime controls"
                title="Reset runtime controls"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-4 text-[12px] text-ink-secondary">
              {status === "saved" && "Saved"}
              {status === "clean" && !dirty && "Up to date"}
            </div>
            {error && <div className="text-[12px] text-danger">{error}</div>}
            <div className="text-[11.5px] leading-relaxed text-ink-secondary">
              Changes apply to the next admitted turn. Repeat, loop, and conflicting-writer guards remain active.
            </div>
          </div>
        )}
      </div>
    </SettingsRow>
  );
}

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | "local" | null>(null);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "computer"
        | "cloudBackend"
        | "autoStartVps"
        | "color"
        | "mascotExpression"
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "autoReview"
        | "speakReplies"
        | "voice"
        | "chiefOfStaff"
        | "approvePeerComms"
        | "composio"
        | "modelSelection"
      >
    > & { acknowledgeLocalAuto?: boolean },
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canAutoReview = engine?.capabilities?.approvalReview === true;
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  const connectedAppsEnabled = bot.composio !== false;
  const sectionName = bot.section?.trim() || "General";
  const currentChief = state.bots.find(
    (candidate) => candidate.chiefOfStaff && (candidate.section?.trim() || "") === (bot.section?.trim() || ""),
  );

  return (
    <>
    <aside className="animate-panel-in relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Collapse agent profile"
          title="Collapse agent profile"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Agent profile</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Close agent profile"
          title="Close agent profile"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          <BotProfileAvatarCard
            bot={bot}
            activeState={activeState}
            mascotMotion={mascotMotion}
            onPatch={patch}
          />

          <Field label="Name">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder="Describe what your agent does"
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-y")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder="What this agent is for"
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <SettingsRow
            className={cn(
              "rounded-xl border p-4",
              bot.chiefOfStaff ? "border-accent/40 bg-accent/10" : "border-hairline/40 bg-card",
            )}
            title="Chief of Staff"
            description={
              bot.chiefOfStaff && !canCoordinate
                ? "This bot still holds the role, but its current engine cannot contact teammates. Choose a Claude or ACP engine to restore coordination."
                : bot.chiefOfStaff
                  ? `This is the primary contact for ${sectionName}. It can create and coordinate specialists in this section, then combine their work into one answer.`
                  : !canCoordinate
                    ? "Choose a Claude or ACP engine to let this bot coordinate teammates."
                    : currentChief
                      ? `Make this bot the ${sectionName} Chief and hand the role over from ${currentChief.name}.`
                      : `Make this bot the primary contact for the ${sectionName} section.`
            }
            leading={(
              <span className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                bot.chiefOfStaff ? "bg-accent text-white" : "bg-control text-ink-secondary",
              )}>
                <Crown size={17} aria-hidden="true" />
              </span>
            )}
            control={(
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(bot.chiefOfStaff)}
                aria-label="Chief of Staff"
                disabled={!bot.chiefOfStaff && !canCoordinate}
                onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
                title={!bot.chiefOfStaff && !canCoordinate ? "This engine cannot contact other bots" : undefined}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  bot.chiefOfStaff ? "bg-accent" : "bg-control",
                )}
              >
                <span className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.chiefOfStaff ? "left-[21px]" : "left-[3px]",
                )} />
              </button>
            )}
          />

          <SettingsRow
            className="rounded-xl bg-card p-4"
            title="Ask me before contacting other bots"
            description={bot.approvePeerComms
              ? "This bot will stop and ask before it reaches out to another bot."
              : "Let this bot talk to teammates on its own, without a confirmation step."}
            control={(
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(bot.approvePeerComms)}
                aria-label="Ask me before contacting other bots"
                disabled={!bot.approvePeerComms && !canCoordinate}
                onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
                title={!bot.approvePeerComms && !canCoordinate ? "This engine cannot contact other bots" : undefined}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  bot.approvePeerComms ? "bg-accent" : "bg-control",
                )}
              >
                <span className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.approvePeerComms ? "left-[21px]" : "left-[3px]",
                )} />
              </button>
            )}
          />

          <RuntimeControlsCard key={`runtime-${bot.id}`} bot={bot} />

          <SettingsRow
            className="rounded-xl bg-card p-4"
            title="Connected apps"
            description={!connectedAppsConfigured
              ? "Connect apps in App Settings before giving this bot access."
              : !canUseConnectedApps
                ? "This bot's current engine cannot use connected apps."
                : connectedAppsEnabled
                  ? "Let this bot use your connected Gmail, Calendar, Slack, and other apps."
                  : "Keep your connected apps unavailable to this bot."}
            control={(
              <button
                type="button"
                role="switch"
                aria-checked={connectedAppsEnabled}
                aria-label="Allow this bot to use connected apps"
                disabled={!connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)}
                onClick={() => patch({ composio: !connectedAppsEnabled })}
                title={!connectedAppsEnabled && !connectedAppsConfigured
                  ? "Connect apps in App Settings first"
                  : !connectedAppsEnabled && !canUseConnectedApps
                    ? "This engine cannot use connected apps"
                    : undefined}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  connectedAppsEnabled ? "bg-accent" : "bg-control",
                )}
              >
                <span className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  connectedAppsEnabled ? "left-[21px]" : "left-[3px]",
                )} />
              </button>
            )}
          />

          <div className="rounded-xl bg-card p-4">
            <ModelPicker
              bot={bot}
              contained
              label={
                <div>
                  <div className="text-[15px] font-medium text-ink">Model</div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">
                    Which provider and model this bot runs on
                  </div>
                </div>
              }
            />
          </div>

          {!!engine?.capabilities?.effortLevels?.length && (
            <div className="rounded-xl bg-card p-4">
              <EffortPicker
                bot={bot}
                contained
                label={
                  <div>
                    <div className="text-[15px] font-medium text-ink">Effort</div>
                    <div className="mt-0.5 text-[13px] text-ink-secondary">
                      How hard this bot thinks{bot.modelSelection.effort ? "" : " (Default: no level is sent)"}
                    </div>
                  </div>
                }
              />
            </div>
          )}

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Computer</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Where this bot's computer runs{bot.computer ? "" : " (currently: auto)"}
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {([
                ["cloud", "Cloud"],
                ["vm", "Local VM"],
                ["local", "This computer"],
                ["off", "Off"],
              ] as const).map(([mode, label], i) => (
                <button
                  key={mode}
                  disabled={mode === "local" && !localSelectable}
                  title={mode === "local" && !localSelectable ? localDisabledReason ?? undefined : undefined}
                  onClick={() => {
                    if (mode === bot.computer) return;
                    if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                    else patch({ computer: mode });
                  }}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    mode === "local" && !localSelectable && "cursor-not-allowed opacity-40",
                    bot.computer === mode
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {(!bot.computer || bot.computer === "cloud") && (
              <>
                <CloudBackendPicker
                  value={bot.cloudBackend ?? "box"}
                  vpsSupported={canUseVps}
                  onChange={(backend) => patch({ cloudBackend: backend })}
                />
                {!bot.computer && bot.cloudBackend === "vps" && (
                  <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">Start VPS automatically</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                        Allow Auto to create or wake this bot's managed container when needed.
                      </div>
                    </div>
                    <button
                      role="switch"
                      aria-checked={Boolean(bot.autoStartVps)}
                      aria-label="Start VPS automatically"
                      onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
                      className={cn(
                        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                        bot.autoStartVps ? "bg-accent" : "bg-control",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-[3px] size-[18px] rounded-full bg-white transition-all",
                          bot.autoStartVps ? "left-[22px]" : "left-[4px]",
                        )}
                      />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <BotUsageCard bot={bot} />
          <WorkingFolder bot={bot} />

          {/* keyed so switching bots never shows one bot's notes under another's name */}
          <MemoryCard key={bot.id} bot={bot} />

          <SettingsRow
            className="rounded-xl bg-card p-4"
            title="Auto mode"
            description={bot.computer === "local"
              ? bot.autoApprove
                ? "Keeps going on this computer — you'll still be asked about anything destructive, and about questions it asks you."
                : "Approve each action on this computer yourself. Turn on to let this bot keep working without stopping to ask."
              : bot.autoApprove
                ? "Keeps going on its own — you'll still be asked about anything destructive, and about questions it asks you."
                : "Approve each action yourself. Turn on to let this bot keep working without stopping to ask."}
            control={(
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(bot.autoApprove)}
                aria-label="Auto mode"
                onClick={() => {
                  if (!bot.autoApprove && bot.computer === "local") setLocalAutoWarning("auto");
                  else patch({ autoApprove: !bot.autoApprove });
                }}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                  bot.autoApprove ? "bg-accent" : "bg-control",
                )}
              >
                <span className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.autoApprove ? "left-[21px]" : "left-[3px]",
                )} />
              </button>
            )}
          />

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Review routine approvals</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {canAutoReview
                ? "The same engine reviews ordinary approval cards. Existing safety rules, unattended turns, local-computer access, and questions still wait for you."
                : "This engine cannot run an isolated review safely, so approval cards continue to wait for you."}
            </div>
            <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
              {(
                [
                  ["off", "Off", "Every undecided approval waits for you."],
                  ["shadow", "Watch", "Record the review without answering the card."],
                  ["enforce", "On", "Answer only reviews that return a strict approval."],
                ] as const
              ).map(([value, label, hint]) => {
                const current = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
                const disabled = value !== "off" && !canAutoReview;
                return (
                  <button
                    key={value}
                    title={disabled ? "Not supported by this engine" : hint}
                    disabled={disabled}
                    onClick={() => patch({ autoReview: value })}
                    className={cn(
                      "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                      current === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <VoiceSettings bot={bot} onPatch={patch} />

          <SettingsRow
            className="rounded-xl bg-card p-4"
            title="Notifications"
            description="Get notified when this agent finishes or needs input"
            control={(
              <button
                type="button"
                role="switch"
                aria-checked={bot.notifications}
                aria-label="Agent notifications"
                onClick={() => {
                  const enabled = !bot.notifications;
                  if (enabled) void requestNotificationPermission();
                  patch({ notifications: enabled });
                }}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                  bot.notifications ? "bg-accent" : "bg-control",
                )}
              >
                <span className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.notifications ? "left-[21px]" : "left-[3px]",
                )} />
              </button>
            )}
          />
        </div>
      </div>
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        if (localAutoWarning === "auto") patch({ autoApprove: true, acknowledgeLocalAuto: true });
        if (localAutoWarning === "local") patch({ computer: "local", acknowledgeLocalAuto: true });
        setLocalAutoWarning(null);
      }}
    />
    </>
  );
}
