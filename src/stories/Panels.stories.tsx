import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { TeamLibraryPanel } from "@/components/TeamLibraryPanel";
import { createFixtureState, fixtureBots, fixturePhoneController, fixtureSkills, fixtureStates, fixtureTeamMapResponses, STORYBOOK_ALLOWED_FAKE_RESPONSES } from "@/storybook/fixtures";
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

function WindowsPlatformStory({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const previous = window.ogb;
    Object.defineProperty(window, "ogb", {
      configurable: true,
      writable: true,
      value: { ...previous, platform: "win32" },
    });
    setReady(true);
    return () => {
      if (previous) {
        Object.defineProperty(window, "ogb", { configurable: true, writable: true, value: previous });
      } else {
        Reflect.deleteProperty(window, "ogb");
      }
    };
  }, []);
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

function TeamLibraryExportStory({ skills = fixtureSkills, state = fixtureStates.default }: { skills?: typeof fixtureSkills; state?: AppState }) {
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const allowed: StorybookFakeResponseMap = {
    ...STORYBOOK_ALLOWED_FAKE_RESPONSES,
    "/api/teams/export/options": {
      body: JSON.stringify({ skills, defaultSelectedSkillIds: skills.map((skill) => skill.id) }),
    },
  };
  return (
    <ScopedFetch allowed={allowed}>
      <PanelStory state={state}>
        <button ref={returnFocusRef} className="sr-only">Open teams</button>
        <TeamLibraryPanel returnFocusRef={returnFocusRef} onClose={() => undefined} onImported={() => undefined} sidebarProjectFilter="Product" />
      </PanelStory>
    </ScopedFetch>
  );
}

const exportScopeFixtureState = createFixtureState({
  bots: fixtureBots.map((bot) => bot.id === "chief"
    ? { ...bot, name: "Nano Banana 2", section: "Nano Banana 2" }
    : bot.id === "builder" ? { ...bot, name: "Onlook", section: "Onlook" } : { ...bot, section: "Onlook" }),
});

const grokImportPackage = {
  format: "openmaus.package",
  version: 1,
  package: {
    name: "Grok research team",
    summary: "A direct research partner for clear answers and useful pushback.",
    author: { name: "xAI" },
    agents: [
      {
        key: "grok",
        name: "Grok",
        title: "Research assistant",
        description: "Answer clearly, challenge assumptions, and show your work.\n\nUse public sources when a claim needs verification.",
        appearance: {
          color: "cyan",
          avatarDefinition: {
            version: 1,
            seed: "grok-bot",
            silhouette: "orb",
            eyeStyle: "calm",
            mouthStyle: "soft",
            expressionPreset: "warm",
            avatarPresetId: "grok-bot",
            restingAnimationId: "idle",
          },
          mascotExpression: "curious",
        },
      },
    ],
    rooms: [{ name: "Research" }],
    playbooks: [{ name: "Source check" }],
    routines: [{ name: "Weekly review" }],
    requirements: { apps: [{ label: "Web search" }] },
  },
} as const;

