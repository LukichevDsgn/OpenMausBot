import { ChevronDown, ChevronLeft, Crown, FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, runtimePolicySignature, useStore, type Bot, type RuntimePolicy, type SkillCatalogEntry } from "@/state/store";
import { MausAvatar } from "./Avatar";
import {
  PICKABLE_STATES,
  stateForBot,
  MAUS_COLORS,
  MAUS_COLOR_NAMES,
} from "@/lib/mascot";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { ModelPicker } from "./ModelPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { requestNotificationPermission } from "@/lib/notify";
import { botUsage, costCaption, formatTokens, formatUsd } from "@/lib/usage";
import { shortPath } from "@/lib/short-path";
import { instanceSupportsLocalComputer, localComputerDisabledReason } from "@/lib/local-computer";

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
          <div className="mt-0.5 tabular-nums text-ink">{usage.costUsd === null ? "—" : formatUsd(usage.costUsd)}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {usage.costUsd === null ? "This engine doesn't report a price; tokens are counted." : `Cost ${costCaption(instance?.snapshot.billing)}.`}
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
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
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
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
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
              className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
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
              className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
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
                    className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-raised/60"
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

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function defaultSkillIds(catalog: readonly SkillCatalogEntry[]): string[] {
  return sortedIds(catalog.filter((skill) => skill.defaultEnabled).map((skill) => skill.id));
}

function effectiveSkillIds(bot: Bot, catalog: readonly SkillCatalogEntry[]): string[] {
  const known = new Set(catalog.map((skill) => skill.id));
  return sortedIds(
    (bot.skillGrants === undefined ? defaultSkillIds(catalog) : bot.skillGrants)
      .filter((id) => known.has(id)),
  );
}

function effectiveToolIds(bot: Bot, catalog: readonly SkillCatalogEntry[], skillIds: readonly string[]): string[] {
  const known = new Set(catalog.flatMap((skill) => skill.tools));
  const defaultTools = catalog
    .filter((skill) => skillIds.includes(skill.id))
    .flatMap((skill) => skill.tools);
  return sortedIds(
    (bot.skillToolGrants === undefined ? defaultTools : bot.skillToolGrants)
      .filter((id) => known.has(id)),
  );
}

function SkillToggle({
  checked,
  label,
  onClick,
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className={cn("relative h-[24px] w-[40px] shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-raised")}
    >
      <span className={cn("absolute top-[3px] size-[18px] rounded-full bg-white transition-all", checked ? "left-[19px]" : "left-[3px]")} />
    </button>
  );
}

/** Per-bot grants are persisted explicitly. The effective defaults are only
 * the initial view; every user change writes arrays, including []. */
