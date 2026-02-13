import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

const mocks = vi.hoisted(() => {
  const mockStorage = {
    getUser: vi.fn(),
    updateUser: vi.fn(),
    getUserSettings: vi.fn(),
    createActionToken: vi.fn(),
    markActionTokenUsed: vi.fn(),
    invalidateActionTokensForEvent: vi.fn(),
  }

  const mockCalendarEvents = {
    list: vi.fn(),
    insert: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  }

  const mockOAuth2Client = {
    setCredentials: vi.fn(),
    on: vi.fn(),
  }

  const mockTokens = {
    createActionToken: vi.fn(),
  }

  return {
    storage: mockStorage,
    calendarEvents: mockCalendarEvents,
    oauth2Client: mockOAuth2Client,
    tokens: mockTokens,
  }
})

vi.mock("./storage", () => ({
  storage: mocks.storage,
}))

vi.mock("./tokens", () => ({
  createActionToken: mocks.tokens.createActionToken,
}))

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn(function () {
        return mocks.oauth2Client
      }),
    },
    calendar: vi.fn(() => ({ events: mocks.calendarEvents })),
  },
}))

import {
  mapCalendarEventToTask,
  stripEventTitlePrefix,
  listCalendarEventsInRange,
  EVENT_DELETED,
  findFreeSlot,
  getCalendarClient,
  rescheduleAllUserTasks,
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
      start: { date: "2026-02-08" }, // All-day event, no dateTime
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

    mocks.calendarEvents.list.mockResolvedValue({ data: { items: mockEvents } })

    const result = await listCalendarEventsInRange(
      { events: mocks.calendarEvents } as unknown as calendar_v3.Calendar,
      "primary",
      new Date("2026-02-01"),
      new Date("2026-02-28"),
    )

    expect(result).toHaveLength(2)
    expect(mocks.calendarEvents.list).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: expect.any(String),
      timeMax: expect.any(String),
      singleEvents: true,
      orderBy: "startTime",
    })
  })

  it("returns empty array when API returns no items", async () => {
    mocks.calendarEvents.list.mockResolvedValue({ data: {} })

    const result = await listCalendarEventsInRange(
      { events: mocks.calendarEvents } as unknown as calendar_v3.Calendar,
      "primary",
      new Date("2026-02-01"),
      new Date("2026-02-28"),
    )

    expect(result).toEqual([])
  })

  it("returns empty array on API error", async () => {
    mocks.calendarEvents.list.mockRejectedValue(new Error("API error"))

    const result = await listCalendarEventsInRange(
      { events: mocks.calendarEvents } as unknown as calendar_v3.Calendar,
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

describe("getCalendarClient", () => {
  it("returns null if user not found or no access token", async () => {
    mocks.storage.getUser.mockResolvedValue(null)
    const client = await getCalendarClient("user-1")
    expect(client).toBeNull()
  })

  it("returns calendar client and sets credentials", async () => {
    mocks.storage.getUser.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    })

    const client = await getCalendarClient("user-1")
    // The client returned is defined by what we mock in googleapis
    // google.calendar() returns { events: mocks.calendarEvents }
    expect(client).toBeDefined()
    expect(mocks.oauth2Client.setCredentials).toHaveBeenCalledWith({
      access_token: "access-token",
      refresh_token: "refresh-token",
    })
  })
})

describe("findFreeSlot", () => {
  const userId = "user-1"
  const settings = {
    userId,
    calendarId: "primary",
    timezone: "UTC",
    workStartHour: 9,
    workEndHour: 17,
    eventColor: "1",
    defaultDuration: 30,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storage.getUser.mockResolvedValue({
      accessToken: "token",
      refreshToken: "refresh",
    })
  })

  it("finds first available slot in empty calendar", async () => {
    mocks.calendarEvents.list.mockResolvedValue({ data: { items: [] } })

    const now = new Date("2026-02-09T10:00:00Z") // Monday 10 AM
    const slot = await findFreeSlot(userId, settings, 60, now)

    expect(slot).not.toBeNull()
    expect(slot?.start.toISOString()).toBe("2026-02-09T10:00:00.000Z")
    expect(slot?.end.toISOString()).toBe("2026-02-09T11:00:00.000Z")
  })

  it("respects work start hour", async () => {
    mocks.calendarEvents.list.mockResolvedValue({ data: { items: [] } })

    const now = new Date("2026-02-09T08:00:00Z") // Monday 8 AM (before 9 AM start)
    const slot = await findFreeSlot(userId, settings, 60, now)

    expect(slot).not.toBeNull()
    expect(slot?.start.toISOString()).toBe("2026-02-09T09:00:00.000Z")
  })

  it("skips weekends", async () => {
    mocks.calendarEvents.list.mockResolvedValue({ data: { items: [] } })

    const now = new Date("2026-02-07T10:00:00Z") // Saturday 10 AM
    const slot = await findFreeSlot(userId, settings, 60, now)

    expect(slot).not.toBeNull()
    // Should skip Sat/Sun and go to Monday 9 AM
    expect(slot?.start.toISOString()).toBe("2026-02-09T09:00:00.000Z")
  })

  it("avoids busy intervals", async () => {
    mocks.calendarEvents.list.mockResolvedValue({
      data: {
        items: [
          {
            start: { dateTime: "2026-02-09T10:00:00Z" },
            end: { dateTime: "2026-02-09T11:00:00Z" },
          },
        ],
      },
    })

    const now = new Date("2026-02-09T09:30:00Z") // Monday 9:30 AM
    const slot = await findFreeSlot(userId, settings, 60, now)

    expect(slot).not.toBeNull()
    expect(slot?.start.toISOString()).toBe("2026-02-09T11:00:00.000Z")
  })

  it("advances to next day if task doesn't fit in current work hours", async () => {
    mocks.calendarEvents.list.mockResolvedValue({ data: { items: [] } })

    const now = new Date("2026-02-09T16:30:00Z") // Monday 4:30 PM
    // 60 min task would end at 17:30, which is > 17:00 work end
    const slot = await findFreeSlot(userId, settings, 60, now)

    expect(slot).not.toBeNull()
    // Should move to Tuesday 9 AM
    expect(slot?.start.toISOString()).toBe("2026-02-10T09:00:00.000Z")
  })

  it("handles timezone conversions", async () => {
    const pstSettings = { ...settings, timezone: "America/Los_Angeles" }
    mocks.calendarEvents.list.mockResolvedValue({ data: { items: [] } })

    // 9 AM PST is 17:00 UTC
    const now = new Date("2026-02-09T17:00:00Z")
    const slot = await findFreeSlot(userId, pstSettings, 60, now)

    expect(slot).not.toBeNull()
    expect(slot?.start.toISOString()).toBe("2026-02-09T17:00:00.000Z")
  })

  it.each([
    {
      name: "end-of-day overflow to next workday",
      nowIso: "2026-02-09T16:45:00.000Z",
      duration: 30,
      expectedStartIso: "2026-02-10T09:00:00.000Z",
    },
    {
      name: "weekend rollover",
      nowIso: "2026-02-07T14:00:00.000Z",
      duration: 30,
      expectedStartIso: "2026-02-09T09:00:00.000Z",
    },
    {
      name: "duration exceeds remaining work window",
      nowIso: "2026-02-09T15:45:00.000Z",
      duration: 90,
      expectedStartIso: "2026-02-10T09:00:00.000Z",
    },
  ])("$name", async ({ nowIso, duration, expectedStartIso }) => {
    mocks.calendarEvents.list.mockResolvedValue({ data: { items: [] } })

    const slot = await findFreeSlot(userId, settings, duration, new Date(nowIso))

    expect(slot).not.toBeNull()
    expect(slot?.start.toISOString()).toBe(expectedStartIso)
  })

  it("supports DST boundary in America/New_York with deterministic output", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"))
      mocks.calendarEvents.list.mockResolvedValue({ data: { items: [] } })

      const easternSettings = { ...settings, timezone: "America/New_York" }
      const slot = await findFreeSlot(
        userId,
        easternSettings,
        60,
        new Date("2026-03-08T20:30:00.000Z"),
      )

      expect(slot).not.toBeNull()
      expect(slot?.start.toISOString()).toBe("2026-03-09T13:00:00.000Z")
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps parity between prefetched and live-list paths", async () => {
    const prefetchedWindowStart = new Date("2026-02-09T00:00:00.000Z")
    const prefetchedWindowEnd = new Date("2026-06-01T00:00:00.000Z")
    const events = [
      {
        id: "busy-1",
        start: { dateTime: "2026-02-09T09:00:00.000Z" },
        end: { dateTime: "2026-02-09T09:30:00.000Z" },
      },
    ]
    const now = new Date("2026-02-09T09:00:00.000Z")

    mocks.calendarEvents.list.mockResolvedValue({ data: { items: events } })
    const liveSlot = await findFreeSlot(userId, settings, 30, now)
    mocks.calendarEvents.list.mockClear()

    const prefetchedSlot = await findFreeSlot(userId, settings, 30, now, false, {
      events,
      timeMin: prefetchedWindowStart,
      timeMax: prefetchedWindowEnd,
    })

    expect(liveSlot?.start.toISOString()).toBe("2026-02-09T09:30:00.000Z")
    expect(prefetchedSlot?.start.toISOString()).toBe("2026-02-09T09:30:00.000Z")
    expect(mocks.calendarEvents.list).not.toHaveBeenCalled()
  })

  it("excludes Todo events when excludeTodoEvents is true", async () => {
    const todoBusy = {
      id: "todo-1",
      start: { dateTime: "2026-02-09T09:00:00.000Z" },
      end: { dateTime: "2026-02-09T10:00:00.000Z" },
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    }
    mocks.calendarEvents.list.mockResolvedValue({ data: { items: [todoBusy] } })
    const now = new Date("2026-02-09T09:00:00.000Z")

    const includeTodoSlot = await findFreeSlot(userId, settings, 30, now, false)
    const excludeTodoSlot = await findFreeSlot(userId, settings, 30, now, true)

    expect(includeTodoSlot?.start.toISOString()).toBe("2026-02-09T10:00:00.000Z")
    expect(excludeTodoSlot?.start.toISOString()).toBe("2026-02-09T09:00:00.000Z")
  })
})

