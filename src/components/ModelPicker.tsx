// Compact model picker: providers live on a Cloud/Local rail. Ready engines
// show a short suggested list with search and an explicit all-models view;
// engines that need setup show one focused action instead of a disabled wall.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { api, useStore, type AntigravityAccountStatus, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { filterCustomModels, isOpenMausEndpointModel, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { isCustomOnly, splitEngineRail } from "@/lib/engine-rail";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, engineUnavailable, needsCli, needsSignIn } from "./EngineSetup";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { cn } from "@/lib/cn";
import { COMPACT_SQUARE } from "@/lib/compact-chip";

type ModelOption = InstanceInfo["models"]["options"][number];
const COMPACT_MODEL_COUNT = 5;
const OPENMAUS_RAIL_ID = "__openmaus_endpoints__";

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

function engineStatus(instance: InstanceInfo): string {
  if (needsCli(instance)) return "Not installed";
  if (engineUnavailable(instance)) return "Unavailable";
  if (needsSignIn(instance)) return "Sign-in required";
  return instance.snapshot.version ?? "Ready";
}

const RUNTIME_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

export function accountDisplayLabel(account: AntigravityAccountStatus): string {
  const candidate = account.email?.trim();
  return candidate && RUNTIME_EMAIL_RE.test(candidate)
    ? candidate
    : `Worker ${account.profile.toUpperCase()} account`;
}

export function AntigravityAccountCards({
  accounts,
  selectedInstanceId,
  selectedBotInstanceId,
  busy,
  onRefresh,
}: {
  accounts: AntigravityAccountStatus[];
  selectedInstanceId: string;
  selectedBotInstanceId: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  const account = accounts.find((candidate) => candidate.instanceId === selectedInstanceId);
  if (!account) return null;
  const quota = account.quota?.gemini;
  const value = (window: { remaining: number; resetsAt: string | null } | null | undefined) =>
    window && typeof window.remaining === "number" ? `${window.remaining}%` : "—";
  return (
    <div
      data-testid={`antigravity-quota-card-${account.instanceId}`}
      className="mt-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[11px]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-ink">{accountDisplayLabel(account)}</span>
        <span className={cn("text-[10px]", selectedBotInstanceId === account.instanceId ? "text-success font-medium" : "text-ink-secondary")}>
          {selectedBotInstanceId === account.instanceId ? "Selected for bot" : "Select model"}
        </span>
      </div>
      {account.quotaStale && (
        <div className="mt-1 text-warning">Refresh failed · showing last good</div>
      )}
      <div className="mt-2 flex items-center gap-4 text-[11px] text-ink">
        <span>Weekly: <b>{value(quota?.weekly)}</b></span>
        <span>5-hour: <b>{value(quota?.fiveHour)}</b></span>
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-hairline/20 pt-1.5 text-[10px] text-ink-secondary">
        <span>Profile {account.profile.toUpperCase()}</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          title="Refresh account quota"
          aria-label="Refresh account quota"
        >
          <RefreshCw size={11} className={busy ? "animate-spin" : undefined} />
          <span>Refresh quota</span>
        </button>
      </div>
    </div>
  );
}

export function ModelPickerRailButton({
  instance,
  iconKind = instance.driverKind,
  selected,
  attention,
  disabled,
  onSelect,
}: {
  instance: InstanceInfo;
  iconKind?: InstanceInfo["driverKind"] | "openmaus";
  selected: boolean;
  attention: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      key={`${iconKind}:${instance.instanceId}`}
      onClick={onSelect}
      disabled={disabled}
      aria-label={iconKind === "openmaus" ? "OpenMaus API" : instance.displayName}
      aria-pressed={selected}
      title={`${iconKind === "openmaus" ? "OpenMaus API" : instance.displayName} · ${engineStatus(instance)}`}
      data-testid={`model-picker-rail-${instance.instanceId}`}
      className={cn(
        "relative flex size-9 items-center justify-center rounded-lg",
        selected ? "bg-control ring-1 ring-hairline/50" : "hover:bg-control/60",
      )}
    >
      <ProviderMark driverKind={iconKind} size={18} />
      {attention && (
        <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-panel" />
      )}
    </button>
  );
}

function ModelRow({
  option,
  current,
  defaultId,
  onPick,
}: {
  option: ModelOption;
  current: boolean;
  defaultId: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-control/60",
        current && "bg-control",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{option.label}</span>
        {option.id === defaultId && (
          <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary">Default</span>
        )}
        {option.loaded && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[10px] text-accent">Loaded</span>
        )}
      </span>
      {current && <Check size={14} className="shrink-0 text-accent" />}
    </button>
  );
}

