import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Routine } from "@/lib/routines";

let routineScheduleLabel: (routine: Routine) => string;

beforeAll(async () => {
  vi.stubGlobal("window", {});
  ({ routineScheduleLabel } = await import("./ComputerPanel"));
});

const manualRoutine: Routine = {
  id: "routine-manual-test",
  name: "Manual test routine",
  prompt: "Use only local fake data.",
  botId: "bot-test",
  runOn: "maus",
  enabled: false,
  schedule: { type: "manual" },
  durationMinutes: 5,
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0,
};

describe("manual routine UI copy", () => {
  it("labels manual routines as manual-only", () => {
    expect(routineScheduleLabel(manualRoutine)).toBe("Manual only");
  });
});
