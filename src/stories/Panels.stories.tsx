import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { ChatView } from "@/components/ChatView";
import { ComputerPanel } from "@/components/ComputerPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { PhoneSetupFlowView } from "@/components/PhoneSetupFlow";
import { PluginsPanel } from "@/components/PluginsPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar } from "@/components/Sidebar";
import { SkillsDialog } from "@/components/SkillsDialog";
import { TeamMapPage } from "@/components/TeamMapPage";
import { fixtureBots, fixturePhoneController, fixtureSkills, fixtureStates, fixtureTeamMapResponses, STORYBOOK_ALLOWED_FAKE_RESPONSES } from "@/storybook/fixtures";
import { createStorybookFetchGuard, type StorybookFakeResponseMap } from "@/storybook/fetch-guard";
import { StorybookProvider } from "@/storybook/StaticStorybookProvider";
import type { AppState } from "@/state/store";
import { SIDEBAR_DENSITY_KEY } from "@/lib/sidebar-preferences";

const meta = {
  title: "Panels / Product surfaces",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function PanelCanvas({ children, className = "min-h-screen" }: { children: ReactNode; className?: string }) {
  return <div className={`bg-app text-ink ${className}`}>{children}</div>;
}

function PanelStory({ state = fixtureStates.default, children, className }: { state?: AppState; children: ReactNode; className?: string }) {
  return (
    <StorybookProvider state={state}>
      <PanelCanvas className={className}>{children}</PanelCanvas>
    </StorybookProvider>
  );
}

function ScopedFetch({ allowed, children }: { allowed: StorybookFakeResponseMap; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const original = globalThis.fetch;
    globalThis.fetch = createStorybookFetchGuard(allowed);
    setReady(true);
    return () => {
      globalThis.fetch = original;
    };
  }, [allowed]);
  return ready ? children : null;
}

function SidebarIconOnlyStory() {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const previous = localStorage.getItem(SIDEBAR_DENSITY_KEY);
    localStorage.setItem(SIDEBAR_DENSITY_KEY, "icons");
    setReady(true);
    return () => {
      if (previous === null) localStorage.removeItem(SIDEBAR_DENSITY_KEY);
      else localStorage.setItem(SIDEBAR_DENSITY_KEY, previous);
    };
  }, []);
  if (!ready) return null;
  return (
    <PanelStory state={fixtureStates.sidebarLongNames}>
      <div className="h-screen w-[260px] overflow-hidden bg-app">
        <Sidebar open onClose={() => undefined} />
      </div>
    </PanelStory>
  );
}

export const SettingsModalDefault: Story = {
  render: () => <PanelStory><SettingsModal /></PanelStory>,
};

export const SettingsModalSkillsSection: Story = {
  render: () => <PanelStory state={{ ...fixtureStates.default, appSettingsSection: "skills" }}><SettingsModal /></PanelStory>,
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export const SidebarPopulated: Story = {
  render: () => <PanelStory><Sidebar open onClose={() => undefined} /></PanelStory>,
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const SidebarEmpty: Story = {
  render: () => <PanelStory state={fixtureStates.sidebarEmpty}><Sidebar open onClose={() => undefined} /></PanelStory>,
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const SidebarError: Story = {
  render: () => <PanelStory state={fixtureStates.sidebarError}><Sidebar open onClose={() => undefined} /></PanelStory>,
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const SidebarLongNames: Story = {
  render: () => <PanelStory state={fixtureStates.sidebarLongNames}><Sidebar open onClose={() => undefined} /></PanelStory>,
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const SidebarIconOnlyProjects: Story = {
  render: () => <SidebarIconOnlyStory />,
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const ChatViewChiefCompactHeader: Story = {
  render: () => (
    <PanelStory>
      <div className="flex h-screen justify-center overflow-hidden bg-app">
        <div className="h-full w-[680px] overflow-hidden bg-app">
          <ChatView bot={fixtureBots[0]!} />
        </div>
      </div>
    </PanelStory>
  ),
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export const ComputerPanelDisconnected: Story = {
  render: () => {
    const bot = fixtureStates.computerDisconnected.bots.find((entry) => entry.id === "builder")!;
    return <PanelStory state={fixtureStates.computerDisconnected}><ComputerPanel bot={bot} /></PanelStory>;
  },
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const InspectorPopulated: Story = {
  render: () => (
    <PanelStory>
      <InspectorPanel bot={fixtureBots[0]!} />
    </PanelStory>
  ),
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const InspectorEmpty: Story = {
  render: () => (
    <PanelStory>
      <InspectorPanel bot={fixtureBots[1]!} />
    </PanelStory>
  ),
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const TeamMapFakeSnapshot: Story = {
  render: () => (
    <ScopedFetch allowed={STORYBOOK_ALLOWED_FAKE_RESPONSES}>
      <PanelStory><TeamMapPage /></PanelStory>
    </ScopedFetch>
  ),
};

export const TeamMapEmpty: Story = {
  render: () => (
    <ScopedFetch allowed={{ ...STORYBOOK_ALLOWED_FAKE_RESPONSES, "/api/team-map": { body: JSON.stringify(fixtureTeamMapResponses.empty) } }}>
      <PanelStory state={fixtureStates.empty}><TeamMapPage /></PanelStory>
    </ScopedFetch>
  ),
};

export const TeamMapError: Story = {
  render: () => {
    const allowed: StorybookFakeResponseMap = { ...STORYBOOK_ALLOWED_FAKE_RESPONSES };
    delete allowed["/api/team-map"];
    return <ScopedFetch allowed={allowed}><PanelStory><TeamMapPage /></PanelStory></ScopedFetch>;
  },
};

export const SkillsDialogSearchable: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <PanelCanvas>
        <SkillsDialog open={open} skills={fixtureSkills} selectedId="release-notes" initialQuery="research" onSelect={() => setOpen(false)} onClose={() => setOpen(false)} />
      </PanelCanvas>
    );
  },
};

export const SkillsDialogUnselected: Story = {
  render: () => <PanelCanvas><SkillsDialog open skills={fixtureSkills} selectedId={null} onSelect={() => undefined} onClose={() => undefined} /></PanelCanvas>,
};

export const PluginsUnavailable: Story = {
  render: () => <PanelStory><PluginsPanel /></PanelStory>,
};

export const PhoneSetupIntro: Story = {
  render: () => <PanelCanvas><PhoneSetupFlowView controller={fixturePhoneController} variant="settings" /></PanelCanvas>,
};

export const DesktopShellComposition: Story = {
  render: () => (
    <StorybookProvider state={fixtureStates.default}>
      <div className="flex min-h-screen overflow-hidden bg-app text-ink">
        <Sidebar open onClose={() => undefined} />
        <main className="min-w-0 flex-1 p-6">
          <div className="mb-5 border-b border-hairline/40 pb-4">
            <div className="text-[18px] font-semibold">OpenMausBot workspace</div>
            <div className="mt-1 text-[13px] text-ink-secondary">Real sidebar + agent profile composition with a static fixture store.</div>
          </div>
          <div className="flex justify-end">
            <SettingsPanel bot={fixtureBots[0]!} />
          </div>
        </main>
        <SkillsDialog open skills={fixtureSkills} selectedId="release-notes" onSelect={() => undefined} onClose={() => undefined} />
      </div>
    </StorybookProvider>
  ),
  globals: { viewport: { value: "desktop", isRotated: false } },
};
