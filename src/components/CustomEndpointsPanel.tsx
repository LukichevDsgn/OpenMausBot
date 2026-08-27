import { Check, ChevronDown, ExternalLink, Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";

type Endpoint = {
  id: string;
  name: string;
  providerId: string;
  baseUrl: string;
  defaultModel: string;
  context?: number;
  useForNewChats?: boolean;
  discoverModels?: boolean;
  configured: boolean;
};

type Draft = Omit<Endpoint, "configured" | "context"> & { context: string; apiKey: string; clearKey?: boolean };
type Probe = { ok: boolean; status?: number; models?: number; includesDefault?: boolean; message?: string };

const EMPTY: Draft = {
  id: "",
  name: "",
  providerId: "",
  baseUrl: "",
  defaultModel: "",
  context: "",
  useForNewChats: true,
  discoverModels: true,
  apiKey: "",
};
const INPUT = "w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

function toPayload(draft: Draft) {
  return {
    ...draft,
    context: draft.context.trim() ? Number(draft.context) : undefined,
    apiKey: draft.apiKey.trim() || undefined,
    clearKey: draft.clearKey === true,
  };
}

function preset(name: "nvidia" | "openrouter"): Draft {
  return name === "nvidia"
    ? {
        ...EMPTY,
        id: "nvidia",
        name: "NVIDIA NIM",
        providerId: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        defaultModel: "z-ai/glm-5.2",
      }
    : {
        ...EMPTY,
        id: "openrouter",
        name: "OpenRouter",
        providerId: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        defaultModel: "z-ai/glm-5.2",
      };
}

export function CustomEndpointsPanel() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);

  const load = () => api("/api/custom-endpoints").then((result) => setEndpoints(result.endpoints ?? []));
  useEffect(() => { void load().catch((e) => setError(e.message)); }, []);

  const editing = useMemo(() => draft?.id || "", [draft]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value, clearKey: false } : current);
    setProbe(null);
  };

  const openNew = (value: Draft = EMPTY) => {
    setDraft({ ...value });
    setExpanded(null);
    setProbe(null);
    setError(null);
  };

  const test = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      const result = await api("/api/custom-endpoints/test", { method: "POST", body: JSON.stringify(toPayload(draft)) });
      setProbe(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const payload = toPayload(draft);
      const result = window.ogb?.saveCustomEndpoint
        ? await window.ogb.saveCustomEndpoint(payload)
        : await api(`/api/custom-endpoints/${encodeURIComponent(draft.id)}`, { method: "PUT", body: JSON.stringify(payload) });
      setEndpoints(result.endpoints ?? []);
      setDraft(null);
      setProbe(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = window.ogb?.deleteCustomEndpoint
        ? await window.ogb.deleteCustomEndpoint(id)
        : await api(`/api/custom-endpoints/${encodeURIComponent(id)}`, { method: "DELETE" });
      setEndpoints(result.endpoints ?? []);
      if (draft?.id === id) setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline/40 bg-inset px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Zap size={14} className="text-accent" />
        <div className="text-[13px] font-medium text-ink">Custom endpoints</div>
        <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">OpenCode</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => openNew()}
          disabled={busy}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          <Plus size={13} /> New endpoint
        </button>
      </div>
      <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
        OpenAI-compatible URL, model, context and key. The key is kept in the OS credential store in the packaged app and is passed to OpenCode through an environment reference.
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {endpoints.map((endpoint) => {
          const open = expanded === endpoint.id;
          return (
            <div key={endpoint.id} className="rounded-lg border border-hairline/40 bg-panel px-2.5 py-2">
              <button
                type="button"
                onClick={() => setExpanded(open ? null : endpoint.id)}
                className="flex w-full items-center gap-2 text-left"
              >
                <span className={cn("size-1.5 rounded-full", endpoint.configured ? "bg-success" : "bg-warning")} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{endpoint.name}</span>
                <span className="max-w-[220px] truncate font-mono text-[10.5px] text-ink-secondary">{endpoint.providerId}/{endpoint.defaultModel}</span>
                <ChevronDown size={13} className={cn("text-ink-secondary transition-transform", open && "rotate-180")} />
              </button>
              {open && (
                <div className="mt-2 border-t border-hairline/30 pt-2 text-[11px] text-ink-secondary">
                  <div className="truncate font-mono">{endpoint.baseUrl}</div>
                  <div className="mt-1 flex items-center gap-2">
                    {endpoint.configured ? <span className="text-success">Key connected</span> : <span className="text-warning">Key required</span>}
                    {endpoint.useForNewChats && <span>Default for new chats</span>}
                    {endpoint.context && <span>Context {endpoint.context.toLocaleString()}</span>}
                  </div>
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => openNew({ ...endpoint, context: endpoint.context ? String(endpoint.context) : "", apiKey: "" })} className="flex items-center gap-1 rounded px-2 py-1 text-ink-secondary hover:bg-raised hover:text-ink"><Pencil size={12} /> Edit</button>
                    <button type="button" onClick={() => void remove(endpoint.id)} disabled={busy} className="flex items-center gap-1 rounded px-2 py-1 text-danger hover:bg-danger/10 disabled:opacity-50"><Trash2 size={12} /> Delete</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {endpoints.length === 0 && !draft && <div className="rounded-lg border border-dashed border-hairline/40 px-3 py-3 text-center text-[11.5px] text-ink-secondary">No custom endpoints yet.</div>}
      </div>

      {!draft && (
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => openNew(preset("nvidia"))} className="rounded-md border border-hairline/40 px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink">Add NVIDIA NIM</button>
          <button type="button" onClick={() => openNew(preset("openrouter"))} className="rounded-md border border-hairline/40 px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink">Add OpenRouter</button>
        </div>
      )}

      {draft && (
        <div className="mt-3 border-t border-hairline/30 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[12.5px] font-medium text-ink">{editing ? "Edit endpoint" : "New endpoint"}</div>
            {!editing && <div className="flex gap-1.5"><button type="button" onClick={() => openNew(preset("nvidia"))} className="rounded bg-raised px-1.5 py-1 text-[10.5px] text-ink-secondary">NVIDIA</button><button type="button" onClick={() => openNew(preset("openrouter"))} className="rounded bg-raised px-1.5 py-1 text-[10.5px] text-ink-secondary">OpenRouter</button></div>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Name" aria-label="Endpoint name" className={INPUT} />
            <input value={draft.providerId} onChange={(e) => set("providerId", e.target.value)} placeholder="Provider ID" aria-label="Provider ID" className={`${INPUT} font-mono`} />
            <input value={draft.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="Endpoint URL, e.g. https://api.example.com/v1" aria-label="Endpoint URL" className={`${INPUT} col-span-2`} />
            <input value={draft.defaultModel} onChange={(e) => set("defaultModel", e.target.value)} placeholder="Default model" aria-label="Default model" className={INPUT} />
            <input value={draft.context} onChange={(e) => set("context", e.target.value)} placeholder="Context (optional)" aria-label="Context length" inputMode="numeric" className={INPUT} />
            <input type="password" value={draft.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder="API key, blank keeps current" aria-label="Endpoint API key" autoComplete="off" className={`${INPUT} col-span-2`} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-ink-secondary">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(draft.useForNewChats)} onChange={(e) => set("useForNewChats", e.target.checked)} /> Use for new chats</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(draft.discoverModels)} onChange={(e) => set("discoverModels", e.target.checked)} /> Discover models</label>
          </div>
          {probe && <div className={cn("mt-2 rounded-md px-2 py-1.5 text-[11.5px]", probe.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
            {probe.ok ? `Connection OK · ${probe.models ?? 0} models${probe.includesDefault ? " · default found" : " · default not in catalog"}` : `Test failed${probe.status ? ` · HTTP ${probe.status}` : ""}: ${probe.message}`}
          </div>}
          {error && <div role="alert" className="mt-2 text-[11.5px] text-danger">{error}</div>}
          <div className="mt-2.5 flex items-center justify-between">
            <a href="https://opencode.ai/docs/providers/" target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-accent hover:underline">OpenCode provider format <ExternalLink size={11} /></a>
            <div className="flex gap-2">
              <button type="button" onClick={() => setDraft(null)} disabled={busy} className="rounded-md px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised disabled:opacity-50">Cancel</button>
              <button type="button" onClick={() => void test()} disabled={busy} className="flex items-center gap-1 rounded-md border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised disabled:opacity-50">{busy ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} Test</button>
              <button type="button" onClick={() => void save()} disabled={busy} className="flex items-center gap-1 rounded-md bg-raised px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50">{busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
