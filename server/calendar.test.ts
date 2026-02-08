import { describe, expect, it } from "vitest"

import { vi } from "vitest"

vi.mock("./storage", () => ({
  storage: {},
}))

vi.mock("./tokens", () => ({
  createActionToken: vi.fn(),
}))

import { mapCalendarEventToTask, stripEventTitlePrefix } from "./calendar"

describe("stripEventTitlePrefix", () => {
  it("removes incomplete prefix", () => {
    expect(stripEventTitlePrefix("☑️ Plan sprint")).toBe("Plan sprint")
  })

  it("removes complete prefix", () => {
    expect(stripEventTitlePrefix("✅ Plan sprint")).toBe("Plan sprint")
  })
})

describe("mapCalendarEventToTask", () => {
  it("maps Todo events into CalendarTask", () => {
    const event = {
      id: "event-1",
      summary: "☑️ Write tests",
      start: { dateTime: "2026-02-08T14:00:00.000Z" },
      end: { dateTime: "2026-02-08T15:00:00.000Z" },
      updated: "2026-02-08T15:30:00.000Z",
      description:
        "Add integration tests\n\nActions:\n- Manage: https://example.com/action\n\n---\nCreated by Todo",
      extendedProperties: {
        private: {
          caltodo: "true",
          caltodoCompleted: "true",
        },
      },
    }

    const task = mapCalendarEventToTask(event)
    expect(task).not.toBeNull()
    expect(task?.title).toBe("Write tests")
    expect(task?.details).toBe("Add integration tests")
    expect(task?.duration).toBe(60)
    expect(task?.completed).toBe(true)
    expect(task?.completedAt).toBe("2026-02-08T15:30:00.000Z")
  })

  it("returns null for non-Todo events", () => {
    const event = {
      id: "event-2",
      summary: "Random calendar event",
      start: { dateTime: "2026-02-08T14:00:00.000Z" },
      end: { dateTime: "2026-02-08T15:00:00.000Z" },
      extendedProperties: { private: {} },
    }

    expect(mapCalendarEventToTask(event)).toBeNull()
  })
})
