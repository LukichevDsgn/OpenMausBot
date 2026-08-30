import { describe, expect, it } from "vitest";

import {
  mascotExpressionIndex,
  mascotExpressionPatch,
  PICKABLE_STATES,
  stateForBot,
} from "./mascot";

describe("mascot appearance mapping", () => {
  it("keeps legacy expression writes separate from runtime state", () => {
    expect(mascotExpressionPatch("curious")).toEqual({ mascotExpression: "curious" });
    expect(stateForBot({ name: "Bot", mascotExpression: "curious" })).toBe("idle");
  });

  it("lets live signals override the selected resting expression", () => {
    const resting = { name: "Bot", mascotExpression: "happy" as const };
    expect(stateForBot({ ...resting, busy: true })).toBe("working");
    expect(stateForBot({ ...resting, unread: true })).toBe("notifying");
    expect(stateForBot({ ...resting, messages: [{ kind: "options" }] })).toBe("surprised");
    expect(stateForBot({
      ...resting,
      messages: [{ kind: "activity", tool: { ok: false } }],
    })).toBe("alerting");
    expect(stateForBot(resting)).toBe("idle");
  });

  it("keeps every static expression swatch on a distinct resting face", () => {
    const restingFaces = PICKABLE_STATES.map(mascotExpressionIndex);
    expect(new Set(restingFaces).size).toBe(restingFaces.length);
  });
});
