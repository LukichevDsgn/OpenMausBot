import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { BotAvatar, InitialsAvatar, MausAvatar } from "@/components/Avatar";
import { AvatarLabDialog, type AvatarLabPatch } from "@/components/AvatarLabDialog";
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
import type { Bot } from "@/state/store";
import { type BotProceduralAvatar } from "../../shared/bot-avatar";
import { EXPORTED_AVATAR_PRESETS } from "@/lib/avatar-presets";
import { VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES } from "@/lib/procedural-avatar";

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
        <div className="h-screen overflow-hidden bg-app text-ink">
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
        <div className="h-screen overflow-hidden bg-app text-ink">
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
        <div className="h-screen w-[360px] overflow-hidden bg-app text-ink">
          <SettingsPanel bot={bot} />
        </div>
      </StorybookProvider>
    );
  },
  globals: { viewport: { value: "narrow", isRotated: false } },
};

const avatarLabDefinition: BotProceduralAvatar = {
  version: 1,
  seed: "storybook-avatar",
  silhouette: "gem",
  eyeStyle: "calm",
  mouthStyle: "soft",
  avatarPresetId: "cubee",
  restingAnimationId: "idle",
};

function AvatarLabFixture({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [bot, setBot] = useState<Bot>({
    ...fixtureBots[0]!,
    color: "teal" as const,
    mascotExpression: "curious",
    avatarCrop: "mascot" as const,
    avatarUrl: null,
    avatarDefinition: avatarLabDefinition,
  });
  const apply = (patch: AvatarLabPatch) => setBot((current) => ({ ...current, ...patch }));
  return (
    <StorybookProvider state={fixtureStates.default}>
      <Canvas className="max-w-xl">
        <div className="flex items-center gap-4 rounded-2xl border border-hairline/40 bg-card p-4">
          <BotAvatar bot={bot} state="curious" size={64} animated={false} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-ink">{bot.name}</div>
            <div className="text-[12px] text-ink-secondary">Avatar Lab controls appearance; state reactions are automatic.</div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-foreground"
          >
            Open lab
          </button>
        </div>
        <AvatarLabDialog open={open} bot={bot} onApply={apply} onClose={() => setOpen(false)} />
      </Canvas>
    </StorybookProvider>
  );
}

export const AvatarLabClosed: Story = {
  render: () => <AvatarLabFixture />,
};

export const AvatarLabOpen: Story = {
  render: () => <AvatarLabFixture initialOpen />,
};

export const AvatarLabNarrowScrollable: Story = {
  render: () => <AvatarLabFixture initialOpen />,
  globals: { viewport: { value: "narrow", isRotated: false } },
};

export const AvatarLabPresetStates: Story = {
  render: () => (
    <Canvas className="max-w-4xl">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
        {EXPORTED_AVATAR_PRESETS.map((preset, index) => (
          <div key={preset.id} className="flex flex-col items-center gap-2 rounded-2xl border border-hairline/40 bg-card p-4">
            <MausAvatar
              color={(["green", "blue", "red", "orange", "purple", "cyan"] as const)[index % 6]!}
              avatarDefinition={{ ...avatarLabDefinition, avatarPresetId: preset.id }}
              state="happy"
              size={76}
              animated={false}
            />
            <span className="text-[12px] text-ink-secondary">{preset.name}</span>
          </div>
        ))}
      </div>
    </Canvas>
  ),
};

const avatarRendererContractLocal: BotProceduralAvatar = {
  version: 1,
  seed: "renderer-contract-local",
  silhouette: "gem",
  eyeStyle: "calm",
  mouthStyle: "soft",
};

const avatarRendererContractBlobatar: BotProceduralAvatar = {
  ...avatarRendererContractLocal,
  seed: "renderer-contract-blobatar",
  avatarPresetId: "cubee",
};

const avatarRendererContractCanonical: BotProceduralAvatar = {
  ...avatarRendererContractLocal,
  seed: "renderer-contract-canonical",
  silhouette: "cursor",
  avatarPresetId: "openmaus-cursor",
};

const avatarRendererContractBlobatarSecond: BotProceduralAvatar = {
  ...avatarRendererContractBlobatar,
  seed: "renderer-contract-blobatar-second",
  avatarPresetId: "kirby",
};

const avatarRendererContractProceduralSecond: BotProceduralAvatar = {
  ...avatarRendererContractLocal,
  seed: "renderer-contract-procedural-second",
  silhouette: "orb",
};

const avatarRendererContractShapeFixtures = [
  { label: "Round · Strobi", definition: { ...avatarRendererContractBlobatar, seed: "renderer-contract-round", avatarPresetId: "strobi" as const }, color: "blue" as const },
  { label: "Capsule · Nova", definition: { ...avatarRendererContractBlobatar, seed: "renderer-contract-capsule", avatarPresetId: "nova" as const }, color: "cyan" as const },
  { label: "Triangle · Onee", definition: { ...avatarRendererContractBlobatar, seed: "renderer-contract-triangle", avatarPresetId: "onee" as const }, color: "purple" as const },
  { label: "Cloud · Sunee", definition: { ...avatarRendererContractBlobatar, seed: "renderer-contract-cloud", avatarPresetId: "sunee" as const }, color: "orange" as const },
  { label: "Sun · Cubee", definition: { ...avatarRendererContractBlobatar, seed: "renderer-contract-sun", avatarPresetId: "cubee" as const }, color: "red" as const },
] as const;

const avatarRendererContractSizes = [24, 48, 112] as const;
const avatarRendererContractColors = ["green", "blue", "red", "orange", "purple", "cyan"] as const;
const avatarRendererContractVisibleFixtures = [
  ...EXPORTED_AVATAR_PRESETS.map((preset, index) => ({
    label: preset.name,
    definition: {
      ...avatarRendererContractLocal,
      seed: `renderer-contract-visible-${preset.id}`,
      avatarPresetId: preset.id,
    },
    color: avatarRendererContractColors[index % avatarRendererContractColors.length]!,
  })),
  ...VISIBLE_PROCEDURAL_AVATAR_SILHOUETTES.map((silhouette, index) => ({
    label: `Procedural · ${silhouette}`,
    definition: {
      ...avatarRendererContractLocal,
      seed: `renderer-contract-visible-${silhouette}`,
      silhouette,
    },
    color: avatarRendererContractColors[(index + EXPORTED_AVATAR_PRESETS.length) % avatarRendererContractColors.length]!,
  })),
] satisfies readonly { label: string; definition: BotProceduralAvatar; color: (typeof avatarRendererContractColors)[number] }[];

export const AvatarRendererContract: Story = {
  render: () => (
    <Canvas className="max-w-5xl">
      <div className="space-y-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Avatar renderer contract</h2>
          <p className="mt-1 text-[12px] text-ink-secondary">
            Persisted definition, color, white eyes, and state stay consistent across engines and sizes.
          </p>
        </div>

        <section className="rounded-2xl border border-hairline/40 bg-card p-4">
          <div className="mb-3 text-[12px] font-semibold text-ink">All 20 visible surfaces · 112px · static idle · one upright white face</div>
          <div className="grid grid-cols-4 gap-4 sm:grid-cols-5 md:grid-cols-7">
            {avatarRendererContractVisibleFixtures.map(({ label, definition, color }) => (
              <div key={label} className="flex min-w-0 flex-col items-center gap-2">
                <MausAvatar
                  color={color}
                  avatarDefinition={definition}
                  state="idle"
                  size={112}
                  animated={false}
                  trackPointer={false}
                />
                <span className="text-center text-[11px] text-ink-secondary">{label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-hairline/40 bg-card p-4">
          <div className="mb-3 text-[12px] font-semibold text-ink">Face crispness · equal surfaces at 24/48/112px</div>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              { engine: "OpenMaus Cursor", definition: avatarRendererContractCanonical, color: "green" as const },
              { engine: "Blobatar · Cubee", definition: avatarRendererContractBlobatar, color: "blue" as const },
              { engine: "Blobatar · Kirby", definition: avatarRendererContractBlobatarSecond, color: "pink" as const },
              { engine: "Procedural · Gem", definition: avatarRendererContractLocal, color: "purple" as const },
              { engine: "Procedural · Orb", definition: avatarRendererContractProceduralSecond, color: "teal" as const },
            ].map(({ engine, definition, color }) => (
              <section key={engine} className="rounded-2xl border border-hairline/40 bg-card p-4">
                <div className="mb-3 text-[12px] font-semibold text-ink">{engine} · idle · static · white face</div>
                <div className="flex items-end justify-between gap-3">
                  {avatarRendererContractSizes.map((size) => (
                    <div key={size} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                      <MausAvatar
                        color={color}
                        avatarDefinition={definition}
                        state="idle"
                        size={size}
                        animated={false}
                        trackPointer={false}
                      />
                      <span className="text-[11px] text-ink-tertiary">{size}px</span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-hairline/40 bg-card p-4">
          <div className="mb-3 text-[12px] font-semibold text-ink">Blobatar optical sizing · equal 112px request</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {avatarRendererContractShapeFixtures.map(({ label, definition, color }) => (
              <div key={label} className="flex min-w-0 flex-col items-center gap-2">
                <MausAvatar
                  color={color}
                  avatarDefinition={definition}
                  state="idle"
                  size={112}
                  animated={false}
                  trackPointer={false}
                />
                <span className="text-center text-[11px] text-ink-secondary">{label}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          <section className="flex items-center gap-4 rounded-2xl border border-hairline/40 bg-card p-4">
            <MausAvatar
              color="blue"
              avatarDefinition={avatarRendererContractBlobatar}
              state="alerting"
              size={112}
              animated
              trackPointer={false}
            />
            <div>
              <div className="text-[12px] font-semibold text-ink">Blobatar · alerting · animated</div>
              <div className="mt-1 text-[11px] text-ink-secondary">Shape-agnostic exclamation glyph.</div>
            </div>
          </section>
          <section className="flex items-center gap-4 rounded-2xl border border-hairline/40 bg-card p-4">
            <MausAvatar
              color="purple"
              avatarDefinition={avatarRendererContractLocal}
              state="celebrate"
              size={112}
              animated
              trackPointer={false}
            />
            <div>
              <div className="text-[12px] font-semibold text-ink">CursorAvatar / local procedural · celebrate · animated</div>
              <div className="mt-1 text-[11px] text-ink-secondary">Shared celebration confetti effect.</div>
            </div>
          </section>
        </div>
      </div>
    </Canvas>
  ),
};
