import { describe, expect, it } from "vitest"
import {
  createEmptyRescheduleSummary,
  findSlotFromBusyIntervals,
  getDurationMinutes,
} from "./scheduler"

describe("scheduler", () => {
  it("calculates positive duration in minutes", () => {
    const start = new Date("2026-03-02T10:00:00.000Z")
    const end = new Date("2026-03-02T10:45:00.000Z")
    expect(getDurationMinutes(start, end)).toBe(45)
  })

  it("finds next slot after overlapping busy window", () => {
    const slot = findSlotFromBusyIntervals(
      [
        {
          start: Date.parse("2026-03-02T09:00:00.000Z"),
          end: Date.parse("2026-03-02T09:30:00.000Z"),
        },
      ],
      30,
      {
        timezone: "UTC",
        workStartHour: 9,
        workEndHour: 17,
      },
      new Date("2026-03-02T09:00:00.000Z"),
      new Date("2026-03-03T09:00:00.000Z"),
    )

    expect(slot?.start.toISOString()).toBe("2026-03-02T09:30:00.000Z")
    expect(slot?.end.toISOString()).toBe("2026-03-02T10:00:00.000Z")
  })

  it("skips weekend and schedules on monday work hours", () => {
    const slot = findSlotFromBusyIntervals(
      [],
      30,
      {
        timezone: "UTC",
        workStartHour: 9,
        workEndHour: 17,
      },
      new Date("2026-03-01T12:00:00.000Z"),
      new Date("2026-03-10T00:00:00.000Z"),
    )

    expect(slot?.start.toISOString()).toBe("2026-03-02T09:00:00.000Z")
  })

  it("creates an empty reschedule summary shape", () => {
    expect(createEmptyRescheduleSummary()).toEqual({
      moved: 0,
      unchanged: 0,
      skippedNoSlot: 0,
      skippedInvalid: 0,
      failed: 0,
    })
  })
})
