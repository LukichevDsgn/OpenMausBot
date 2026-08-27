import { BookOpen, Check, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { searchSkills, skillOriginLabel } from "@/lib/skills";
import type { SkillCatalogEntry } from "@/state/store";
import { cn } from "@/lib/cn";

export function SkillsDialog({
  open,
  skills,
  selectedId,
  initialQuery = "",
  onSelect,
  onClose,
}: {
  open: boolean;
  skills: readonly SkillCatalogEntry[];
  selectedId: string | null;
  initialQuery?: string;
  onSelect: (skill: SkillCatalogEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchSkills(skills, query), [skills, query]);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    requestAnimationFrame(() => inputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [initialQuery, onClose, open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="skills-dialog-title" className="flex max-h-[min(620px,85vh)] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl">
        <div className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
          <BookOpen size={18} className="text-ink-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="skills-dialog-title" className="text-[15px] font-semibold text-ink">Choose a skill</h2>
            <p className="text-[12px] text-ink-secondary">Applies to the next message only.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close skills" className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            <X size={18} />
          </button>
        </div>
        <div className="border-b border-hairline/30 p-3">
          <label className="flex items-center gap-2 rounded-xl bg-control/70 px-3 py-2">
            <Search size={15} className="text-ink-secondary" aria-hidden="true" />
            <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search skills" placeholder="Search skills" className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none" />
          </label>
        </div>
        <div role="listbox" aria-label="Available skills" className="flex-1 overflow-y-auto p-2">
          {results.map((skill) => {
            const selected = selectedId === skill.id;
            return (
              <button
                key={skill.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(skill)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left hover:bg-control/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                  selected && "bg-control",
                )}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary"><BookOpen size={15} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-ink">{skill.name}</span>
                    <span className="rounded-full bg-raised px-2 py-0.5 text-[10.5px] text-ink-secondary">{skillOriginLabel(skill.origin)}</span>
                  </span>
                  <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-secondary">{skill.description}</span>
                  {skill.requiredCapabilities.length > 0 ? (
                    <span className="mt-1.5 block text-[11px] text-ink-secondary">Requires {skill.requiredCapabilities.join(", ")}</span>
                  ) : null}
                </span>
                {selected ? <Check size={16} className="mt-1 shrink-0 text-accent" aria-hidden="true" /> : null}
              </button>
            );
          })}
          {!results.length ? <div className="px-4 py-10 text-center text-[13px] text-ink-secondary">No skills match “{query.trim()}”.</div> : null}
        </div>
      </div>
    </div>
  );
}
