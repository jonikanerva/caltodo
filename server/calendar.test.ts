import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("./storage", () => ({
  storage: {
    getUser: vi.fn(),
    updateUser: vi.fn(),
    getUserSettings: vi.fn(),
  },
}))

vi.mock("./tokens", () => ({
  createActionToken: vi.fn(),
}))

import {
  mapCalendarEventToTask,
  stripEventTitlePrefix,
  listCalendarEventsInRange,
  EVENT_DELETED,
} from "./calendar"
import type { calendar_v3 } from "googleapis"

describe("stripEventTitlePrefix", () => {
  it("removes incomplete prefix", () => {
    expect(stripEventTitlePrefix("☑️ Plan sprint")).toBe("Plan sprint")
  })

  it("removes complete prefix", () => {
    expect(stripEventTitlePrefix("✅ Plan sprint")).toBe("Plan sprint")
  })

  it("returns original string when no prefix", () => {
    expect(stripEventTitlePrefix("Regular meeting")).toBe("Regular meeting")
  })

  it("handles empty string", () => {
    expect(stripEventTitlePrefix("")).toBe("")
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
        "Add integration tests\n\nActions:\n- Manage: https://example.com/action\n\n---\n" +
        "Created by Todo",
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

  it("returns null for events missing id", () => {
    const event = {
      summary: "☑️ Task without id",
      start: { dateTime: "2026-02-08T14:00:00.000Z" },
      end: { dateTime: "2026-02-08T15:00:00.000Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    expect(mapCalendarEventToTask(event)).toBeNull()
  })

  it("returns null for events missing start dateTime", () => {
    const event = {
      id: "event-3",
      summary: "☑️ All day event",
      start: { date: "2026-02-08" },
      end: { dateTime: "2026-02-08T15:00:00.000Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    expect(mapCalendarEventToTask(event)).toBeNull()
  })

  it("returns null for events missing end dateTime", () => {
    const event = {
      id: "event-4",
      summary: "☑️ Incomplete event",
      start: { dateTime: "2026-02-08T14:00:00.000Z" },
      end: { date: "2026-02-08" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    expect(mapCalendarEventToTask(event)).toBeNull()
  })

  it("maps incomplete tasks correctly", () => {
    const event = {
      id: "event-5",
      summary: "☑️ Pending task",
      start: { dateTime: "2026-02-08T09:00:00.000Z" },
      end: { dateTime: "2026-02-08T09:30:00.000Z" },
      extendedProperties: {
        private: {
          caltodo: "true",
          caltodoCompleted: "false",
        },
      },
    }

    const task = mapCalendarEventToTask(event)
    expect(task).not.toBeNull()
    expect(task?.completed).toBe(false)
    expect(task?.completedAt).toBeNull()
    expect(task?.duration).toBe(30)
  })

  it("extracts details from description", () => {
    const event = {
      id: "event-6",
      summary: "☑️ Task with details",
      start: { dateTime: "2026-02-08T10:00:00.000Z" },
      end: { dateTime: "2026-02-08T11:00:00.000Z" },
      description:
        "First line\nSecond line\n\nActions:\n- Manage: link\n\n---\nCreated by Todo",
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    }

    const task = mapCalendarEventToTask(event)
    expect(task?.details).toBe("First line\nSecond line")
  })

  it("handles tasks with no description", () => {
    const event = {
      id: "event-7",
      summary: "☑️ No description task",
      start: { dateTime: "2026-02-08T10:00:00.000Z" },
      end: { dateTime: "2026-02-08T10:15:00.000Z" },
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    }

    const task = mapCalendarEventToTask(event)
    expect(task).not.toBeNull()
    expect(task?.details).toBeNull()
    expect(task?.duration).toBe(15)
  })

  it("handles legacy Mark Complete action links", () => {
    const event = {
      id: "event-8",
      summary: "☑️ Legacy task",
      start: { dateTime: "2026-02-08T10:00:00.000Z" },
      end: { dateTime: "2026-02-08T11:00:00.000Z" },
      description:
        "My details\n\nActions:\n- Mark Complete: legacy-link\n\n---\nCreated by Todo",
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    }

    const task = mapCalendarEventToTask(event)
    expect(task?.details).toBe("My details")
  })
})

describe("listCalendarEventsInRange", () => {
  it("returns events from calendar API", async () => {
    const mockEvents = [
      { id: "1", summary: "Event 1" },
      { id: "2", summary: "Event 2" },
    ]

    const mockCalendar = {
      events: {
        list: vi.fn().mockResolvedValue({ data: { items: mockEvents } }),
      },
    } as unknown as calendar_v3.Calendar

    const result = await listCalendarEventsInRange(
      mockCalendar,
      "primary",
      new Date("2026-02-01"),
      new Date("2026-02-28"),
    )

    expect(result).toHaveLength(2)
    expect(mockCalendar.events.list).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: expect.any(String),
      timeMax: expect.any(String),
      singleEvents: true,
      orderBy: "startTime",
    })
  })

  it("returns empty array when API returns no items", async () => {
    const mockCalendar = {
      events: {
        list: vi.fn().mockResolvedValue({ data: {} }),
      },
    } as unknown as calendar_v3.Calendar

    const result = await listCalendarEventsInRange(
      mockCalendar,
      "primary",
      new Date("2026-02-01"),
      new Date("2026-02-28"),
    )

    expect(result).toEqual([])
  })

  it("returns empty array on API error", async () => {
    const mockCalendar = {
      events: {
        list: vi.fn().mockRejectedValue(new Error("API error")),
      },
    } as unknown as calendar_v3.Calendar

    const result = await listCalendarEventsInRange(
      mockCalendar,
      "primary",
      new Date("2026-02-01"),
      new Date("2026-02-28"),
    )

    expect(result).toEqual([])
  })
})

describe("EVENT_DELETED marker", () => {
  it("has correct value", () => {
    expect(EVENT_DELETED).toBe("__EVENT_DELETED__")
  })
})

describe("duration calculation", () => {
  it("calculates 60 minute duration correctly", () => {
    const event = {
      id: "dur-1",
      summary: "☑️ 1 hour task",
      start: { dateTime: "2026-02-08T09:00:00.000Z" },
      end: { dateTime: "2026-02-08T10:00:00.000Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    expect(mapCalendarEventToTask(event)?.duration).toBe(60)
  })

  it("calculates 15 minute duration correctly", () => {
    const event = {
      id: "dur-2",
      summary: "☑️ Quick task",
      start: { dateTime: "2026-02-08T09:00:00.000Z" },
      end: { dateTime: "2026-02-08T09:15:00.000Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    expect(mapCalendarEventToTask(event)?.duration).toBe(15)
  })

  it("calculates 90 minute duration correctly", () => {
    const event = {
      id: "dur-3",
      summary: "☑️ Long task",
      start: { dateTime: "2026-02-08T09:00:00.000Z" },
      end: { dateTime: "2026-02-08T10:30:00.000Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    expect(mapCalendarEventToTask(event)?.duration).toBe(90)
  })
})

describe("completion state handling", () => {
  it("uses updated timestamp for completedAt when completed", () => {
    const event = {
      id: "comp-1",
      summary: "✅ Done task",
      start: { dateTime: "2026-02-08T09:00:00.000Z" },
      end: { dateTime: "2026-02-08T10:00:00.000Z" },
      updated: "2026-02-08T11:30:00.000Z",
      extendedProperties: {
        private: { caltodo: "true", caltodoCompleted: "true" },
      },
    }

    const task = mapCalendarEventToTask(event)
    expect(task?.completedAt).toBe("2026-02-08T11:30:00.000Z")
  })

  it("uses end time when no updated timestamp and completed", () => {
    const event = {
      id: "comp-2",
      summary: "✅ Done task",
      start: { dateTime: "2026-02-08T09:00:00.000Z" },
      end: { dateTime: "2026-02-08T10:00:00.000Z" },
      extendedProperties: {
        private: { caltodo: "true", caltodoCompleted: "true" },
      },
    }

    const task = mapCalendarEventToTask(event)
    expect(task?.completedAt).toBe("2026-02-08T10:00:00.000Z")
  })

  it("sets completedAt to null for incomplete tasks", () => {
    const event = {
      id: "comp-3",
      summary: "☑️ Pending task",
      start: { dateTime: "2026-02-08T09:00:00.000Z" },
      end: { dateTime: "2026-02-08T10:00:00.000Z" },
      updated: "2026-02-08T11:30:00.000Z",
      extendedProperties: {
        private: { caltodo: "true", caltodoCompleted: "false" },
      },
    }

    const task = mapCalendarEventToTask(event)
    expect(task?.completedAt).toBeNull()
  })
})

describe("ISO date formatting", () => {
  it("outputs scheduledStart in ISO format", () => {
    const event = {
      id: "iso-1",
      summary: "☑️ Task",
      start: { dateTime: "2026-02-08T14:30:00.000Z" },
      end: { dateTime: "2026-02-08T15:30:00.000Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    const task = mapCalendarEventToTask(event)
    expect(task?.scheduledStart).toBe("2026-02-08T14:30:00.000Z")
    expect(task?.scheduledEnd).toBe("2026-02-08T15:30:00.000Z")
  })
})

describe("priority default", () => {
  it("sets priority to 0 by default", () => {
    const event = {
      id: "pri-1",
      summary: "☑️ Task",
      start: { dateTime: "2026-02-08T14:00:00.000Z" },
      end: { dateTime: "2026-02-08T15:00:00.000Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    const task = mapCalendarEventToTask(event)
    expect(task?.priority).toBe(0)
  })
})
