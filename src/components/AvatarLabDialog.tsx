import { Check, Dice5, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The temporary deterministic harness uses the classic JSX transform.
void React;

import { cn } from "@/lib/cn";
import { randomizedAvatarSelection, type AvatarPresetId } from "@/lib/avatar-presets";
import { MAUS_COLORS, type MausColor } from "@/lib/mascot";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_EYE_STYLES,
  generatedBotAvatar,
  type BotAvatarCrop,
  type BotProceduralAvatar,
} from "../../shared/bot-avatar";
import { MausAvatar, SELECTABLE_AVATAR_REGISTRY } from "./Avatar";

export interface AvatarLabPatch {
  avatarDefinition: BotProceduralAvatar;
  avatarUrl: null;
  avatarCrop: BotAvatarCrop;
  color: MausColor;
  mascotExpression: string;
}

interface AvatarLabBot {
  id: string;
  name: string;
  color: MausColor;
  mascotExpression?: string | null;
  avatarDefinition?: BotProceduralAvatar | null;
}

const EYE_STYLE_LABELS: Record<BotProceduralAvatar["eyeStyle"], string> = {
  balanced: "Balanced",
  wide: "Wide",
  calm: "Calm",
};

type AvatarShapeOption =
  | { kind: "blobatar"; id: AvatarPresetId; label: string }
  | { kind: "procedural"; id: BotProceduralAvatar["silhouette"]; label: string };

const AVATAR_SHAPE_OPTIONS: readonly AvatarShapeOption[] = SELECTABLE_AVATAR_REGISTRY.map((entry) => entry.kind === "preset"
    ? { kind: "blobatar" as const, id: entry.avatarPresetId!, label: entry.label }
    : { kind: "procedural" as const, id: entry.silhouette!, label: entry.label });

/** The single large preview is the only live native-engine instance in the
 * Lab. Cards are intentionally static snapshots so they cannot each create
 * an independent expression/blink timeline. */
export const AVATAR_LAB_LIVE_PREVIEW_PROPS = {
  state: "idle" as const,
  animated: true,
  trackPointer: false,
};

export const AVATAR_LAB_STATIC_PREVIEW_PROPS = {
  state: "idle" as const,
  animated: false,
  trackPointer: false,
  autoBlink: false,
  autoExpression: false,
  expression: 6,
};

/**
 * Stable identity for the selected silhouette. The large preview remounts
 * only when this changes, so a newly selected shape starts a fresh native
 * CursorAvatar idle lifecycle while color and eye-style edits retain the
 * existing engine instance and phase.
 */
export function avatarLabPreviewIdentity(definition: BotProceduralAvatar): string {
  return definition.avatarPresetId
    ? `preset:${definition.avatarPresetId}`
    : `procedural:${definition.silhouette}`;
}

/** Avatar Lab previews always use the native CursorAvatar idle cycle.  The
 * persisted expression recipe belongs to runtime/profile state and must not
 * pin a picker card to one transient face. */
export function avatarLabPreviewDefinition(definition: BotProceduralAvatar): BotProceduralAvatar {
  const { expressionPreset: _expressionPreset, ...idleDefinition } = definition;
  return idleDefinition;
}

function selectAvatarPreset(definition: BotProceduralAvatar, avatarPresetId: AvatarPresetId): BotProceduralAvatar {
  return { ...definition, avatarPresetId };
}

function selectProceduralSilhouette(
  definition: BotProceduralAvatar,
  silhouette: BotProceduralAvatar["silhouette"],
): BotProceduralAvatar {
  const { avatarPresetId: _removed, ...withoutPreset } = definition;
  return { ...withoutPreset, silhouette };
}

function initialDraft(bot: AvatarLabBot) {
  const generated = generatedBotAvatar(bot.id);
  return {
    // A legacy definition without avatarPresetId is already a local shape.
    // Preserve it instead of silently turning it into Cubee or another preset.
    definition: bot.avatarDefinition ?? generated.definition,
    color: bot.color,
  };
}

export type AvatarLabRandomizeResult = Readonly<{ definition: BotProceduralAvatar; color: MausColor }>;

/**
 * Randomize only the three persisted identity dimensions.  The randomizer in
 * avatar-presets intentionally picks one dimension at a time, so the Lab
 * composes three bounded picks while retaining expression/mouth/resting fields
 * from the current draft.  Runtime state and expression remain engine-owned.
 */
export function randomizeAvatarLabDraft(
  definition: BotProceduralAvatar,
  color: MausColor,
  random: () => number = Math.random,
): AvatarLabRandomizeResult {
  const current = { avatarPresetId: definition.avatarPresetId, silhouette: definition.silhouette, eyeStyle: definition.eyeStyle, color };
  const pickDimension = <T extends typeof current>(selection: T, dimension: 0 | 1 | 2) => {
    let first = true;
    return randomizedAvatarSelection(selection, () => {
      if (first) {
        first = false;
        return (dimension + 0.25) / 3;
      }
      return random();
    });
  };
  const shape = pickDimension(current, 0);
  const shapedDefinition = shape.avatarPresetId
    ? selectAvatarPreset(definition, shape.avatarPresetId)
    : selectProceduralSilhouette(definition, shape.silhouette ?? definition.silhouette);
  const shaped = { avatarPresetId: shapedDefinition.avatarPresetId, silhouette: shapedDefinition.silhouette, eyeStyle: definition.eyeStyle, color };
  const eye = pickDimension(shaped, 1);
  const colored = { avatarPresetId: shapedDefinition.avatarPresetId, silhouette: shapedDefinition.silhouette, eyeStyle: eye.eyeStyle, color };
  const nextColor = pickDimension(colored, 2).color;
  return { definition: { ...shapedDefinition, eyeStyle: eye.eyeStyle }, color: nextColor };
}

