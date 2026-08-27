import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface PillDropdownOption<T> {
  id: string;
  label: string;
  value: T;
  disabled?: boolean;
}

export function PillDropdown<T>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  triggerClassName,
}: {
  value: T;
  options: readonly PillDropdownOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => Object.is(option.value, value)));
  const selected = options[selectedIndex] ?? options[0];

  const enabledIndices = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const focusIndex = (index: number) => {
    setActiveIndex(index);
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  };
  const openAt = (index: number) => {
    setOpen(true);
    focusIndex(index);
  };
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const move = (direction: 1 | -1) => {
    if (!enabledIndices.length) return;
    const current = enabledIndices.indexOf(activeIndex);
    const next = current < 0
      ? (direction === 1 ? 0 : enabledIndices.length - 1)
      : (current + direction + enabledIndices.length) % enabledIndices.length;
    focusIndex(enabledIndices[next]);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!rootRef.current?.contains(target)) close(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => open ? close(false) : openAt(selectedIndex)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const index = event.key === "ArrowUp" || event.key === "End"
              ? enabledIndices.at(-1)
              : enabledIndices[0];
            if (index !== undefined) openAt(index);
          }
        }}
        className={cn(
          "flex max-w-full items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2.5 pr-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50",
          triggerClassName,
        )}
      >
        <span className="truncate">{selected?.label ?? "Select"}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              const index = event.key === "Home" ? enabledIndices[0] : enabledIndices.at(-1);
              if (index !== undefined) focusIndex(index);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              choose(activeIndex);
            }
          }}
          className="absolute right-0 top-full z-40 mt-1 max-h-[min(320px,calc(100dvh-7rem))] w-40 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
        >
          {options.map((option, index) => {
            const checked = Object.is(option.value, value);
            return (
              <button
                key={option.id}
                ref={(node) => { optionRefs.current[index] = node; }}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                disabled={option.disabled}
                tabIndex={activeIndex === index ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onClick={() => choose(index)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50",
                  checked ? "text-accent" : "text-ink",
                )}
              >
                <span className="truncate">{option.label}</span>
                {checked && <Check size={14} aria-hidden="true" className="shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
