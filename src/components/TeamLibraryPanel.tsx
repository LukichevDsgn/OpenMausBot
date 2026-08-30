import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { isGrokRecipeFile, teamImportPreview, type PendingTeamImport } from "@/lib/team-import";
import {
  buildExportRequest,
  buildExportScopeOptions,
  downloadExportPackage,
  type ExportScopeOption,
} from "@/lib/team-files";
import type { Routine } from "@/lib/routines";
import { api, useStore, type Bot, type Group, type SkillCatalogEntry } from "@/state/store";
import type { BotShare, BotShareVisibility, CompanionAccountState } from "@/types/ogb";
import {
  ArrowLeft,
  BookOpen,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Compass,
  ExternalLink,
  FolderOpen,
  Github,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Plug,
  Search,
  Share2,
  Sparkles,
  Trash2,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { BotAvatar } from "./Avatar";

const MAX_TEAM_FILE_BYTES = 1_000_000;
const MAX_GROK_RECIPE_BYTES = 26_214_400;
const COMMUNITY_TEAMS_REPOSITORY = "https://github.com/milind-soni/openmausbot-teams";

function isGrokBotUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "grokbot:" || (url.protocol === "https:" && url.hostname === "x.ai");
  } catch {
    return false;
  }
}

interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  setupMinutes?: number;
  featured?: boolean;
  package?: string;
  manifest: string;
  readme: string;
  members: number;
  skills: string[];
  requires: { apps: string[] };
}

interface TeamCatalog {
  repositoryUrl: string;
  teams: TeamCatalogEntry[];
}

export interface ArchivedTeamBot {
  id: string;
  chiefOfStaff: boolean;
}

export interface TeamImportResult {
  name: string;
  members: number;
  importedBotIds: string[];
  importedGroupIds: string[];
  importedRoutineIds: string[];
  archived: ArchivedTeamBot[];
}

type ImportSource = "library" | "file" | "github" | "grok" | "grok-recipe" | "shared";

type TeamTab = "export" | "explore" | "import" | "scout";
type ImportMode = "replace" | "add";

interface PublishDraft {
  name: string;
  members: number;
  markdown: string;
}

function sharedPackageLink(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.origin === "https://accounts.openmausbot.com" &&
      (/^\/v1\/bot-shares\/[A-Za-z0-9_-]{21}\/package$/.test(url.pathname) ||
        /^\/s\/[A-Za-z0-9_-]{21}$/.test(url.pathname)) &&
      !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** the scout endpoint's answer, as far as this panel renders it — the
 * manifest itself stays opaque and goes back to the server verbatim */
interface ScoutResult {
  profile: { name: string; summary: string; stacks: string[] };
  suggestion: {
    roomName: string;
    manifest: {
      team: { members: Array<{ key: string; name: string; title: string; description: string; appearance: { color: string } }> };
    };
    reasons: Record<string, string>;
  };
}

interface DirectoryCandidate {
  slug: string;
  name: string;
  category: string;
  integrations: string[];
  prompt: string;
  detailUrl: string;
  matched: string[];
}

/** appearance colors for community bots folded into a scouted team */
const DIRECTORY_COLORS = ["cyan", "red", "purple", "green", "orange"] as const;

const TEAM_GLYPHS = [
  "bg-purple-500/15 text-purple-300",
  "bg-cyan-500/15 text-cyan-300",
  "bg-orange-500/15 text-orange-300",
  "bg-emerald-500/15 text-emerald-300",
] as const;

function ExportScopeDropdown({ options, bots, value, onChange, disabled }: { options: readonly ExportScopeOption[]; bots: readonly Bot[]; value?: ExportScopeOption["key"]; onChange: (option: ExportScopeOption) => void; disabled?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.key === value) ?? options[0];
  const projectOptions = options.filter((option) => option.category === "project");
  const teamOptions = options.filter((option) => option.category === "team");
  const botOptions = options.filter((option) => option.key.startsWith("bot:"));
  const broadOptions = options.filter((option) => option.key === "all");
  const flatOptions = [...projectOptions, ...teamOptions, ...botOptions, ...broadOptions];
  const selectedIndex = Math.max(0, flatOptions.findIndex((option) => option.key === selected?.key));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, selectedIndex]);

  const choose = (option: ExportScopeOption) => { onChange(option); setOpen(false); triggerRef.current?.focus(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement | HTMLDivElement>) => {
    if (!open && ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) { event.preventDefault(); setOpen(true); return; }
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => (index + 1) % flatOptions.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => (index - 1 + flatOptions.length) % flatOptions.length); }
    else if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); }
    else if (event.key === "End") { event.preventDefault(); setActiveIndex(Math.max(0, flatOptions.length - 1)); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const option = flatOptions[activeIndex]; if (option) choose(option); }
  };
  const renderSection = (label: string, sectionOptions: readonly ExportScopeOption[], offset: number) => sectionOptions.length > 0 && <div role="group" aria-label={label}>
    <div className="px-3.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{label}</div>
    {sectionOptions.map((option, index) => {
      const itemIndex = offset + index;
      const checked = option.key === selected?.key;
      return <button key={option.key} type="button" role="option" aria-selected={checked} onMouseEnter={() => setActiveIndex(itemIndex)} onClick={() => choose(option)} className={cn("flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left focus:outline-none focus-visible:bg-raised/70", itemIndex === activeIndex && "bg-raised/70")}>
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary", option.key === "all" && "text-danger")}>{option.key === "all" ? <Users size={14} /> : option.key.startsWith("bot:") ? (bots.find((bot) => bot.id === option.botIds[0]) ? <BotAvatar bot={bots.find((bot) => bot.id === option.botIds[0])!} state="idle" size={28} animated={false} /> : <Sparkles size={14} />) : <MessageSquare size={14} />}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink">{option.label}</span><span className="block truncate text-[11px] text-ink-secondary">{option.detail}</span></span>
        {checked && <Check size={15} className="shrink-0 text-accent" />}
      </button>;
    })}
  </div>;
  return <div ref={rootRef} className="relative mt-2 w-full sm:max-w-xl">
    <button ref={triggerRef} type="button" disabled={disabled || !selected} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)} onKeyDown={onKeyDown} className="flex w-full items-center gap-3 rounded-xl border border-hairline/50 bg-card px-3.5 py-3 text-left text-[13.5px] text-ink outline-none focus:border-accent disabled:opacity-50">
      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{selected?.label ?? "No export scope"}</span><span className="block truncate text-[11.5px] text-ink-secondary">{selected?.detail ?? "No active bots"}</span></span><ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
    </button>
    {open && <div role="listbox" aria-label="Export scope" tabIndex={-1} onKeyDown={onKeyDown} className="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-xl border border-hairline/50 bg-card py-1 shadow-xl">
      {renderSection("Projects", projectOptions, 0)}{renderSection("Teams & channels", teamOptions, projectOptions.length)}{renderSection("Individual bots", botOptions, projectOptions.length + teamOptions.length)}{renderSection("Other", broadOptions, projectOptions.length + teamOptions.length + botOptions.length)}
    </div>}
  </div>;
}

async function openExternal(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}

function TeamGlyph({ index }: { index: number }) {
  return (
    <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
      <Users size={20} />
    </div>
  );
}