export function AvatarLabDialog({
  open,
  bot,
  onApply,
  onClose,
}: {
  open: boolean;
  bot: AvatarLabBot;
  onApply: (patch: AvatarLabPatch) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const botRef = useRef(bot);
  botRef.current = bot;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [initial] = useState(() => initialDraft(bot));
  const [definition, setDefinition] = useState(initial.definition);
  const [color, setColor] = useState<MausColor>(initial.color);

  useEffect(() => {
    if (!open) return;
    // The bot object is live state and changes identity frequently. Only a
    // real open or a different bot starts a fresh draft; same-id updates must
    // not erase edits made while this dialog is open.
    const draft = initialDraft(botRef.current);
    setDefinition(draft.definition);
    setColor(draft.color);
  }, [bot.id, open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => dialogRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;

  const randomize = () => {
    const next = randomizeAvatarLabDraft(definition, color);
    setDefinition(next.definition);
    setColor(next.color);
  };

  const apply = () => {
    onApply({
      avatarDefinition: definition,
      avatarUrl: null,
      avatarCrop: "mascot",
      color,
      mascotExpression: bot.mascotExpression ?? "idle",
    });
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-lab-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(780px,92vh)] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-hairline/40 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 id="avatar-lab-title" className="text-[15px] font-semibold text-ink">Avatar Lab</h2>
            <p className="mt-0.5 text-[12px] text-ink-secondary">Exported Avatar Studio shapes and animations, running locally.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Avatar Lab"
            className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid items-start gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="flex self-start flex-col items-center justify-center rounded-2xl border border-hairline/40 bg-inset p-4 md:sticky md:top-4 md:min-h-[292px]">
              <MausAvatar
                key={avatarLabPreviewIdentity(definition)}
                color={color}
                avatarDefinition={avatarLabPreviewDefinition(definition)}
                size={152}
                {...AVATAR_LAB_LIVE_PREVIEW_PROPS}
                label={bot.name + " avatar preview"}
              />
              <div className="mt-3 text-center">
                <div className="text-[13px] font-medium text-ink">{bot.name}</div>
                <div className="mt-0.5 text-[11px] text-ink-secondary">State reactions turn on automatically while the app is active.</div>
              </div>
              <button
                type="button"
                onClick={randomize}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-hairline/50 bg-control px-3 py-2.5 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Dice5 size={16} />
                Randomize
              </button>
            </div>

            <div className="min-w-0 space-y-5">
              <section>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Avatar shape</div>
                  <div className="text-[11px] text-ink-tertiary">{AVATAR_SHAPE_OPTIONS.length} shapes</div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {AVATAR_SHAPE_OPTIONS.map((option) => {
                    const selected = option.kind === "blobatar"
                      ? definition.avatarPresetId === option.id
                      : !definition.avatarPresetId && definition.silhouette === option.id;
                    const candidate = option.kind === "blobatar"
                      ? selectAvatarPreset(definition, option.id)
                      : selectProceduralSilhouette(definition, option.id);
                    return (
                      <button
                        key={`${option.kind}:${option.id}`}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setDefinition(candidate)}
                        className={cn(
                          "relative flex min-w-0 flex-col items-center gap-1.5 rounded-xl border bg-inset px-2 py-2.5 hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                          selected ? "border-accent bg-accent/10" : "border-hairline/45",
                        )}
                      >
                        <MausAvatar color={color} avatarDefinition={avatarLabPreviewDefinition(candidate)} size={64} {...AVATAR_LAB_STATIC_PREVIEW_PROPS} />
                        <span className="truncate text-[11px] text-ink">{option.label}</span>
                        {selected ? <Check size={13} className="absolute right-2 top-2 text-accent" /> : null}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Eye shape</div>
                  <div className="text-[11px] text-ink-tertiary">3 geometry modes</div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {BOT_AVATAR_EYE_STYLES.map((eyeStyle) => {
                    const selected = definition.eyeStyle === eyeStyle;
                    const candidate = { ...definition, eyeStyle };
                    return (
                      <button
                        key={eyeStyle}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setDefinition(candidate)}
                        className={cn(
                          "relative flex min-w-0 flex-col items-center gap-1 rounded-xl border bg-inset px-1.5 py-2 hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                          selected ? "border-accent bg-accent/10" : "border-hairline/45",
                        )}
                      >
                        <MausAvatar color={color} avatarDefinition={avatarLabPreviewDefinition(candidate)} size={50} {...AVATAR_LAB_STATIC_PREVIEW_PROPS} />
                        <span className="truncate text-[10.5px] text-ink">{EYE_STYLE_LABELS[eyeStyle]}</span>
                        {selected ? <Check size={13} className="absolute right-1.5 top-1.5 text-accent" /> : null}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Color</div>
                <div className="flex flex-wrap gap-2">
                  {BOT_AVATAR_COLORS.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-label={"Use " + candidate}
                      aria-pressed={color === candidate}
                      onClick={() => setColor(candidate)}
                      className={cn(
                        "relative size-9 rounded-full border-2 border-panel shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                        color === candidate && "ring-2 ring-accent-border ring-offset-2 ring-offset-panel",
                      )}
                      style={{ backgroundColor: MAUS_COLORS[candidate] }}
                    >
                      {color === candidate ? <Check size={14} className="absolute inset-0 m-auto text-white drop-shadow" /> : null}
                    </button>
                  ))}
                </div>
              </section>

            </div>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline/40 px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">Cancel</button>
          <button type="button" onClick={apply} className="min-w-[150px] rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-foreground hover:brightness-110">Save avatar</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
