import { describe, expect, it, vi } from "vitest";
import type { Dispatch } from "react";
import {
  createStaticStoreValue,
  initialState,
  type Action,
} from "@/state/store";
import { createFixtureState, fixtureInspectorResponses, fixtureStates, fixtureTeamMapResponses, STORYBOOK_ALLOWED_FAKE_RESPONSES } from "./fixtures";
import { createStorybookFetchGuard, STORYBOOK_NETWORK_GUARD_PREFIX } from "./fetch-guard";

describe("static Storybook catalog", () => {
  it("is deterministic and contains no credential or filesystem payloads", () => {
    expect(createFixtureState()).toEqual(createFixtureState());
    expect(fixtureStates.chiefLocked.bots.find((bot) => bot.id === "chief")?.chiefRuntimePolicyLocked).toBe(true);
    expect(JSON.stringify(fixtureStates)).not.toMatch(/(?:sk-|xai-|C:\\|D:\\|\/Users\/|\/home\/)/i);
  });

  it("keeps panel fake responses explicit and local", () => {
    expect(Object.keys(STORYBOOK_ALLOWED_FAKE_RESPONSES)).toEqual(expect.arrayContaining([
      "/api/team-map",
      "/api/bots/builder/local-computer",
      "/api/threads/chief-thread/events",
      "/api/threads/builder-thread/events",
      "/api/connectors/catalog",
    ]));
    expect(fixtureTeamMapResponses.populated.running).toHaveLength(1);
    expect(fixtureInspectorResponses.populated.entries).toHaveLength(1);
  });

  it("builds a store value from caller-owned state and dispatch only", async () => {
    const dispatch: Dispatch<Action> = vi.fn((_: Action): void => undefined);
    const value = createStaticStoreValue(initialState, dispatch);
    expect(value.state).toBe(initialState);
    expect(value.dispatch).toBe(dispatch);
    await expect(value.flushBotPatches("fixture-bot")).resolves.toBeUndefined();
    await expect(value.refreshInstances()).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("Storybook network guard", () => {
  it("serves only explicitly listed fake responses", async () => {
    const fetch = createStorybookFetchGuard();
    const response = await fetch("/api/health");
    expect(response.headers.get("x-storybook-fake")).toBe("true");
    await expect(response.text()).resolves.toEqual(STORYBOOK_ALLOWED_FAKE_RESPONSES["/api/health"].body);
  });

  it("rejects unexpected requests with the exact isolation error", async () => {
    const fetch = createStorybookFetchGuard();
    await expect(fetch("http://127.0.0.1:8799/api/bots")).rejects.toThrow(
      `${STORYBOOK_NETWORK_GUARD_PREFIX}: unexpected request http://127.0.0.1:8799/api/bots; use an explicit fake response`,
    );
  });
});