function PendingCollectionView({ pending, view, onBack }: { pending: PendingTeamImport; view: Exclude<"rooms" | "playbooks" | "skills" | "routines" | "integrations", "details">; onBack: () => void }) {
  const titles = { rooms: "Rooms", playbooks: "Playbooks", skills: "Skills", routines: "Routines", integrations: "Integrations" } as const;
  const entries = view === "rooms" ? pending.roomEntries : view === "playbooks" ? pending.playbookEntries : view === "skills" ? pending.skillEntries : view === "routines" ? pending.routineEntries : pending.apps;
  return <div className="mx-auto max-w-3xl rounded-2xl bg-raised/20 p-5 sm:p-7">
    <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"><ArrowLeft size={15} /> Back</button>
    <h3 className="mt-6 text-[19px] font-semibold text-ink">{titles[view]}</h3>
    <div className="mt-4 space-y-3">{entries.map((entry, index) => {
      if (view === "rooms") { const item = entry as PendingTeamImport["roomEntries"][number]; return <article key={index} className="rounded-xl bg-card/60 p-4"><div className="font-medium text-ink">{item.name}</div><div className="mt-1 text-[12px] text-ink-secondary">Members: {item.members.join(", ") || "None"} · Default responder: {item.defaultResponder}</div>{item.bulletin && <p className="mt-2 whitespace-pre-wrap text-[12.5px] text-ink-secondary">Bulletin: {item.bulletin}</p>}</article>; }
      if (view === "playbooks") { const item = entry as PendingTeamImport["playbookEntries"][number]; return <article key={index} className="rounded-xl bg-card/60 p-4"><div className="font-medium text-ink">{item.name}</div><p className="mt-1 text-[12.5px] text-ink-secondary">{item.summary}</p><div className="mt-2 text-[11.5px] text-ink-secondary">Triggers: {item.triggers.join(", ") || "None"}</div><p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{item.instructions}</p></article>; }
      if (view === "skills") { const item = entry as PendingTeamImport["skillEntries"][number]; return <article key={index} className="rounded-xl bg-card/60 p-4"><div className="font-medium text-ink">{item.name || item.id}</div><div className="mt-1 text-[11.5px] text-ink-secondary">{item.id} · {item.origin || "unspecified origin"}</div><p className="mt-2 text-[12.5px] text-ink-secondary">{item.description}</p><div className="mt-2 text-[11.5px] text-ink-secondary">Capabilities: {item.capabilities.join(", ") || "None"} · Tools: {item.tools.join(", ") || "None"}</div></article>; }
      if (view === "routines") { const item = entry as PendingTeamImport["routineEntries"][number]; return <article key={index} className="rounded-xl bg-card/60 p-4"><div className="flex items-center justify-between gap-3"><div className="font-medium text-ink">{item.name}</div><span className="rounded-full bg-warning/15 px-2 py-1 text-[10.5px] text-warning">{item.status}</span></div><div className="mt-1 text-[11.5px] text-ink-secondary">Owner: {item.owner} · {item.schedule} · {item.runOn} · {item.duration}</div><p className="mt-2 whitespace-pre-wrap text-[12.5px] text-ink-secondary">{item.prompt}</p></article>; }
      const item = entry as PendingTeamImport["apps"][number]; return <article key={index} className="flex items-center justify-between gap-3 rounded-xl bg-card/60 p-4"><div><div className="font-medium text-ink">{item.label}</div><div className="mt-1 text-[12px] text-ink-secondary">{item.optional ? "Optional" : "Required"} · Connect after import</div></div><Plug size={17} className="shrink-0 text-ink-secondary" /></article>;
    })}</div>
  </div>;
}