function SkillsCard({ bot, catalog }: { bot: Bot; catalog: readonly SkillCatalogEntry[] }) {
  const { dispatch } = useStore();
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const nextSkills = effectiveSkillIds(bot, catalog);
    setSkillIds(nextSkills);
    setToolIds(effectiveToolIds(bot, catalog, nextSkills));
  }, [bot.id, bot.skillGrants, bot.skillToolGrants, catalog]);

  if (!catalog.length) return null;

  const save = async (nextSkills: string[], nextTools: string[]) => {
    setSkillIds(nextSkills);
    setToolIds(nextTools);
    setSaving(true);
    setError(null);
    try {
      const result: { bot: Bot } = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ skillGrants: nextSkills, skillToolGrants: nextTools }),
      });
      dispatch({ type: "botPatched", bot: result.bot });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Skills</div>
      <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">
        Choose which bundled skills and their tools this bot may use. Changes apply on the next turn.
      </div>
      <div className="mt-3 space-y-3">
        {catalog.map((skill) => {
          const skillEnabled = skillIds.includes(skill.id);
          return (
            <div key={skill.id} className="rounded-lg border border-hairline/40 bg-inset p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium text-ink">{skill.name}</div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{skill.description}</div>
                </div>
                <SkillToggle
                  checked={skillEnabled}
                  label={`Allow ${skill.name}`}
                  onClick={() => void save(
                    skillEnabled
                      ? skillIds.filter((id) => id !== skill.id)
                      : sortedIds([...skillIds, skill.id]),
                    toolIds,
                  )}
                />
              </div>
              {skill.tools.length > 0 && (
                <div className="mt-3 border-t border-hairline/30 pt-2.5">
                  <div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-ink-secondary">Tools</div>
                  <div className="space-y-1.5">
                    {skill.tools.map((toolId) => {
                      const toolEnabled = toolIds.includes(toolId);
                      return (
                        <div key={toolId} className="flex items-center justify-between gap-3">
                          <span className="font-mono text-[12px] text-ink">{toolId}</span>
                          <SkillToggle
                            checked={toolEnabled}
                            label={`Allow ${toolId} for ${skill.name}`}
                            onClick={() => void save(
                              skillIds,
                              toolEnabled
                                ? toolIds.filter((id) => id !== toolId)
                                : sortedIds([...toolIds, toolId]),
                            )}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {saving && <div className="mt-2 text-[12px] text-ink-secondary">Saving…</div>}
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
  const [base, setBase] = useState<RuntimePolicy>(() => copyRuntimePolicy(bot.runtimePolicy));
  const [draft, setDraft] = useState<RuntimePolicy>(() => copyRuntimePolicy(bot.runtimePolicy));
  const [status, setStatus] = useState<"clean" | "saving" | "saved" | "error">("clean");
  const [error, setError] = useState<string | null>(null);
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
    const runtimePolicy: Record<string, unknown> = {};
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
      for (const key of scalarKeys) {
        if (draft[key] !== base[key]) runtimePolicy[key] = draft[key];
      }
      const tokenPatch: Record<string, unknown> = {};
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

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Runtime controls</div>
      <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">
        Changes apply to the next admitted turn and never interrupt the current one. Deterministic repeat/loop and conflicting-writer guards stay active independently.
      </div>

      <div className="mt-4 text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Turn limits</div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <Field label="Wall-clock (minutes; 0 = off)">
          <input
            className={inputCls}
            type="number"
            min={0}
            max={1_440}
            step={1}
            disabled={saving}
            value={numberInputValue(draft.wallClockTimeoutMinutes)}
            onChange={(event) => updateNumber("wallClockTimeoutMinutes", event.currentTarget.value)}
          />
        </Field>
        <Field label="Idle timeout (minutes; 1–1440)">
          <input
            className={inputCls}
            type="number"
            min={1}
            max={1_440}
            step={1}
            disabled={saving}
            value={numberInputValue(draft.idleTimeoutMinutes)}
            onChange={(event) => updateNumber("idleTimeoutMinutes", event.currentTarget.value)}
          />
        </Field>
        <Field label="Cancellation grace (seconds; 1–120)">
          <input
            className={inputCls}
            type="number"
            min={1}
            max={120}
            step={1}
            disabled={saving}
            value={numberInputValue(draft.cancellationGraceSeconds)}
            onChange={(event) => updateNumber("cancellationGraceSeconds", event.currentTarget.value)}
          />
        </Field>
        <Field label="Max tool/agent steps (0 = off; 1–1000)">
          <input
            className={inputCls}
            type="number"
            min={0}
            max={1_000}
            step={1}
            disabled={saving}
            value={numberInputValue(draft.maxToolAgentSteps)}
            onChange={(event) => updateNumber("maxToolAgentSteps", event.currentTarget.value)}
          />
        </Field>
      </div>

      <div className="mt-4 text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Coordination</div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <Field label="Automatic retries (0–1)">
          <input
            className={inputCls}
            type="number"
            min={0}
            max={1}
            step={1}
            disabled={saving}
            value={numberInputValue(draft.retryCap)}
            onChange={(event) => updateNumber("retryCap", event.currentTarget.value)}
          />
        </Field>
        <Field label="Delegation fan-out (1–4)">
          <input
            className={inputCls}
            type="number"
            min={1}
            max={4}
            step={1}
            disabled={saving}
            value={numberInputValue(draft.delegationConcurrency)}
            onChange={(event) => updateNumber("delegationConcurrency", event.currentTarget.value)}
          />
        </Field>
        <Field label="Handoff size (UTF-8 bytes; 1024–12000)">
          <input
            className={inputCls}
            type="number"
            min={1_024}
            max={12_000}
            step={1}
            disabled={saving}
            value={numberInputValue(draft.handoffByteCap)}
            onChange={(event) => updateNumber("handoffByteCap", event.currentTarget.value)}
          />
        </Field>
        <label className="flex min-h-[72px] items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[13px] text-ink">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            disabled={saving}
            checked={draft.freshSessionEnforcement}
            onChange={(event) => {
              setDraft((current) => ({ ...current, freshSessionEnforcement: event.currentTarget.checked }));
              setStatus("clean");
              setError(null);
            }}
          />
          <span>
            <span className="block">Fresh session each turn</span>
            <span className="mt-0.5 block text-[11.5px] text-ink-secondary">Keeps the bounded active-branch replay.</span>
          </span>
        </label>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label="Cumulative token policy">
          <select
            className={inputCls}
            disabled={saving}
            value={draft.cumulativeTokenPolicy.mode}
            onChange={(event) => updateToken({ mode: event.currentTarget.value as RuntimePolicy["cumulativeTokenPolicy"]["mode"] })}
          >
            <option value="disabled">Disabled</option>
            <option value="soft">Soft warning</option>
            <option value="hard">Hard cap</option>
          </select>
        </Field>
        <Field label="Token limit (1,000–10,000,000)">
          <input
            className={inputCls}
            type="number"
            min={1_000}
            max={10_000_000}
            step={1}
            disabled={saving || draft.cumulativeTokenPolicy.mode === "disabled"}
            value={numberInputValue(draft.cumulativeTokenPolicy.limit)}
            onChange={(event) => updateToken({ limit: event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value) })}
          />
        </Field>
      </div>
      <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
        Disabled token policy does not stop workers or research. Soft warns once; hard requests a stop after the provider reports a sample.
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save(false)}
          disabled={saving || !dirty}
          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void save(true)}
          disabled={saving}
          className="rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          Reset
        </button>
        {status === "saved" && <span className="text-[12px] text-ink-secondary">Saved</span>}
        {status === "clean" && !dirty && <span className="text-[12px] text-ink-secondary">Up to date</span>}
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const { capabilities } = useDesktopCapabilities();
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = capabilities.localComputer.available && providerSupportsLocal;
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
        | "color"
        | "mascotExpression"
        | "autoApprove"
        | "speakReplies"
        | "voice"
        | "chiefOfStaff"
        | "approvePeerComms"
        | "composio"
        | "modelSelection"
      >
    >,
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  const connectedAppsEnabled = bot.composio !== false;
  const currentChief = state.bots.find(
    (candidate) => candidate.chiefOfStaff && (candidate.section || "") === (bot.section || ""),
  );

  useEffect(() => {
    if (!state.config?.tts?.configured) {
      setVoices([]);
      return;
    }
    let alive = true;
    setVoicesLoading(true);
    api("/api/tts/voices")
      .then((result: { voices?: typeof voices }) => alive && setVoices(result.voices ?? []))
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setVoicesLoading(false));
    return () => {
      alive = false;
    };
  }, [state.config?.tts?.configured]);

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Settings</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex justify-center py-5">
          <MausAvatar
            color={bot.color}
            state={activeState}
            size={112}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
            <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
              <span className="rounded-lg bg-raised px-3 py-1.5 text-[14px] font-medium text-ink">
                Bot
              </span>
              <button
                onClick={() => patch({ color: "green", mascotExpression: null })}
                className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Reset
              </button>
            </div>

            <div className="p-3">
              <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Expression
              </div>
              <div className="grid grid-cols-5 gap-2">
                {PICKABLE_STATES.map((expression) => (
                  <button
                    key={expression}
                    onClick={() => patch({ mascotExpression: expression })}
                    className={cn(
                      "flex h-[58px] items-center justify-center rounded-xl bg-inset transition-colors hover:bg-raised",
                      activeState === expression && "ring-2 ring-accent-border",
                    )}
                    title={expression}
                    aria-label={`Use ${expression} expression`}
                  >
                    <MausAvatar color={bot.color} state={expression} size={42} animated={false} />
                  </button>
                ))}
              </div>

              <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Color
              </div>
              <div className="flex flex-wrap gap-2.5">
                {MAUS_COLOR_NAMES.map((color) => (
                  <button
                    key={color}
                    onClick={() => patch({ color })}
                    className={cn(
                      "size-8 rounded-full border-2 border-transparent transition-transform hover:scale-110",
                      bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                    )}
                    style={{ backgroundColor: MAUS_COLORS[color] }}
                    title={color}
                    aria-label={`Use ${color} mascot color`}
                  />
                ))}
              </div>
            </div>
          </div>

          <Field label="Name">
            <input
              className={inputCls}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputCls}
              placeholder="Describe what your agent does"
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              placeholder="What this agent is for"
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <div className={cn(
            "rounded-xl border p-4",
            bot.chiefOfStaff ? "border-accent/40 bg-accent/10" : "border-hairline/40 bg-card",
          )}>
            <div className="flex items-center gap-3">
              <span className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                bot.chiefOfStaff ? "bg-accent text-white" : "bg-raised text-ink-secondary",
              )}>
                <Crown size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium text-ink">Chief of Staff</div>
                <div className="text-[11.5px] text-ink-secondary">One per workspace</div>
              </div>
              <button
                role="switch"
                aria-checked={Boolean(bot.chiefOfStaff)}
                aria-label="Chief of Staff"
                disabled={!bot.chiefOfStaff && !canCoordinate}
                onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
                title={!bot.chiefOfStaff && !canCoordinate ? "This engine cannot contact other bots" : undefined}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  bot.chiefOfStaff ? "bg-accent" : "bg-raised",
                )}
              >
                <span
                  className={cn(
                    "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                    bot.chiefOfStaff ? "left-[21px]" : "left-[3px]",
                  )}
                />
              </button>
            </div>
            <div className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
              {bot.chiefOfStaff && !canCoordinate
                ? "This bot still holds the role, but its current engine cannot contact teammates. Choose a Claude or ACP engine to restore coordination."
                : bot.chiefOfStaff
                  ? "This is your primary contact. It can coordinate the other bots and combine their work into one answer."
                : !canCoordinate
                  ? "Choose a Claude or ACP engine to let this bot coordinate teammates."
                  : currentChief
                    ? `Make this bot your primary contact and hand the role over from ${currentChief.name}.`
                    : "Make this bot your primary contact for work that may involve several bots."}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Ask me before contacting other bots
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.approvePeerComms
                  ? "This bot will stop and ask before it reaches out to another bot."
                  : "Let this bot talk to teammates on its own, without a confirmation step."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={Boolean(bot.approvePeerComms)}
              aria-label="Ask me before contacting other bots"
              disabled={!bot.approvePeerComms && !canCoordinate}
              onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
              title={!bot.approvePeerComms && !canCoordinate ? "This engine cannot contact other bots" : undefined}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                bot.approvePeerComms ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.approvePeerComms ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          <SkillsCard key={bot.id} bot={bot} catalog={state.skills} />
          <RuntimeControlsCard key={`runtime-${bot.id}`} bot={bot} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Connected apps</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!connectedAppsConfigured
                  ? "Connect apps in App Settings before giving this bot access."
                  : !canUseConnectedApps
                    ? "This bot's current engine cannot use connected apps."
                    : connectedAppsEnabled
                      ? "Let this bot use your connected Gmail, Calendar, Slack, and other apps."
                      : "Keep your connected apps unavailable to this bot."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={connectedAppsEnabled}
              aria-label="Allow this bot to use connected apps"
              disabled={
                !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
              }
              onClick={() => patch({ composio: !connectedAppsEnabled })}
              title={
                !connectedAppsEnabled && !connectedAppsConfigured
                  ? "Connect apps in App Settings first"
                  : !connectedAppsEnabled && !canUseConnectedApps
                    ? "This engine cannot use connected apps"
                    : undefined
              }
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                connectedAppsEnabled ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  connectedAppsEnabled ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Model</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Which provider and model this bot runs on
              </div>
            </div>
            <ModelPicker bot={bot} />
          </div>

          {!!engine?.capabilities?.effortLevels?.length && (
            <div className="rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">Effort</div>
              {/* Says what the app does, not what the engine ends up at:
                  Codex applies a level to the whole thread and has no way to
                  take one back, so "currently: engine default" was a promise
                  we could not keep for a thread that had already been sent
                  one. Sending nothing is true on every engine. */}
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                How hard this bot thinks{bot.modelSelection.effort ? "" : " (Default: no level is sent)"}
              </div>
              <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
                {([undefined, ...engine.capabilities.effortLevels] as const).map((level, i) => (
                  <button
                    key={level ?? "default"}
                    aria-pressed={bot.modelSelection.effort === level}
                    onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })}
                    className={cn(
                      "flex-1 py-1.5 text-[13px] capitalize",
                      i > 0 && "border-l border-hairline/40",
                      bot.modelSelection.effort === level
                        ? "bg-raised text-ink"
                        : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                    )}
                  >
                    {/* the others capitalize cleanly; "xhigh" would read "Xhigh" */}
                    {level === "xhigh" ? "X-High" : (level ?? "Default")}
                  </button>
                ))}
              </div>
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
                  onClick={() =>
                    patch(mode === "local" ? { computer: mode, autoApprove: false } : { computer: mode })
                  }
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    mode === "local" && !localSelectable && "cursor-not-allowed opacity-40",
                    bot.computer === mode
                      ? "bg-raised text-ink"
                      : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {(!bot.computer || bot.computer === "cloud") && (
              <CloudBackendPicker
                value={bot.cloudBackend ?? "box"}
                vpsSupported={canUseVps}
                onChange={(backend) => patch({ cloudBackend: backend })}
              />
            )}
          </div>

          <BotUsageCard bot={bot} />
          <WorkingFolder bot={bot} />

          {/* keyed so switching bots never shows one bot's notes under another's name */}
          <MemoryCard key={bot.id} bot={bot} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Auto mode</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.computer === "local"
                  ? "Local computer actions always require your approval in this beta."
                  : bot.autoApprove
                  ? "Keeps going on its own — you'll still be asked about anything destructive, and about questions it asks you."
                  : "Approve each action yourself. Turn on to let this bot keep working without stopping to ask."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={Boolean(bot.autoApprove)}
              aria-label="Auto mode"
              disabled={bot.computer === "local"}
              onClick={() => patch({ autoApprove: !bot.autoApprove })}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.computer === "local" && "cursor-not-allowed opacity-40",
                bot.autoApprove ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.autoApprove ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          {state.config?.tts?.configured && (
            <div className="rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">Bot voice</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Use a distinct voice for calls and spoken replies, or inherit the app default
              </div>
              <select
                value={bot.voice ?? ""}
                onChange={(e) => patch({ voice: e.target.value })}
                aria-label={`${bot.name}'s voice`}
                className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
              >
                <option value="">App default</option>
                {bot.voice && !voices.some((voice) => voice.id === bot.voice) && (
                  <option value={bot.voice}>Current bot voice</option>
                )}
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}{voice.description ? ` — ${voice.description}` : ""}
                  </option>
                ))}
              </select>
              {voicesLoading && <div className="mt-1.5 text-[11.5px] text-ink-secondary">Loading voices…</div>}
            </div>
          )}

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Read replies aloud</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Speak this bot's answers as they arrive, even when you're in another chat
              </div>
            </div>
            <button
              role="switch"
              aria-checked={Boolean(bot.speakReplies)}
              aria-label="Read this bot's replies aloud"
              onClick={() => patch({ speakReplies: !bot.speakReplies })}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.speakReplies ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.speakReplies ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Notifications
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Get notified when this agent finishes or needs input
              </div>
            </div>
            <button
              role="switch"
              aria-checked={bot.notifications}
              onClick={() => {
                const enabled = !bot.notifications;
                if (enabled) void requestNotificationPermission();
                patch({ notifications: enabled });
              }}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.notifications ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.notifications ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