function ModelSearch({
  value,
  onChange,
  onEscape,
  local,
}: {
  value: string;
  onChange: (value: string) => void;
  onEscape: () => void;
  local: boolean;
}) {
  return (
    <div className="shrink-0 px-2 pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-accent/60">
        <Search size={13} className="shrink-0 text-ink-secondary" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            onEscape();
          }}
          placeholder="Search models"
          aria-label={local ? "Search local models" : "Search models"}
          className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
    </div>
  );
}

/** Render model selection, Antigravity account status, and network controls. */
export function ModelPicker({
  bot,
  className,
  contained = false,
  label,
}: {
  bot: Bot;
  className?: string;
  /** Expand the menu in-flow under the trigger so it cannot overflow a
   * narrow parent (the Agent profile sidebar). */
  contained?: boolean;
  label?: ReactNode;
}) {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [agyAccounts, setAgyAccounts] = useState<AntigravityAccountStatus[]>([]);
  const [agyBusy, setAgyBusy] = useState(false);
  const [agyError, setAgyError] = useState<string | null>(null);
  const [agyNotice, setAgyNotice] = useState<string | null>(null);
  const [agyProxyDraft, setAgyProxyDraft] = useState("http://127.0.0.1:10808");
  const [agyProxySaving, setAgyProxySaving] = useState(false);
  const [agyProxyError, setAgyProxyError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const railInstance =
    state.instances.find((instance) => instance.instanceId === (railId === OPENMAUS_RAIL_ID ? "opencodeGo" : railId ?? selection.instanceId)) ?? state.instances[0];
  const showingOpenMaus = railId === OPENMAUS_RAIL_ID;
  const antigravityProxy = state.config?.features?.antigravityProxy ?? {
    mode: "off" as const,
    url: "http://127.0.0.1:10808",
  };

  useEffect(() => {
    if (open) setAgyProxyDraft(antigravityProxy.url);
  }, [open, antigravityProxy.url]);

  useEffect(() => {
    if (!open) return;
    void refreshInstances();
    setAgyError(null);
    setAgyNotice(null);
    // Opening a model menu must stay read-only. The Antigravity CLI's `/usage`
    // command may start an interactive OAuth flow, so quota collection is never
    // triggered implicitly from the picker.
    void api("/api/antigravity/accounts")
      .then((value) => setAgyAccounts(value.accounts ?? []))
      .catch((error) => setAgyError(error instanceof Error ? error.message : String(error)));
  }, [open, refreshInstances]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const clickedNode = event.target instanceof Node ? event.target : null;
      if (!rootRef.current?.contains(clickedNode)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (query) setQuery("");
      else if (pane === "custom" && railInstance?.models.options.some((option) => !option.custom)) setPane("main");
      else setOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, pane, query, railInstance]);

  const resetList = () => {
    setQuery("");
    setShowAll(false);
  };

  const openFor = (instance: InstanceInfo | undefined) => {
    const official = instance?.models.options.filter((option) => !option.custom) ?? [];
    const selectedIsCustom = instance?.models.options.some(
      (option) => option.id === selection.model && option.custom,
    );
    setPane(selectedIsCustom || isCustomOnly(instance) || official.length === 0 ? "custom" : "main");
    resetList();
  };

  const selectRail = (instance: InstanceInfo) => {
    setRailId(instance.instanceId);
    const official = instance.models.options.filter((option) => !option.custom);
    setPane(isCustomOnly(instance) || official.length === 0 ? "custom" : "main");
    resetList();
  };

  const selectOpenMaus = () => {
    setRailId(OPENMAUS_RAIL_ID);
    setPane("custom");
    resetList();
  };

  const pick = async (instance: InstanceInfo, model: string) => {
    const account = agyAccounts.find((candidate) => candidate.instanceId === instance.instanceId);
    if (account) {
      setAgyBusy(true);
      setAgyError(null);
      try {
        const result = await api("/api/antigravity/activate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: account.profile }),
        });
        setAgyAccounts(result.accounts ?? []);
      } catch (error) {
        setAgyError(error instanceof Error ? error.message : String(error));
        setAgyBusy(false);
        return;
      }
      setAgyBusy(false);
    }
    const sameInstance = instance.instanceId === selection.instanceId;
    const nextSelection: ModelSelection = {
      instanceId: instance.instanceId,
      model,
    };
    if (sameInstance && selection.effort) nextSelection.effort = selection.effort;
    dispatch({
      type: "setModel",
      botId: bot.id,
      selection: nextSelection,
    });
    setOpen(false);
  };

  const refreshAgyQuotas = async () => {
    setAgyBusy(true);
    setAgyError(null);
    setAgyNotice(null);
    try {
      const selectedAccount = agyAccounts.find(
        (candidate) => candidate.instanceId === railInstance.instanceId,
      );
      if (!selectedAccount) throw new Error("No Antigravity account is selected.");
      const result = await api(`/api/antigravity/accounts?refresh=1&profile=${selectedAccount.profile}`);
      setAgyAccounts(result.accounts ?? []);
      if (result.refreshDeferred) {
        setAgyNotice("Worker is active. Quota will refresh automatically when its task finishes.");
      }
    } catch (error) {
      setAgyError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgyBusy(false);
    }
  };

  const saveAgyProxy = async (patch: { mode?: "off" | "tun" | "proxy"; url?: string }) => {
    if (agyProxySaving) return;
    setAgyProxySaving(true);
    setAgyProxyError(null);
    try {
      const config = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { antigravityProxy: patch } }),
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not save the Antigravity network mode.");
        return body;
      });
      dispatch({ type: "configStatus", config });
    } catch (error) {
      setAgyProxyError(error instanceof Error ? error.message : "Could not save the Antigravity network mode.");
    } finally {
      setAgyProxySaving(false);
    }
  };

  const selectAgyProxyMode = (mode: "off" | "tun" | "proxy") => {
    if (mode === antigravityProxy.mode) return;
    void saveAgyProxy(mode === "proxy"
      ? { mode, url: agyProxyDraft.trim() || antigravityProxy.url }
      : { mode });
  };

  const saveAgyProxyUrl = () => {
    if (antigravityProxy.mode !== "proxy" || agyProxyDraft.trim() === antigravityProxy.url) return;
    void saveAgyProxy({ mode: "proxy", url: agyProxyDraft });
  };

  const official = railInstance?.models.options.filter((option) => !option.custom) ?? [];
  const custom = railInstance?.models.options.filter((option) => option.custom) ?? [];
  const endpointSource = state.instances.find((instance) => instance.instanceId === "opencodeGo");
  const endpointModels = endpointSource?.models.options.filter((option) => isOpenMausEndpointModel(option.id)) ?? [];
  const visibleCustom = showingOpenMaus
    ? custom.filter((option) => isOpenMausEndpointModel(option.id))
    : custom.filter((option) => !isOpenMausEndpointModel(option.id));
  const hasOpenMausModels = endpointModels.length > 0;
  const currentModel = selection.instanceId === railInstance?.instanceId ? selection.model : undefined;
  const filteredOfficial = filterCustomModels(official, query);
  const compactOfficial = railInstance
    ? suggestedModels(official, railInstance.models.default, currentModel, COMPACT_MODEL_COUNT)
    : [];
  const shownOfficial = query ? filteredOfficial : showAll ? official : compactOfficial;
  const filteredCustom = filterCustomModels(visibleCustom, query);
  const { pinned, rest } = partitionCustomModels(filteredCustom);
  const blocked = railInstance
    ? pane === "custom"
      ? engineUnavailable(railInstance)
      : engineUnavailable(railInstance) || needsSignIn(railInstance)
    : false;
  const canOpenCustom = Boolean(railInstance && !engineUnavailable(railInstance));
  const canReturnToOfficial = official.length > 0 && !isCustomOnly(railInstance);

  const renderRow = (option: ModelOption) => (
    <ModelRow
      key={option.id}
      option={option}
      current={selection.instanceId === railInstance?.instanceId && selection.model === option.id}
      defaultId={railInstance?.models.default ?? ""}
      onPick={() => railInstance && void pick(railInstance, option.id)}
    />
  );

  const trigger = (
    <button
        type="button"
        onClick={() => {
          setRailId(selection.instanceId === "opencodeGo" && isOpenMausEndpointModel(selection.model)
            ? OPENMAUS_RAIL_ID
            : selection.instanceId);
          setOpen((wasOpen) => {
            const next = !wasOpen;
            if (next) openFor(state.instances.find((instance) => instance.instanceId === selection.instanceId));
            return next;
          });
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover",
          !contained && active && COMPACT_SQUARE,
        )}
        title={active ? `${active.displayName} · ${modelLabel(active, selection.model)}` : selection.model}
      >
        {active && <ProviderMark driverKind={selection.instanceId === "opencodeGo" && isOpenMausEndpointModel(selection.model) ? "openmaus" : active.driverKind} size={14} />}
        <span className={cn("max-w-[160px] truncate", !contained && active && "@max-4xl/chathead:hidden")}>
        {modelLabel(active, selection.model)}
        </span>
        <ChevronDown
          size={14}
          className={cn(
            "text-ink-secondary transition-transform",
            open && "rotate-180",
            !contained && active && "@max-4xl/chathead:hidden",
          )}
        />
    </button>
  );

  return (
    <div ref={rootRef} className={cn(contained ? "w-full" : "relative", className)}>
      {contained ? (
        <div className="flex items-center justify-between gap-4">
          {label}
          {trigger}
        </div>
      ) : (
        trigger
      )}

      {open && (
        <div
          data-model-picker-content
          role="dialog"
          aria-label="Choose model"
          className={cn(
            "flex overflow-hidden rounded-2xl border border-hairline/50 bg-card",
            contained
              ? "relative mt-3 w-full max-h-[min(420px,50dvh)]"
              : "absolute right-0 top-full z-30 mt-2 w-[380px] max-h-[min(480px,calc(100dvh-7rem))] shadow-2xl shadow-black/50",
          )}
        >
          <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
            {(() => {
              const { subscription, custom: local } = splitEngineRail(state.instances);
              const railButton = (instance: InstanceInfo, iconKind = instance.driverKind) => {
                const selected = iconKind === "openmaus"
                  ? showingOpenMaus
                  : !showingOpenMaus && instance.instanceId === railInstance?.instanceId;
                const attention = engineUnavailable(instance) || needsSignIn(instance);
                return (
                  <ModelPickerRailButton
                    instance={instance}
                    iconKind={iconKind}
                    selected={selected}
                    attention={attention}
                    disabled={agyBusy}
                    onSelect={() => iconKind === "openmaus" ? selectOpenMaus() : selectRail(instance)}
                  />
                );
              };
              return (
                <>
                  {subscription.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-0.5 text-center text-[9px]">Cloud</EngineGroupLabel>
                  )}
                  {subscription.map((instance) => railButton(instance))}
                  {hasOpenMausModels && endpointSource && railButton(endpointSource, "openmaus")}
                  {local.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px]">Local</EngineGroupLabel>
                  )}
                  {local.map((instance) => railButton(instance))}
                </>
              );
            })()}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {railInstance ? (
              <>
                <div className="shrink-0 px-4 pb-2 pt-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[14px] font-semibold text-ink">{showingOpenMaus ? "OpenMaus API" : railInstance.displayName}</div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                        blocked ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
                      )}
                    >
                      {showingOpenMaus && !blocked ? "API models" : pane === "custom" && !blocked ? "Local models" : engineStatus(railInstance)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    {showingOpenMaus
                      ? "Models discovered from your configured API keys."
                      : pane === "custom"
                        ? "Run this agent with a model already on your machine."
                        : "Choose a model for this bot."}
                  </div>
                  <AntigravityAccountCards
                    accounts={agyAccounts}
                    selectedInstanceId={railInstance.instanceId}
                    selectedBotInstanceId={selection.instanceId}
                    busy={agyBusy}
                    onRefresh={() => void refreshAgyQuotas()}
                  />
                  {agyError && railInstance.driverKind === "antigravityAgent" && (
                    <div className="mt-2 text-[10.5px] text-warning">{agyError}</div>
                  )}
                  {agyNotice && railInstance.driverKind === "antigravityAgent" && (
                    <div className="mt-2 text-[10.5px] text-ink-secondary">{agyNotice}</div>
                  )}
                  {railInstance.driverKind === "antigravityAgent" && (
                    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset px-2.5 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[12px] font-medium text-ink">VPN mode</div>
                        <div role="radiogroup" aria-label="VPN mode" className="flex rounded-md bg-card p-0.5">
                          {[
                            { label: "Off", mode: "off" as const },
                            { label: "TUN", mode: "tun" as const },
                            { label: "Proxy", mode: "proxy" as const },
                          ].map((mode) => (
                            <button
                              key={mode.label}
                              type="button"
                              role="radio"
                              aria-checked={antigravityProxy.mode === mode.mode}
                              disabled={agyProxySaving}
                              onClick={() => selectAgyProxyMode(mode.mode)}
                              className={cn(
                                "rounded px-2 py-1 text-[10.5px] font-medium transition-colors",
                                antigravityProxy.mode === mode.mode
                                  ? "bg-control text-ink"
                                  : "text-ink-secondary hover:text-ink",
                                agyProxySaving && "cursor-wait opacity-50",
                              )}
                            >
                              {mode.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {antigravityProxy.mode === "proxy" && (
                        <label className="mt-2 block text-[10.5px] text-ink-secondary">
                          Proxy URL
                          <input
                            type="url"
                            value={agyProxyDraft}
                            onChange={(event) => setAgyProxyDraft(event.target.value)}
                            onBlur={saveAgyProxyUrl}
                            disabled={agyProxySaving}
                            placeholder="http://127.0.0.1:10808"
                            aria-label="Proxy URL"
                            className="mt-1 w-full rounded-md border border-hairline/40 bg-card px-2 py-1.5 text-[11.5px] text-ink placeholder:text-ink-secondary focus:border-accent/60 focus:outline-none disabled:opacity-50"
                          />
                        </label>
                      )}
                      {agyProxyError && <div className="mt-1.5 text-[10.5px] text-warning">{agyProxyError}</div>}
                    </div>
                  )}
                </div>

                {pane === "custom" && canReturnToOfficial && (
                  <button
                    type="button"
                    onClick={() => {
                      setRailId(railInstance.instanceId);
                      setPane("main");
                      resetList();
                    }}
                    className="mx-2 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-control/60"
                  >
                    <ChevronLeft size={13} /> Back to {railInstance.displayName} models
                  </button>
                )}

                {blocked ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
                    <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} />
                    <p className="mt-2 text-center text-[11.5px] text-ink-secondary/70">
                      {pane === "main" && official.length > 0
                        ? `${official.length} ${official.length === 1 ? "model" : "models"} will appear after setup.`
                        : "Local models will appear as soon as the agent is installed."}
                    </p>
                  </div>
                ) : (
                  <>
                    {((pane === "main" && official.length > COMPACT_MODEL_COUNT) ||
                      (pane === "custom" && visibleCustom.length > COMPACT_MODEL_COUNT)) && (
                      <ModelSearch
                        value={query}
                        local={pane === "custom"}
                        onChange={(value) => {
                          setQuery(value);
                          if (value) setShowAll(true);
                        }}
                        onEscape={() => {
                          if (query) setQuery("");
                          else if (pane === "custom" && canReturnToOfficial) setPane("main");
                        }}
                      />
                    )}

                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                      {pane === "main" ? (
                        <>
                          <EngineGroupLabel className="px-2 pb-1 pt-0.5">
                            {query ? `${filteredOfficial.length} results` : showAll ? `All models · ${official.length}` : "Suggested"}
                          </EngineGroupLabel>
                          {shownOfficial.map(renderRow)}
                          {shownOfficial.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              Nothing matches “{query.trim()}”
                            </div>
                          )}
                          {!query && !showAll && official.length > compactOfficial.length && (
                            <button
                              type="button"
                              onClick={() => setShowAll(true)}
                              className="mt-1 flex w-full items-center justify-between rounded-lg border-t border-hairline/40 px-2.5 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              Show all {official.length} models <ChevronDown size={13} />
                            </button>
                          )}
                          {!query && showAll && official.length > COMPACT_MODEL_COUNT && (
                            <button
                              type="button"
                              onClick={() => setShowAll(false)}
                              className="mt-1 w-full rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              Show suggested only
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {pinned.length > 0 && (
                            <EngineGroupLabel className="px-2 pb-1 pt-0.5">Loaded now</EngineGroupLabel>
                          )}
                          {pinned.map(renderRow)}
                          {pinned.length > 0 && rest.length > 0 && (
                            <div className="mx-2 my-2 border-t border-hairline/40" role="separator" />
                          )}
                          {rest.map(renderRow)}
                          {visibleCustom.length === 0 && (
                            <div className="mx-1 rounded-xl border border-dashed border-hairline/50 px-3 py-5 text-center">
                              <div className="text-[12.5px] font-medium text-ink">{showingOpenMaus ? "No API models found" : "No local models found"}</div>
                              <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                                {showingOpenMaus ? "Add and test an endpoint in Settings → Connections." : "Start oMLX, Ollama, Unsloth, LM Studio, or EXO, then reopen this picker."}
                              </div>
                            </div>
                          )}
                          {visibleCustom.length > 0 && filteredCustom.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              Nothing matches “{query.trim()}”
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}

                {pane === "main" && (
                  <button
                    type="button"
                    aria-label={
                      visibleCustom.length > 0 ? `${showingOpenMaus ? "OpenMaus API models" : "Use a local model"} (${visibleCustom.length} available)` : "Use a local model"
                    }
                    disabled={!canOpenCustom}
                    onClick={() => {
                      setPane("custom");
                      resetList();
                    }}
                    className="flex w-full shrink-0 items-center justify-between gap-2 border-t border-hairline/40 px-4 py-3 text-left text-[12.5px] font-medium text-ink hover:bg-control/60 disabled:cursor-not-allowed disabled:text-ink-secondary/40 disabled:hover:bg-transparent"
                  >
                    <span>{showingOpenMaus ? "OpenMaus API models" : "Use a local model"}</span>
                    <span className="flex items-center gap-2">
                      {visibleCustom.length > 0 && (
                        <span className="rounded-full bg-inset px-2 py-0.5 text-[10.5px] text-ink-secondary">
                          {visibleCustom.length} available
                        </span>
                      )}
                      <ChevronRight size={14} className="text-ink-secondary" />
                    </span>
                  </button>
                )}
              </>
            ) : (
              <div className="px-4 py-5 text-[13px] text-ink-secondary">No model providers are available.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
