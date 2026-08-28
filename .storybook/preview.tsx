import type { Preview } from "@storybook/react-vite";
import { applySkin, SKINS, type SkinId } from "@/lib/skins";
import "../src/styles.css";
import { installStorybookFetchGuard } from "../src/storybook/fetch-guard";

installStorybookFetchGuard();

function isSkinId(value: string | undefined): value is SkinId {
  return SKINS.some((entry) => entry.id === value);
}

const preview = {
  globalTypes: {
    skin: {
      description: "OpenMausBot skin",
      defaultValue: "midnight",
      toolbar: {
        icon: "paintbrush",
        items: SKINS.map((skin) => ({ value: skin.id, title: skin.name })),
      },
    },
  },
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "app",
      values: [
        { name: "app", value: "var(--color-app)" },
        { name: "panel", value: "var(--color-panel)" },
        { name: "inset", value: "var(--color-inset)" },
      ],
    },
    viewport: {
      options: {
        desktop: { name: "Desktop 1440", styles: { width: "1440px", height: "900px" } },
        panel: { name: "Panel 400", styles: { width: "400px", height: "900px" } },
        narrow: { name: "Narrow 360", styles: { width: "360px", height: "800px" } },
      },
    },
    a11y: { test: "todo" },
  },
  initialGlobals: {
    viewport: { value: "desktop", isRotated: false },
  },
  decorators: [
    (Story: React.ComponentType, context: { globals: { skin?: string } }) => {
      const skin = isSkinId(context.globals.skin) ? context.globals.skin : "midnight";
      applySkin(skin);
      return <Story />;
    },
  ],
} satisfies Preview;

export default preview;