export function TeamLibraryPanel({
  onClose,
  onImported,
  returnFocusRef,
  initialUrl,
  sidebarProjectFilter = "all",
}: {
  onClose: () => void;
  onImported: (result: TeamImportResult) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  initialUrl?: string;
  sidebarProjectFilter?: string;
}) {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<TeamTab>("export");
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTeamImport | null>(null);
  const [source, setSource] = useState<ImportSource>("file");
  const [githubUrl, setGithubUrl] = useState("");
  const [githubLoading, setGithubLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("replace");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [scoutFolder, setScoutFolder] = useState("");
  const [scouting, setScouting] = useState(false);
  const [scouted, setScouted] = useState<ScoutResult | null>(null);
  // the folder the current `scouted` result was actually read from — the
  // import must pin the room to THIS, not to whatever the input says now
  const [scoutedFolder, setScoutedFolder] = useState("");
  // null = not asked yet or still loading; [] = asked, nothing (or offline)
  const [directory, setDirectory] = useState<DirectoryCandidate[] | null>(null);
  const [pickedDirectory, setPickedDirectory] = useState<Set<string>>(new Set());
  const [roomName, setRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  const [accountState, setAccountState] = useState<CompanionAccountState | null>(null);
  const [shares, setShares] = useState<BotShare[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [shareBusy, setShareBusy] = useState("");
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [publishVisibility, setPublishVisibility] = useState<BotShareVisibility>("unlisted");
  const [scopeKey, setScopeKey] = useState<ExportScopeOption["key"] | "">("");
  const [packageName, setPackageName] = useState(() => sidebarProjectFilter !== "all" ? `${sidebarProjectFilter} package` : "My OpenMaus Team");
  const [exportSkills, setExportSkills] = useState<SkillCatalogEntry[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [exportPreview, setExportPreview] = useState<PendingTeamImport | null>(null);
  const [pendingView, setPendingView] = useState<"details" | "instructions" | "rooms" | "playbooks" | "skills" | "routines" | "integrations">("details");
  const [selectedMemberIndex, setSelectedMemberIndex] = useState(0);
  const [grokHandlerState, setGrokHandlerState] = useState<{ supported: boolean; isDefault: boolean } | null>(null);
  const [grokHandlerBusy, setGrokHandlerBusy] = useState(false);
  const [grokHandlerMessage, setGrokHandlerMessage] = useState("");
  // monotonically increasing scout token: a late response from an older
  // scout (including its lazy directory call) must never overwrite state
  // that belongs to a newer one
  const scoutRequest = useRef(0);

  const currentBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const exportScopes = useMemo(
    () => buildExportScopeOptions({ projectFilter: sidebarProjectFilter, bots: state.bots, groups: state.groups }),
    [sidebarProjectFilter, state.bots, state.groups],
  );
  const selectedScopeOption = exportScopes.find((option) => option.key === scopeKey) ?? exportScopes[0];
  const selectedBotIds = new Set(selectedScopeOption?.botIds ?? []);
  const selectedBots = state.bots.filter((bot) => selectedBotIds.has(bot.id) && !bot.hidden);
  const selectedGroupIds = selectedScopeOption?.scope === "all"
    ? state.groups.filter((group) => !group.dm && group.memberIds.some((id) => selectedBotIds.has(id))).map((group) => group.id)
    : selectedScopeOption?.scope.groupIds ?? [];
  const selectedGroups = state.groups.filter((group) => selectedGroupIds.includes(group.id));
  const selectedRoutineCount = state.routines.filter((routine) => selectedBotIds.has(routine.botId)).length;

  useEffect(() => {
    if (selectedScopeOption && selectedScopeOption.key !== scopeKey) setScopeKey(selectedScopeOption.key);
  }, [scopeKey, selectedScopeOption]);

  useEffect(() => {
    if (!selectedScopeOption) {
      setExportSkills([]);
      setSelectedSkillIds([]);
      return;
    }
    let alive = true;
    setShareBusy("options");
    api("/api/teams/export/options", {
      method: "POST",
      body: JSON.stringify({ scope: selectedScopeOption.scope }),
    })
      .then((response) => {
        if (!alive) return;
        // SAFETY: api() returns the app-owned response for /api/teams/export/options.
        const next = (response as { skills?: SkillCatalogEntry[]; defaultSelectedSkillIds?: string[] });
        const skills = Array.isArray(next.skills) ? next.skills : [];
        setExportSkills(skills);
        setSelectedSkillIds(Array.isArray(next.defaultSelectedSkillIds) ? next.defaultSelectedSkillIds : []);
        setPublishDraft(null);
        setExportPreview(null);
      })
      .catch((cause) => {
        if (!alive) return;
        setExportSkills([]);
        setSelectedSkillIds([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setShareBusy("");
      });
    return () => {
      alive = false;
    };
  }, [selectedScopeOption]);

  const loadShareAccount = useCallback(async () => {
    const bridge = window.ogb;
    if (!bridge?.companionAccount || !bridge.botShares) {
      setAccountState(null);
      setShares([]);
      return;
    }
    const nextAccount = await bridge.companionAccount.state();
    setAccountState(nextAccount);
    if (!nextAccount.email) {
      setShares([]);
      return;
    }
    setSharesLoading(true);
    try {
      setShares(await bridge.botShares.list());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSharesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "export") void loadShareAccount();
  }, [loadShareAccount, tab]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns TeamCatalog.
      setCatalog((await api("/api/team-library/catalog")) as TeamCatalog);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !importing) {
        event.preventDefault();
        event.stopPropagation();
        if (pending) setPending(null);
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!dialog || items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [importing, onClose, pending]);

  const previewManifest = (preview: PendingTeamImport, nextSource: ImportSource) => {
    setPending(preview);
    setPendingView("details");
    setSelectedMemberIndex(0);
    setSource(nextSource);
    setImportMode(currentBotCount > 0 ? "replace" : "add");
    setError("");
  };

  const readFile = async (file: File) => {
    if (file.size > MAX_GROK_RECIPE_BYTES) throw new Error("That team file is too large.");
    const raw = await file.text();
    let manifest: unknown = raw;
    if (!file.name.toLowerCase().endsWith(".md")) {
      try {
        manifest = JSON.parse(raw);
      } catch (cause) {
        if (cause instanceof SyntaxError) throw new Error("That legacy team file is not valid JSON.");
        throw cause;
      }
      if (isGrokRecipeFile(manifest)) {
        const normalized = await api("/api/team-library/grok", {
          method: "POST",
          body: JSON.stringify(manifest),
        });
        previewManifest(teamImportPreview(normalized), "grok-recipe");
        return;
      }
    }
    if (file.size > MAX_TEAM_FILE_BYTES) throw new Error("That team file is too large.");
    previewManifest(teamImportPreview(manifest), "file");
  };

  const loadLibraryTeam = async (entry: TeamCatalogEntry) => {
    setBusySlug(entry.slug);
    setError("");
    try {
      previewManifest(teamImportPreview(await api(`/api/team-library/teams/${entry.slug}`)), "library");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySlug(null);
    }
  };

  const loadGithubTeam = async () => {
    await loadGithubUrl(githubUrl);
  };

  const loadGithubUrl = async (requestedUrl: string) => {
    if (!requestedUrl.trim()) return;
    setGithubLoading(true);
    setError("");
    try {
      const shared = sharedPackageLink(requestedUrl);
      const grok = isGrokBotUrl(requestedUrl);
      const endpoint = shared
        ? "/api/team-library/shared"
        : grok
          ? "/api/team-library/grok"
          : "/api/team-library/github";
      const manifest = await api(endpoint, {
        method: "POST",
        body: JSON.stringify({ url: requestedUrl.trim() }),
      });
      previewManifest(teamImportPreview(manifest), shared ? "shared" : grok ? "grok" : "github");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubLoading(false);
    }
  };

  useEffect(() => {
    if (!initialUrl) return;
    setTab("import");
    setGithubUrl(initialUrl);
    void loadGithubUrl(initialUrl);
    // A deep link is immutable for this panel instance; reloading it on
    // every callback identity change would duplicate the preview request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  useEffect(() => {
    if (tab !== "import" || !window.ogb?.grokBotLinkHandler) return;
    let alive = true;
    window.ogb.grokBotLinkHandler.status()
      .then((state) => {
        if (alive) setGrokHandlerState(state);
      })
      .catch(() => {
        if (alive) setGrokHandlerState({ supported: false, isDefault: false });
      });
    return () => {
      alive = false;
    };
  }, [tab]);

  const enableGrokBotLinkHandler = async () => {
    const bridge = window.ogb?.grokBotLinkHandler;
    if (!bridge) return;
    setGrokHandlerBusy(true);
    setGrokHandlerMessage("");
    try {
      const state = await bridge.enable();
      setGrokHandlerState(state);
      setGrokHandlerMessage(
        state.isDefault && state.registrationSucceeded
          ? "OpenMaus is now the current handler for Grok Bot links."
          : "Windows did not change the current handler. Choose OpenMaus in Default Apps and try again.",
      );
    } catch {
      setGrokHandlerMessage("Windows did not change the current handler. Choose OpenMaus in Default Apps and try again.");
    } finally {
      setGrokHandlerBusy(false);
    }
  };

  const importTeam = async () => {
    if (!pending) return;
    setImporting(true);
    setError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns imported bots.
      const response = (await api(`/api/teams/import?mode=${importMode}`, {
        method: "POST",
        body: JSON.stringify(pending.manifest),
      })) as {
        bots: Bot[];
        groups?: Group[];
        routines?: Routine[];
        archivedBots?: Bot[];
        archived?: ArchivedTeamBot[];
      };
      for (const bot of response.archivedBots ?? []) dispatch({ type: "botPatched", bot });
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
      for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
      const first = response.bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      track("team_imported", { members: response.bots.length, source, mode: importMode });
      onImported({
        name: pending.name,
        members: response.bots.length,
        importedBotIds: response.bots.map((bot) => bot.id),
        importedGroupIds: (response.groups ?? []).map((group) => group.id),
        importedRoutineIds: (response.routines ?? []).map((routine) => routine.id),
        archived: response.archived ?? [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  const createExportDraft = async (download: boolean): Promise<PublishDraft> => {
    if (!selectedScopeOption) throw new Error("Choose at least one active bot to export.");
    setShareBusy(download ? "export" : "publish");
    setError("");
    try {
      const request = buildExportRequest(packageName, selectedScopeOption.scope, selectedSkillIds);
      // SAFETY: api() returns the app-owned package export response.
      const exported = (await api("/api/teams/export", {
        method: "POST",
        body: JSON.stringify(request),
      })) as PublishDraft;
      const preview = teamImportPreview(exported.markdown);
      setExportPreview(preview);
      setPublishDraft(exported);
      if (download) downloadExportPackage(exported);
      return exported;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
    } finally {
      setShareBusy("");
    }
  };

  const publishNewShare = async () => {
    if (!window.ogb?.botShares) return;
    setShareBusy("new");
    setError("");
    try {
      const draft = publishDraft ?? await createExportDraft(false);
      const created = await window.ogb.botShares.create({
        packageMarkdown: draft.markdown,
        visibility: publishVisibility,
      });
      setShares((current) => [created, ...current.filter((share) => share.id !== created.id)]);
      track("team_shared", { version: created.activeVersion, visibility: created.visibility });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShareBusy("");
    }
  };

  const publishShareVersion = async (share: BotShare) => {
    if (!window.ogb?.botShares) return;
    setShareBusy(`version:${share.id}`);
    setError("");
    try {
      const draft = publishDraft ?? await createExportDraft(false);
      const updated = await window.ogb.botShares.update(share.id, {
        packageMarkdown: draft.markdown,
        expectedActiveVersion: share.activeVersion,
      });
      setShares((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await loadShareAccount();
    } finally {
      setShareBusy("");
    }
  };

  const changeShareVisibility = async (share: BotShare) => {
    if (!window.ogb?.botShares) return;
    const visibility: BotShareVisibility = share.visibility === "unlisted" ? "private" : "unlisted";
    setShareBusy(`visibility:${share.id}`);
    setError("");
    try {
      const updated = await window.ogb.botShares.setVisibility(share.id, visibility);
      setShares((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShareBusy("");
    }
  };

  const deleteShare = async (share: BotShare) => {
    if (!window.ogb?.botShares || !window.confirm(`Delete the shared link for “${share.name}”?`)) return;
    setShareBusy(`delete:${share.id}`);
    setError("");
    try {
      await window.ogb.botShares.delete(share.id);
      setShares((current) => current.filter((item) => item.id !== share.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShareBusy("");
    }
  };

  const copyShareLink = async (share: BotShare) => {
    try {
      await navigator.clipboard.writeText(share.shareUrl);
    } catch {
      setError("The share link could not be copied.");
    }
  };

  const scoutTarget = scoutFolder.trim();

  const runScout = async (folder: string) => {
    const request = ++scoutRequest.current;
    setScouting(true);
    setError("");
    setScouted(null);
    setDirectory(null);
    setPickedDirectory(new Set());
    try {
      // SAFETY: this endpoint is owned by the app and returns ScoutResult.
      const result = (await api(`/api/teams/scout?cwd=${encodeURIComponent(folder)}`)) as ScoutResult;
      if (request !== scoutRequest.current) return;
      setScouted(result);
      setScoutedFolder(folder);
      setRoomName(result.suggestion.roomName);
      track("team_scouted", { signals: result.suggestion.manifest.team.members.length - 1 });
      // community candidates arrive lazily; an unreachable directory just
      // leaves this section empty
      void api(`/api/teams/scout/directory?cwd=${encodeURIComponent(folder)}`)
        // SAFETY: this endpoint is owned by the app and returns candidates.
        .then((extra) => {
          if (request === scoutRequest.current) setDirectory((extra as { directory: DirectoryCandidate[] }).directory);
        })
        .catch(() => {
          if (request === scoutRequest.current) setDirectory([]);
        });
    } catch (cause) {
      if (request !== scoutRequest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === scoutRequest.current) setScouting(false);
    }
  };

  const pickScoutFolder = async () => {
    const chosen = await window.ogb?.pickFolder?.(scoutTarget || undefined);
    if (!chosen) return;
    setScoutFolder(chosen);
    await runScout(chosen);
  };

  const createProject = async () => {
    if (!scouted || creating) return;
    setCreating(true);
    setError("");
    try {
      // the confirmed suggestion, plus any community bots the user ticked —
      // folded in as ordinary manifest members so the import boundary
      // (persona only, no grants) applies to them like to everything else
      const extras = (directory ?? [])
        .filter((candidate) => pickedDirectory.has(candidate.slug))
        .map((candidate, index) => ({
          key: `dir-${candidate.slug}`,
          name: candidate.name,
          title: candidate.category || "Community bot",
          description: candidate.prompt,
          appearance: { color: DIRECTORY_COLORS[index % DIRECTORY_COLORS.length] },
        }));
      const manifest = {
        ...scouted.suggestion.manifest,
        team: {
          ...scouted.suggestion.manifest.team,
          members: [...scouted.suggestion.manifest.team.members, ...extras],
        },
      };
      const room = roomName.trim() || scouted.suggestion.roomName;
      // SAFETY: this endpoint is owned by the app and returns imported bots.
      const response = (await api(
        `/api/teams/import?mode=project&cwd=${encodeURIComponent(scoutedFolder)}&room=${encodeURIComponent(room)}`,
        { method: "POST", body: JSON.stringify(manifest) },
      )) as { bots: Bot[]; group?: Group };
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      if (response.group) {
        // upsert now instead of waiting for the SSE frame, then land in the room
        dispatch({ type: "groupPatched", group: { ...response.group, messages: [] } });
        dispatch({ type: "select", id: response.group.id });
      }
      track("team_imported", { members: response.bots.length, source: "scout", mode: "project" });
      onImported({
        name: room,
        members: response.bots.length,
        importedBotIds: response.bots.map((bot) => bot.id),
        importedGroupIds: response.group ? [response.group.id] : [],
        importedRoutineIds: [],
        archived: [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const visibleTeams = (catalog?.teams ?? []).filter((entry) => {
    if (!normalizedSearch) return true;
    return `${entry.name} ${entry.summary} ${entry.category} ${entry.skills.join(" ")} ${entry.requires.apps.join(" ")}`
      .toLowerCase()
      .includes(normalizedSearch);
  });
  const selectedMember = pending?.members[Math.min(selectedMemberIndex, Math.max(0, (pending?.members.length ?? 1) - 1))] ?? pending?.members[0];
  const selectedPreviewBot = selectedMember
    ? {
        name: selectedMember.name,
        color: selectedMember.appearance?.color ?? "green",
        avatarDefinition: selectedMember.appearance?.avatarDefinition,
      }
    : null;
  const publicProfileOnly = source === "grok";
  const detailRows = publicProfileOnly
    ? ([
        ["skills", Sparkles, "Skills", "Not included in this public profile", 0],
        ["routines", CalendarClock, "Routines", "Not included in this public profile", 0],
        ["integrations", Plug, "Plugins", "Not included in this public profile", 0],
      ] as const)
    : ([
        ["skills", Sparkles, "Skills", "Portable skills included in this package", pending?.skillEntries.length ?? 0],
        ["routines", CalendarClock, "Routines", "Imported paused for your review", pending?.routineEntries.length ?? 0],
        ["integrations", Plug, "Integrations", "Connection setup only, no credentials", pending?.apps.length ?? 0],
      ] as const);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !importing && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-library-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(780px,calc(100dvh-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {pending && (
                <button
                  onClick={() => {
                    if (pendingView !== "details") {
                      setPendingView("details");
                    } else {
                      setPending(null);
                      setError("");
                    }
                  }}
                  disabled={importing}
                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  aria-label={pendingView !== "details" ? "Back to details" : "Back to teams"}
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <h2 id="team-library-title" className="truncate text-[22px] font-semibold tracking-[-0.01em] text-ink">
                {pending
                  ? pendingView === "instructions"
                    ? "Instructions"
                    : pending.members.length === 1
                      ? "Bot details"
                      : "Team details"
                  : "Teams"}
              </h2>
              {pending && publicProfileOnly && (
                <span className="shrink-0 rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent">
                  Public profile only
                </span>
              )}
            </div>
            <p className={cn("mt-1 text-[13px] text-ink-secondary", pending && "ml-9")}>
              {pending
                ? pendingView === "instructions"
                  ? selectedMember?.name ?? pending.name
                  : `${pending.name} · ${pending.members.length} ${pending.members.length === 1 ? "bot" : "bots"}`
                : "Start with a complete playbook or bring your own."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!pending && (
              <button
                onClick={() => void openExternal(catalog?.repositoryUrl ?? COMMUNITY_TEAMS_REPOSITORY)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
                title="Open the community teams repository"
              >
                <Github size={16} />
                <span className="max-sm:hidden">Community repo</span>
                <ExternalLink size={12} />
              </button>
            )}
            <button
              onClick={onClose}
              disabled={importing}
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label="Close teams"
            >
              <X size={21} />
            </button>
          </div>
        </header>

        {pending ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6 sm:px-8">
              {pendingView === "instructions" ? (
                <div className="mx-auto max-w-3xl rounded-2xl bg-raised/20 p-5 sm:p-7">
                  <button
                    type="button"
                    onClick={() => setPendingView("details")}
                    className="flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <ArrowLeft size={15} /> Back
                  </button>
                  <div className="mt-7 flex items-center gap-3">
                    {selectedPreviewBot && <BotAvatar bot={selectedPreviewBot} state={selectedMember?.appearance?.mascotExpression ?? "idle"} size={42} animated={false} />}
                    <div>
                      <h3 className="text-[18px] font-semibold text-ink">Instructions</h3>
                      <p className="mt-0.5 text-[12px] text-ink-secondary">{selectedMember?.name ?? pending.name}</p>
                    </div>
                  </div>
                  <p className="mt-6 whitespace-pre-wrap text-[14px] leading-7 text-ink">
                    {selectedMember?.description || pending.description || "No public instructions were provided."}
                  </p>
                </div>
              ) : pendingView !== "details" ? (
                <PendingCollectionView pending={pending} view={pendingView} onBack={() => setPendingView("details")} />
              ) : (
                <div className="grid gap-5 lg:grid-cols-[minmax(230px,310px)_minmax(0,1fr)]">
                  <section className="rounded-2xl bg-raised/25 p-5 text-center sm:p-6">
                    <div className="flex min-h-[190px] items-center justify-center rounded-xl bg-card/60">
                      {selectedPreviewBot && <BotAvatar bot={selectedPreviewBot} state={selectedMember?.appearance?.mascotExpression ?? "idle"} size={132} animated={false} />}
                    </div>
                    <h3 className="mt-5 text-[19px] font-semibold text-ink">{selectedMember?.name ?? pending.name}</h3>
                    <p className="mt-1 text-[12.5px] text-ink-secondary">
                      {pending.authorName ? `By ${pending.authorName}` : selectedMember?.title || "OpenMausBot bot"}
                    </p>
                    <p className={cn("mt-4 text-[13px] leading-relaxed text-ink-secondary", publicProfileOnly && "line-clamp-6")}>
                      {selectedMember?.description || pending.description || "No public instructions were provided."}
                    </p>
                    {pending.members.length > 1 && (
                      <div className="mt-6 text-left">
                        <div className="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Team members</div>
                        <div className="space-y-1.5">
                          {pending.members.map((member, index) => {
                            const selected = index === selectedMemberIndex;
                            const memberBot = { name: member.name, color: member.appearance?.color ?? "green", avatarDefinition: member.appearance?.avatarDefinition };
                            return <button key={member.key} type="button" onClick={() => setSelectedMemberIndex(index)} className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent", selected ? "bg-card text-ink ring-1 ring-accent/50" : "text-ink-secondary hover:bg-card/60 hover:text-ink")} aria-pressed={selected}><BotAvatar bot={memberBot} state={member.appearance?.mascotExpression ?? "idle"} size={30} animated={false} /><span className="min-w-0"><span className="block truncate text-[12.5px] font-medium">{member.name}</span><span className="block truncate text-[11px]">{member.title || "General assistant"}</span></span></button>;
                          })}
                        </div>
                      </div>
                    )}
                  </section>

                  <section className="rounded-2xl bg-raised/20 p-4 sm:p-5">
                    <div className="mb-3 flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-[16px] font-semibold text-ink">{pending.members.length === 1 ? "Bot details" : "Team contents"}</h3>
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{pending.members.length === 1 ? "Review what will be added before continuing." : `${pending.members.length} members in this package. Counts below apply to the full team.`}</p>
                      </div>
                      {pending.kind === "package" && <span className="shrink-0 rounded-full bg-card px-2.5 py-1 text-[11px] text-ink-secondary">{pending.members.length} {pending.members.length === 1 ? "bot" : "bots"}</span>}
                    </div>
                    <div className="divide-y divide-hairline/35 overflow-hidden rounded-xl border border-hairline/40 bg-card/45">
                      <button type="button" onClick={() => setPendingView("instructions")} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-raised/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"><BookOpen size={17} className="shrink-0 text-ink-secondary" /><span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium text-ink">Instructions</span><span className="mt-0.5 block text-[11.5px] text-ink-secondary">How this {pending.members.length === 1 ? "bot" : "team"} should work</span></span><ChevronRight size={16} className="text-ink-secondary" /></button>
                      {([ ["rooms", "Rooms", pending.roomEntries.length], ["playbooks", "Playbooks", pending.playbookEntries.length] ] as const).map(([view, label, count]) => count > 0 ? <button key={view} type="button" onClick={() => setPendingView(view)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-raised/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"><MessageSquare size={17} className="shrink-0 text-ink-secondary" /><span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium text-ink">{label}</span><span className="mt-0.5 block text-[11.5px] text-ink-secondary">Review imported public setup</span></span><span className="text-[13px] tabular-nums text-ink-secondary">{count}</span><ChevronRight size={16} className="text-ink-secondary" /></button> : null)}
                      <div className="flex items-center gap-3 px-4 py-3.5"><MessageSquare size={17} className="shrink-0 text-ink-secondary" /><span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium text-ink">Memory</span><span className="mt-0.5 block text-[11.5px] text-ink-secondary">{publicProfileOnly ? "Not included in this public profile" : source === "grok-recipe" ? "Skipped: OpenMaus keeps memories private" : "Private facts are not transferred"}</span></span><span className="text-[13px] tabular-nums text-ink-secondary">0</span></div>
                      {detailRows.map(([view, Icon, label, description, count]) => count > 0 ? <button key={view} type="button" onClick={() => setPendingView(view)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-raised/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"><Icon size={17} className="shrink-0 text-ink-secondary" /><span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium text-ink">{label}</span><span className="mt-0.5 block text-[11.5px] text-ink-secondary">{description}</span></span><span className="text-[13px] tabular-nums text-ink-secondary">{count}</span><ChevronRight size={16} className="text-ink-secondary" /></button> : <div key={view} className="flex items-center gap-3 px-4 py-3.5"><Icon size={17} className="shrink-0 text-ink-secondary" /><span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium text-ink">{label}</span><span className="mt-0.5 block text-[11.5px] text-ink-secondary">{description}</span></span><span className="text-[13px] tabular-nums text-ink-secondary">0</span></div>)}
                    </div>
                    <div className="mt-5 flex items-start gap-2.5 rounded-xl bg-raised/45 px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary"><Check size={15} className="mt-0.5 shrink-0 text-success" /><p>{publicProfileOnly ? "Adds the public name, author, avatar appearance, and full public instructions only." : pending.kind === "package" ? "Bots, appearance, rooms, playbooks, and paused routines are added. Conversations, credentials, permissions, paths, and runtime state stay private." : "Only roles and appearance are loaded. Conversations, account connections, permissions, and computer access stay private."}</p></div>
                  </section>
                </div>
              )}
              {publicProfileOnly && <div className="mt-5 flex items-start gap-2.5 rounded-xl bg-accent/8 px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary"><ExternalLink size={15} className="mt-0.5 shrink-0 text-accent" /><p>This anonymous public-profile endpoint does not provide authenticated Skills, Routines, Plugins, or Memory.</p></div>}
              {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
            </div>

            <footer className="flex flex-col gap-3 border-t border-hairline/35 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div className="text-[12.5px] text-ink-secondary">
                {currentBotCount > 0 ? (
                  importMode === "replace" ? (
                    <>
                      Replaces your {currentBotCount} current {currentBotCount === 1 ? "bot" : "bots"}. They&apos;ll be archived with conversations intact.{" "}
                      <button onClick={() => setImportMode("add")} className="font-medium text-ink hover:underline">Add alongside instead</button>
                    </>
                  ) : (
                    <>
                      This team will be added alongside your current bots.{" "}
                      <button onClick={() => setImportMode("replace")} className="font-medium text-ink hover:underline">Replace current team instead</button>
                    </>
                  )
                ) : (
                  pending.kind === "package" ? "Review the complete setup, then activate the playbook." : "No channel is created—you can make one later if you want."
                )}
              </div>
              <button
                onClick={() => void importTeam()}
                disabled={importing}
                className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
              >
                {importing && <Loader2 size={15} className="animate-spin" />}
                {importing
                  ? "Loading…"
                  : currentBotCount === 0 || importMode === "add"
                    ? pending.members.length === 1 ? "Add Bot" : "Add team"
                    : "Replace team"}
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div className="flex w-fit flex-wrap rounded-xl bg-raised/70 p-1" role="tablist" aria-label="Team workspace">
                <button
                  role="tab"
                  aria-selected={tab === "export"}
                  onClick={() => {
                    setTab("export");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "export" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Export &amp; share
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "explore"}
                  onClick={() => {
                    setTab("explore");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "explore" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Explore
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "import"}
                  onClick={() => {
                    setTab("import");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "import" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Import
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "scout"}
                  onClick={() => {
                    setTab("scout");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "scout" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  From a folder
                </button>
              </div>
              {tab === "explore" && (
                <label className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-raised/70 px-3.5 sm:w-[320px]">
                  <Search size={17} className="shrink-0 text-ink-secondary" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search teams"
                    aria-label="Search teams"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
                  />
                </label>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8">
              {tab === "explore" && (
                <div>
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">
                    {search ? "Search results" : "Community teams"}
                  </div>
                  {catalogLoading && (
                    <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
                      <Loader2 size={16} className="animate-spin" /> Loading teams…
                    </div>
                  )}
                  {!catalogLoading && catalogError && (
                    <div className="rounded-xl bg-danger/10 p-4 text-[13px] text-danger">
                      <p>{catalogError}</p>
                      <button onClick={() => void loadCatalog()} className="mt-3 rounded-full bg-raised px-3.5 py-2 text-ink hover:bg-raised-hover">Try again</button>
                    </div>
                  )}
                  {!catalogLoading && catalog && (
                    <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                      {visibleTeams.map((entry, index) => (
                        <button
                          key={entry.slug}
                          type="button"
                          onClick={() => void loadLibraryTeam(entry)}
                          disabled={busySlug !== null && busySlug !== entry.slug}
                          aria-label={`Load ${entry.name}`}
                          aria-busy={busySlug === entry.slug}
                          className={cn(
                            "group flex min-h-[120px] w-full items-center gap-3 border-b border-hairline/35 px-1 py-4 text-left transition-colors hover:bg-raised/35 focus:outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-wait disabled:opacity-50",
                            busySlug === entry.slug && "bg-raised/40 ring-1 ring-inset ring-accent/35",
                          )}
                        >
                          <TeamGlyph index={index} />
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-[14px] font-medium text-ink group-hover:text-ink">{entry.name}</h3>
                            <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-secondary">{entry.outcome ?? entry.summary}</p>
                            <p className="mt-1 truncate text-[11.5px] text-ink-secondary/80">
                              {entry.category} · {entry.members} bots · {entry.skills.length} playbooks
                              {entry.requires.apps.length > 0 && ` · ${entry.requires.apps.join(", ")}`}
                              {entry.setupMinutes && ` · ~${entry.setupMinutes} min`}
                            </p>
                          </div>
                          <span className="flex min-w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink transition-colors group-hover:bg-raised-hover">
                            {busySlug === entry.slug && <Loader2 size={13} className="animate-spin" />}
                            {busySlug === entry.slug ? "Loading" : "Load"}
                            {busySlug !== entry.slug && <ChevronRight size={14} className="text-ink-secondary" />}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {!catalogLoading && catalog && visibleTeams.length === 0 && (
                    <div className="flex min-h-56 flex-col items-center justify-center text-center">
                      <div className="text-[14px] font-medium text-ink">No teams found</div>
                      <div className="mt-1 text-[12.5px] text-ink-secondary">Try a different search.</div>
                    </div>
                  )}
                </div>
              )}

              {tab === "import" && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.json,.mausteam.json,text/markdown,application/json"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (!file) return;
                      void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                  />
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">Bring your own team</div>
                  <div className="grid gap-5 md:grid-cols-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        const file = event.dataTransfer.files[0];
                        if (file) void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                      }}
                      className={cn(
                        "flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition-colors",
                        dragging ? "border-accent bg-accent/5" : "border-hairline/60 bg-raised/20 hover:bg-raised/35",
                      )}
                    >
                      <UploadCloud size={27} className="text-accent" />
                      <span className="mt-3 text-[14px] font-medium text-ink">Choose a team file</span>
                      <span className="mt-1 text-[12.5px] text-ink-secondary">or drop a BotMRR .md / legacy .mausteam.json here</span>
                    </button>

                    <div className="flex min-h-56 flex-col justify-center rounded-2xl bg-raised/25 px-6">
                      <Github size={25} className="text-ink-secondary" />
                      <h3 className="mt-3 text-[14px] font-medium text-ink">Load from a link</h3>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">Paste an OpenMausBot shared package, public GitHub team, or Grok Bot link.</p>
                      <div className="mt-4 flex gap-2">
                        <input
                          value={githubUrl}
                          onChange={(event) => setGithubUrl(event.target.value)}
                          onKeyDown={(event) => event.key === "Enter" && void loadGithubTeam()}
                          placeholder="accounts.openmausbot.com, GitHub, or x.ai"
                          aria-label="Shared bot, GitHub, or Grok Bot URL"
                          className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                        <button
                          onClick={() => void loadGithubTeam()}
                          disabled={!githubUrl.trim() || githubLoading}
                          className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                        >
                          {githubLoading && <Loader2 size={13} className="animate-spin" />}
                          Load
                        </button>
                      </div>
                    </div>
                  </div>
                  {window.ogb?.platform === "win32" && window.ogb.grokBotLinkHandler && (
                    <section className="mt-5 flex flex-col gap-4 rounded-2xl bg-raised/25 p-5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <Link2 size={19} className="mt-0.5 shrink-0 text-accent" />
                        <div>
                          <h3 className="text-[14px] font-medium text-ink">Grok Bot link handler</h3>
                          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
                            {grokHandlerState?.isDefault
                              ? "OpenMaus is the current Windows handler. You can switch back in Default Apps."
                              : "Grok Bot links currently open with another app. This changes only after your click."}
                          </p>
                          {grokHandlerMessage && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{grokHandlerMessage}</p>}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void enableGrokBotLinkHandler()}
                        disabled={grokHandlerBusy || grokHandlerState?.isDefault || grokHandlerState?.supported === false}
                        className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-card px-4 py-2.5 text-[13px] font-medium text-ink ring-1 ring-inset ring-hairline/50 hover:bg-raised disabled:opacity-45"
                      >
                        {grokHandlerBusy && <Loader2 size={14} className="animate-spin" />}
                        {grokHandlerState?.isDefault ? "Current handler" : "Open Grok Bot links in OpenMaus"}
                      </button>
                    </section>
                  )}
                  {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
                </div>
              )}

              {tab === "export" && (
                <div className="space-y-5">
                  <section className="rounded-2xl bg-raised/25 p-5 sm:p-6">
                    <div className="flex flex-col gap-1">
                      <h3 className="text-[16px] font-semibold text-ink">Export &amp; share</h3>
                      <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-secondary">
                        Choose exactly what belongs in this portable BotMRR package. Local export works without an account.
                      </p>
                    </div>

                    <label className="mt-5 block text-[12px] font-medium text-ink-secondary" htmlFor="export-scope">Scope</label>
                    <ExportScopeDropdown
                      options={exportScopes}
                      bots={selectedBots.length ? selectedBots : state.bots.filter((bot) => !bot.hidden)}
                      value={selectedScopeOption?.key}
                      onChange={(next) => {
                        setScopeKey(next.key);
                        setPublishDraft(null);
                        setExportPreview(null);
                      }}
                      disabled={shareBusy === "options" || exportScopes.length === 0}
                    />
                    {selectedScopeOption && <p className="mt-2 text-[11.5px] text-ink-secondary">{selectedScopeOption.detail}</p>}

                    <label className="mt-5 block text-[12px] font-medium text-ink-secondary" htmlFor="export-name">Package name</label>
                    <input
                      id="export-name"
                      value={packageName}
                      maxLength={100}
                      onChange={(event) => {
                        setPackageName(event.target.value);
                        setPublishDraft(null);
                        setExportPreview(null);
                      }}
                      className="mt-2 w-full rounded-xl border border-hairline/50 bg-card px-3.5 py-3 text-[13.5px] text-ink outline-none focus:border-accent sm:max-w-xl"
                    />

                    <div className="mt-5 rounded-xl border border-hairline/40 bg-card/45 p-4">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                        <div className="flex -space-x-2">
                          {selectedBots.slice(0, 4).map((bot) => <BotAvatar key={bot.id} bot={bot} state="happy" size={38} animated={false} />)}
                          {selectedBots.length > 4 && <span className="flex size-[38px] items-center justify-center rounded-full border border-panel bg-raised text-[11px] text-ink-secondary">+{selectedBots.length - 4}</span>}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[14px] font-medium text-ink">{selectedScopeOption?.label ?? "No active bots selected"}</div>
                          <div className="mt-1 text-[12px] text-ink-secondary">{selectedBots.length} {selectedBots.length === 1 ? "bot" : "bots"} · {selectedGroups.length} {selectedGroups.length === 1 ? "room" : "rooms"} · {selectedRoutineCount} paused routines</div>
                          <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                            {selectedBots.map((bot) => <div key={bot.id} className="min-w-0"><div className="truncate text-[12.5px] font-medium text-ink">{bot.name}</div><div className="truncate text-[11.5px] text-ink-secondary">{bot.title || "General assistant"}</div></div>)}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-5">
                      <div className="text-[12px] font-medium text-ink-secondary">Skills</div>
                      {shareBusy === "options" && <div className="mt-2 text-[12px] text-ink-secondary">Checking portable Skills…</div>}
                      {shareBusy !== "options" && exportSkills.length === 0 && <div className="mt-2 rounded-xl bg-card/45 px-3.5 py-3 text-[12px] text-ink-secondary">No portable skills in this selection</div>}
                      {exportSkills.length > 0 && <div className="mt-2 divide-y divide-hairline/35 rounded-xl border border-hairline/40 bg-card/45">
                        {exportSkills.map((skill) => {
                          const checked = selectedSkillIds.includes(skill.id);
                          return <label key={skill.id} className="flex cursor-pointer items-start gap-3 px-3.5 py-3 hover:bg-raised/35"><input type="checkbox" checked={checked} onChange={() => { setSelectedSkillIds((ids) => checked ? ids.filter((id) => id !== skill.id) : [...ids, skill.id]); setPublishDraft(null); setExportPreview(null); }} className="mt-0.5 accent-accent" /><span className="min-w-0"><span className="block text-[13px] font-medium text-ink">{skill.name}</span><span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-secondary">{skill.description || "Portable app skill"} · {skill.origin}</span></span></label>;
                        })}
                      </div>}
                    </div>

                    <div className="mt-5 rounded-xl bg-raised/45 px-4 py-3 text-[12px] leading-relaxed text-ink-secondary">
                      Carries bots, instructions, appearance/avatar, selected rooms, paused routines, playbooks, and selected Skills. Does not carry chats, credentials, permissions, paths, or runtime state.
                    </div>
                    {exportPreview && <div className="mt-3 text-[11.5px] text-ink-secondary">Preview validated: {exportPreview.members.length} bots · {exportPreview.skills} package Skills.</div>}
                    {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
                    <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <button onClick={() => { void createExportDraft(true).catch(() => undefined); }} disabled={!selectedScopeOption || shareBusy !== ""} className="flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40">
                        {shareBusy === "export" && <Loader2 size={15} className="animate-spin" />} Export package
                      </button>
                      <button onClick={() => void publishNewShare()} disabled={!selectedScopeOption || shareBusy !== "" || !window.ogb?.botShares} className="flex items-center justify-center gap-2 rounded-full bg-card px-5 py-2.5 text-[13.5px] font-medium text-ink ring-1 ring-inset ring-hairline/50 hover:bg-raised disabled:opacity-40">
                        {shareBusy === "new" && <Loader2 size={15} className="animate-spin" />} Publish link
                      </button>
                    </div>
                  </section>

                  <section className="rounded-2xl bg-raised/20 p-5 sm:p-6">
                    <div className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Share2 size={17} /> Publish link</div>
                    {!window.ogb?.botShares && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">Publishing is available in the desktop app. Local package export and imports remain available here.</p>}
                    {window.ogb?.botShares && accountState === null && <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" /> Checking account…</div>}
                    {window.ogb?.botShares && accountState !== null && !accountState.email && <div className="mt-3 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-secondary"><Lock size={16} className="mt-0.5 shrink-0" /> Sign in from Settings to publish or manage links. This does not affect local export.</div>}
                    {window.ogb?.botShares && accountState?.email && <>
                      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex rounded-xl bg-raised/70 p-1" aria-label="Share visibility">{(["unlisted", "private"] as const).map((visibility) => <button key={visibility} onClick={() => setPublishVisibility(visibility)} className={cn("rounded-lg px-3 py-1.5 text-[12px] capitalize", publishVisibility === visibility ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>{visibility}</button>)}</div><button onClick={() => void publishNewShare()} disabled={!publishDraft || shareBusy !== ""} className="flex items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40">{shareBusy === "new" && <Loader2 size={14} className="animate-spin" />} Publish new link</button></div>
                      <p className="mt-2 text-[11.5px] text-ink-secondary">The link uses the validated draft above. Unlisted is the default.</p>
                      <div className="mt-6 flex items-center justify-between"><div className="text-[12px] font-medium text-ink-secondary">Your shared bots</div><div className="text-[11.5px] text-ink-secondary">{accountState.email}</div></div>
                      {sharesLoading && <div className="flex items-center gap-2 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" /> Loading links…</div>}
                      {!sharesLoading && shares.length === 0 && <div className="mt-2 rounded-2xl border border-dashed border-hairline/60 px-5 py-8 text-center text-[12.5px] text-ink-secondary">No shared links yet.</div>}
                      {!sharesLoading && shares.length > 0 && <div className="mt-2 divide-y divide-hairline/35 rounded-2xl bg-raised/20 px-4">{shares.map((share) => <div key={share.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-[14px] font-medium text-ink">{share.name}</span><span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10.5px] text-ink-secondary">v{share.activeVersion} · {share.visibility}</span></div><p className="mt-1 truncate text-[12px] text-ink-secondary">{share.summary}</p></div><div className="flex shrink-0 flex-wrap items-center gap-1"><button onClick={() => void copyShareLink(share)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={`Copy link for ${share.name}`} title="Copy link"><Copy size={14} /></button><button onClick={() => void openExternal(share.shareUrl)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={`Open ${share.name}`} title="Open link"><ExternalLink size={14} /></button><button onClick={() => void changeShareVisibility(share)} disabled={shareBusy !== ""} className="rounded-full bg-raised px-3 py-2 text-[11.5px] text-ink hover:bg-raised-hover disabled:opacity-40">{share.visibility === "unlisted" ? "Make private" : "Make unlisted"}</button><button onClick={() => void publishShareVersion(share)} disabled={!publishDraft || shareBusy !== ""} className="rounded-full bg-raised px-3 py-2 text-[11.5px] text-ink hover:bg-raised-hover disabled:opacity-40">{shareBusy === `version:${share.id}` ? "Publishing…" : "Publish new version"}</button><button onClick={() => void deleteShare(share)} disabled={shareBusy !== ""} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40" aria-label={`Delete ${share.name}`} title="Delete link"><Trash2 size={14} /></button></div></div>)}</div>}
                    </>}
                  </section>
                </div>
              )}

              {tab === "scout" && (
                <div>
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">Start from a project folder</div>
                  <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-secondary">
                    Point the scout at a folder. It reads what&apos;s in there — README, dependencies, layout — and
                    suggests a team for it. Nothing is created until you say so.
                  </p>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={scoutFolder}
                      onChange={(event) => setScoutFolder(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && scoutTarget && void runScout(scoutTarget)}
                      placeholder="/path/to/your/project"
                      aria-label="Project folder to scout"
                      className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                    />
                    {Boolean(window.ogb?.pickFolder) && (
                      <button
                        onClick={() => void pickScoutFolder()}
                        disabled={scouting}
                        className="flex items-center justify-center gap-1.5 rounded-full bg-raised px-4 py-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
                      >
                        <FolderOpen size={14} />
                        Browse
                      </button>
                    )}
                    <button
                      onClick={() => void runScout(scoutTarget)}
                      disabled={!scoutTarget || scouting}
                      className="flex items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                    >
                      {scouting ? <Loader2 size={14} className="animate-spin" /> : <Compass size={14} />}
                      {scouting ? "Scouting…" : "Scout"}
                    </button>
                  </div>

                  {scouted && (
                    <div className="mt-6">
                      <div className="rounded-2xl bg-raised/25 px-5 py-4">
                        <div className="text-[15px] font-semibold text-ink">{scouted.profile.name}</div>
                        {scouted.profile.summary && (
                          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{scouted.profile.summary}</p>
                        )}
                        {scouted.profile.stacks.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {scouted.profile.stacks.map((stack) => (
                              <span key={stack} className="rounded-full bg-raised px-2.5 py-1 text-[11.5px] text-ink-secondary">
                                {stack}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="mt-5 text-[12px] font-medium text-ink-secondary">Suggested team</div>
                      <div className="mt-1 grid grid-cols-1 gap-x-10 md:grid-cols-2">
                        {scouted.suggestion.manifest.team.members.map((member, index) => (
                          <div key={member.key} className="flex min-h-[64px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                            <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
                              {member.name.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-medium text-ink">
                                {member.name} <span className="font-normal text-ink-secondary">· {member.title}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                                {scouted.suggestion.reasons[member.key] ?? ""}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {directory && directory.length > 0 && (
                        <>
                          <div className="mt-5 text-[12px] font-medium text-ink-secondary">From the community directory — tick to add</div>
                          <div className="mt-1 flex flex-col">
                            {directory.map((candidate) => (
                              <div key={candidate.slug} className="flex items-center gap-3 border-b border-hairline/35 px-1 py-3">
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                  <input
                                    type="checkbox"
                                    checked={pickedDirectory.has(candidate.slug)}
                                    onChange={() =>
                                      setPickedDirectory((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(candidate.slug)) next.delete(candidate.slug);
                                        else next.add(candidate.slug);
                                        return next;
                                      })
                                    }
                                    className="size-4 accent-accent"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13.5px] font-medium text-ink">
                                      {candidate.name}
                                      {candidate.category && <span className="font-normal text-ink-secondary"> · {candidate.category}</span>}
                                    </div>
                                    <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                                      Matches {candidate.matched.join(", ")}
                                    </div>
                                  </div>
                                </label>
                                <button
                                  onClick={() => void openExternal(candidate.detailUrl)}
                                  aria-label={`Open ${candidate.name} on botdirectory.ai`}
                                  title="Read this bot's page before adding it"
                                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                                >
                                  <ExternalLink size={14} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <input
                          value={roomName}
                          onChange={(event) => setRoomName(event.target.value)}
                          aria-label="Project channel name"
                          className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                        <button
                          onClick={() => void createProject()}
                          disabled={creating}
                          className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
                        >
                          {creating && <Loader2 size={15} className="animate-spin" />}
                          {creating ? "Creating…" : "Create project channel"}
                        </button>
                      </div>
                      <p className="mt-2 text-[12px] text-ink-secondary">
                        Creates the team as new bots, opens a channel for them, and points the channel at this folder.
                      </p>
                    </div>
                  )}
                  {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
