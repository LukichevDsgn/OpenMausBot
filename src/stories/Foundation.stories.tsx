import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { BotAvatar, InitialsAvatar, MausAvatar } from "@/components/Avatar";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Card, CommandLine } from "@/components/SettingsPrimitives";
import { EffortPicker } from "@/components/EffortPicker";
import { ModelPicker } from "@/components/ModelPicker";
import { OptionCard } from "@/components/OptionCard";
import { PillDropdown, type PillDropdownOption } from "@/components/PillDropdown";
import { ProviderMark } from "@/components/ProviderIcons";
import { SecretRequestCard } from "@/components/SecretRequestCard";
import { SettingsPanel } from "@/components/SettingsPanel";
import { fixtureBots, fixtureStates } from "@/storybook/fixtures";
import { StorybookProvider } from "@/storybook/StaticStorybookProvider";

function Canvas({ children, className = "max-w-3xl" }: { children: React.ReactNode; className?: string }) {
  return <div className={`min-h-full bg-app p-8 text-ink ${className}`}>{children}</div>;
}

const meta = {
  title: "Foundation / Real components",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SettingsCardAndCommandLine: Story = {
  render: () => (
    <Canvas>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Runtime controls" subtitle="Limits and recovery for future turns.">
          <div className="flex flex-wrap gap-2 text-[12px]">
            <span className="rounded-full bg-inset px-2 py-1 text-ink-secondary">45m turn</span>
            <span className="rounded-full bg-inset px-2 py-1 text-ink-secondary">8m idle</span>
            <span className="rounded-full bg-accent/10 px-2 py-1 text-accent">Allowed</span>
          </div>
        </Card>
        <Card title="Command line" subtitle="A real copyable command row.">
          <CommandLine command="pnpm test --filter local-fixtures" />
        </Card>
      </div>
    </Canvas>
  ),
};

function PillDropdownFixture() {
  const options: readonly PillDropdownOption<string>[] = [
    { id: "balanced", label: "Balanced", value: "balanced" },
    { id: "focused", label: "Focused", value: "focused" },
    { id: "disabled", label: "Unavailable", value: "disabled", disabled: true },
  ];
  const [value, setValue] = useState("balanced");
  return <PillDropdown value={value} options={options} onChange={setValue} ariaLabel="Fixture mode" />;
}

export const PillDropdownStates: Story = {
  render: () => (
    <Canvas>
      <div className="flex flex-wrap items-center gap-4">
        <PillDropdownFixture />
        <PillDropdown value="locked" options={[{ id: "locked", label: "Locked", value: "locked" }]} onChange={() => undefined} ariaLabel="Locked fixture" disabled />
      </div>
    </Canvas>
  ),
};

export const EffortPickerAndModelPicker: Story = {
  render: () => {
    const bot = fixtureBots[0]!;
    return (
      <StorybookProvider state={fixtureStates.default}>
        <Canvas>
          <div className="flex flex-wrap items-center gap-3">
            <EffortPicker bot={bot} contained label={<span className="text-[13px] text-ink-secondary">Effort</span>} />
            <ModelPicker bot={bot} contained label={<span className="text-[13px] text-ink-secondary">Model</span>} />
          </div>
          <p className="mt-4 text-[12px] text-ink-secondary">Open either control to inspect the real menu behavior. No provider request is made until an action is chosen.</p>
        </Canvas>
      </StorybookProvider>
    );
  },
};

export const ProviderPillsAndAvatars: Story = {
  render: () => (
    <Canvas>
      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Providers" subtitle="The same provider marks used by the model picker.">
          <div className="flex flex-wrap gap-2">
            {["claudeAgent", "grokAgent", "codex", "openmaus", "boxAgent"].map((driverKind) => (
              <span key={driverKind} className="flex items-center gap-2 rounded-full border border-hairline/40 bg-control/60 px-3 py-1.5 text-[12px] text-ink">
                <ProviderMark driverKind={driverKind} size={16} />
                {driverKind.replace("Agent", "")}
              </span>
            ))}
          </div>
        </Card>
        <Card title="Avatars" subtitle="Mascot and initials fallbacks stay deterministic.">
          <div className="flex items-center gap-4">
            <BotAvatar bot={fixtureBots[0]!} size={48} />
            <BotAvatar bot={fixtureBots[1]!} size={40} />
            <InitialsAvatar initials="OB" size={40} />
            <MausAvatar color="orange" state="thinking" size={40} animated={false} />
          </div>
        </Card>
      </div>
    </Canvas>
  ),
};

export const OptionApprovalAndSecretCards: Story = {
  render: () => (
    <StorybookProvider state={fixtureStates.default}>
      <Canvas className="max-w-4xl">
        <div className="grid gap-4">
          <OptionCard botId="chief" message={fixtureBots[0]!.messages[0]!} />
          <ApprovalCard bot={fixtureBots[0]} message={fixtureBots[0]!.messages[1]!} />
          <SecretRequestCard botId="chief" threadId="chief-thread" message={fixtureBots[0]!.messages[2]!} />
        </div>
      </Canvas>
    </StorybookProvider>
  ),
};

export const SettingsPanelRuntimeControls: Story = {
  render: () => {
    const bot = fixtureBots[0]!;
    return (
      <StorybookProvider state={fixtureStates.default}>
        <div className="min-h-screen bg-app text-ink">
          <SettingsPanel bot={bot} />
        </div>
      </StorybookProvider>
    );
  },
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const SettingsPanelChiefLocked: Story = {
  render: () => {
    const bot = fixtureStates.chiefLocked.bots.find((entry) => entry.id === "chief")!;
    return (
      <StorybookProvider state={fixtureStates.chiefLocked}>
        <div className="min-h-screen bg-app text-ink">
          <SettingsPanel bot={bot} />
        </div>
      </StorybookProvider>
    );
  },
  globals: { viewport: { value: "narrow", isRotated: false } },
};

export const SettingsPanelLongContentNarrow: Story = {
  render: () => {
    const bot = fixtureStates.longContent.bots.find((entry) => entry.id === "chief")!;
    return (
      <StorybookProvider state={fixtureStates.longContent}>
        <div className="min-h-screen w-[360px] overflow-hidden bg-app text-ink">
          <SettingsPanel bot={bot} />
        </div>
      </StorybookProvider>
    );
  },
  globals: { viewport: { value: "narrow", isRotated: false } },
};
