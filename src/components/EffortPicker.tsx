import type { ReactNode } from "react";
import { useStore, type Bot, type ModelSelection } from "@/state/store";
import { PillDropdown, type PillDropdownOption } from "./PillDropdown";

type Effort = ModelSelection["effort"];

function effortLabel(effort: Effort): string {
  if (!effort) return "Default";
  if (effort === "xhigh") return "X-High";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function EffortPicker({
  bot,
  contained = false,
  label,
}: {
  bot: Bot;
  contained?: boolean;
  label?: ReactNode;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const engine = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const effortLevels = engine?.capabilities?.effortLevels ?? [];

  if (!effortLevels.length) return null;

  const options: Array<PillDropdownOption<Effort>> = [
    { id: "default", label: "Default", value: undefined },
    ...effortLevels.map((effort) => ({ id: effort, label: effortLabel(effort), value: effort })),
  ];

  const picker = (
    <PillDropdown
      value={selection.effort}
      options={options}
      ariaLabel="Choose effort"
      onChange={(effort) => dispatch({
        type: "setModel",
        botId: bot.id,
        selection: { ...selection, effort },
      })}
    />
  );

  if (!contained) return picker;

  return (
    <div className="flex w-full items-center justify-between gap-4">
      {label}
      {picker}
    </div>
  );
}