const grokTeamPackage = {
  ...grokImportPackage,
  package: {
    ...grokImportPackage.package,
    name: "Grok research team",
    agents: [
      { ...grokImportPackage.package.agents[0], name: "Nova", title: "Chief of Staff" },
      {
        key: "editor",
        name: "Editor",
        title: "Synthesis editor",
        description: "Turn the research into a concise, readable brief.",
        appearance: {
          color: "purple",
          avatarDefinition: {
            version: 1,
            seed: "editor",
            silhouette: "gem",
            eyeStyle: "balanced",
            mouthStyle: "soft",
            restingAnimationId: "idle",
          },
          mascotExpression: "proud",
        },
      },
      {
        key: "analyst",
        name: "Nova Analyst",
        title: "Evidence analyst",
        description: "Checks sources and records confidence.",
        appearance: { color: "green" },
      },
      {
        key: "operator",
        name: "Nova Operator",
        title: "Workflow operator",
        description: "Keeps the research workflow moving.",
        appearance: { color: "orange" },
      },
    ],
    chiefOfStaff: "grok",
    rooms: [{ name: "Research room", members: ["grok", "editor", "analyst", "operator"], bulletin: "Weekly search review stays visible here.", defaultResponder: { kind: "agent", agent: "grok" } }],
    playbooks: [
      { name: "Source check", summary: "Verify claims", triggers: ["source check"], instructions: "Keep the source URL and confidence." },
      { name: "Weekly search review", summary: "Review the latest search findings", triggers: ["weekly review"], instructions: "Compare new findings with the last brief." },
      { name: "Brief synthesis", summary: "Turn evidence into a concise brief", triggers: ["synthesis"], instructions: "Separate facts, inference, and open questions." },
    ],
    routines: [{ name: "Weekly search review", agent: "grok", prompt: "Review the latest search findings and prepare a source-led brief.", runOn: "maus", schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 30, enabledAfterInstall: false }],
    requirements: { apps: [{ label: "Google Sheets", reason: "Record the review log", optional: false }] },
  },
} as const;

function TeamLibraryGrokImportStory({ multi = false }: { multi?: boolean }) {
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const allowed: StorybookFakeResponseMap = {
    ...STORYBOOK_ALLOWED_FAKE_RESPONSES,
    "/api/team-library/grok": { body: JSON.stringify(multi ? grokTeamPackage : grokImportPackage) },
  };
  return (
    <ScopedFetch allowed={allowed}>
      <PanelStory>
        <button ref={returnFocusRef} className="sr-only">Open teams</button>
        <TeamLibraryPanel returnFocusRef={returnFocusRef} onClose={() => undefined} onImported={() => undefined} initialUrl="grokbot://grok/research" />
      </PanelStory>
    </ScopedFetch>
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

export const TeamLibraryExportSharePopulated: Story = {
  render: () => <TeamLibraryExportStory state={exportScopeFixtureState} />,
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export const TeamLibraryExportShareEmptySkills: Story = {
  render: () => <TeamLibraryExportStory skills={[]} />,
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export const TeamLibraryExportShareNarrow: Story = {
  render: () => <TeamLibraryExportStory state={exportScopeFixtureState} />,
  globals: { viewport: { value: "panel", isRotated: false } },
};

export const TeamLibraryGrokBotDetails: Story = {
  render: () => <TeamLibraryGrokImportStory />,
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export const TeamLibraryGrokTeamDetails: Story = {
  render: () => <TeamLibraryGrokImportStory multi />,
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export const TeamLibraryGrokBotDetailsNarrow: Story = {
  render: () => <TeamLibraryGrokImportStory />,
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

export const ChatViewChiefFullHeader: Story = {
  render: () => (
    <WindowsPlatformStory>
      <PanelStory>
        <div className="h-screen min-w-0 overflow-hidden bg-app">
          <ChatView bot={fixtureBots[0]!} />
        </div>
      </PanelStory>
    </WindowsPlatformStory>
  ),
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export const ChatViewChiefInspectorOpen: Story = {
  render: () => (
    <WindowsPlatformStory>
      <ScopedFetch allowed={STORYBOOK_ALLOWED_FAKE_RESPONSES}>
        <StorybookProvider state={{ ...fixtureStates.default, inspectorOpen: true, computerOpen: false }}>
          <div className="flex h-screen min-w-0 overflow-hidden bg-app text-ink">
            <Sidebar open onClose={() => undefined} />
            <main className="min-w-0 flex-1">
              <ChatView bot={fixtureBots[0]!} />
            </main>
            <aside className="w-[430px] shrink-0 overflow-hidden border-l border-hairline/40">
              <InspectorPanel bot={fixtureBots[0]!} />
            </aside>
          </div>
        </StorybookProvider>
      </ScopedFetch>
    </WindowsPlatformStory>
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