describe("rescheduleAllUserTasks", () => {
  const userId = "user-1"
  const settings = {
    userId,
    calendarId: "primary",
    timezone: "UTC",
    workStartHour: 9,
    workEndHour: 17,
    eventColor: "1",
    defaultDuration: 30,
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-02-08T10:00:00Z")) // Sunday

    vi.clearAllMocks()
    mocks.storage.getUser.mockResolvedValue({
      accessToken: "token",
      refreshToken: "refresh",
    })
    mocks.storage.getUserSettings.mockResolvedValue(settings)
    mocks.calendarEvents.patch.mockResolvedValue({ data: {} })
    mocks.calendarEvents.get.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does nothing if settings not found", async () => {
    mocks.storage.getUserSettings.mockResolvedValue(null)
    await rescheduleAllUserTasks(userId)
    expect(mocks.calendarEvents.list).not.toHaveBeenCalled()
  })

  it("does nothing if calendar client init fails", async () => {
    mocks.storage.getUser.mockResolvedValue(null)
    await rescheduleAllUserTasks(userId)
    expect(mocks.calendarEvents.list).not.toHaveBeenCalled()
  })

  it("reschedules overlapping tasks", async () => {
    const task1 = {
      id: "task-1",
      start: { dateTime: "2026-02-09T09:00:00Z" },
      end: { dateTime: "2026-02-09T10:00:00Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }
    const busyEvent = {
      id: "busy-1",
      start: { dateTime: "2026-02-09T09:00:00Z" }, // Conflict!
      end: { dateTime: "2026-02-09T09:30:00Z" },
    }

    mocks.calendarEvents.list.mockResolvedValue({
      data: { items: [busyEvent, task1] },
    })

    mocks.calendarEvents.get.mockImplementation(({ eventId }: any) => {
      if (eventId === "task-1") return { data: task1 }
      return { data: busyEvent }
    })

    await rescheduleAllUserTasks(userId)

    expect(mocks.calendarEvents.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "primary",
        eventId: "task-1",
        requestBody: expect.objectContaining({
          start: expect.objectContaining({
            dateTime: "2026-02-09T09:30:00.000Z",
          }),
        }),
      }),
    )
  })

  it("prioritizes specified event IDs", async () => {
    const busyEvent = {
      id: "busy-1",
      start: { dateTime: "2026-02-09T09:00:00Z" },
      end: { dateTime: "2026-02-09T09:30:00Z" },
    }
    const highPri = {
      id: "high-pri",
      start: { dateTime: "2026-02-09T11:00:00Z" },
      end: { dateTime: "2026-02-09T11:30:00Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }
    const lowPri = {
      id: "low-pri",
      start: { dateTime: "2026-02-09T09:00:00Z" },
      end: { dateTime: "2026-02-09T09:30:00Z" },
      extendedProperties: { private: { caltodo: "true" } },
    }

    mocks.calendarEvents.list.mockResolvedValue({
      data: { items: [busyEvent, highPri, lowPri] },
    })
    mocks.calendarEvents.get.mockImplementation(({ eventId }: { eventId: string }) => {
      if (eventId === "high-pri") return { data: highPri }
      if (eventId === "low-pri") return { data: lowPri }
      return { data: busyEvent }
    })

    await rescheduleAllUserTasks(userId, ["high-pri"])

    // Expect high-pri to be moved to 09:30 (first free slot after the busy event)
    expect(mocks.calendarEvents.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "high-pri",
        requestBody: expect.objectContaining({
          start: expect.objectContaining({ dateTime: "2026-02-09T09:30:00.000Z" }),
        }),
      }),
    )

    // And low-pri should be moved to the next slot (10:00)
    expect(mocks.calendarEvents.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "low-pri",
        requestBody: expect.objectContaining({
          start: expect.objectContaining({ dateTime: "2026-02-09T10:00:00.000Z" }),
        }),
      }),
    )
  })
})
