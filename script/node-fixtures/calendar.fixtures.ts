// Writes crates/domain/tests/fixtures/calendar.golden.json: the Google
// Calendar event format and the task rules of the Node server.
//
// - `mapCalendarEventToTask` outputs for many event shapes.
// - The request bodies that server/calendar.ts sends to Google: the insert
//   of a new task, the description with the action link, the completion
//   patch, and the time patch.
// - `rescheduleAllUserTasks` scenarios: the ordered time patches and the
//   summary counters.
// - The task order of `GET /api/tasks` and the slot swap of
//   `POST /api/tasks/reorder`.
//
// The module mocks follow server/calendar.contract.test.ts. The fake
// `events.list` returns the events that overlap the requested range, like
// Google Calendar for timed events.
import { mkdirSync, writeFileSync } from "fs"
import path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  Object.assign(process.env, {
    TOKEN_ENCRYPTION_KEY: "fixture-token-encryption-key-0123456789abcdef",
    ACTION_TOKEN_SECRET: "fixture-action-token-secret-0123456789abcdef",
    SESSION_SECRET: "fixture-session-secret-0123456789abcdef-xyz",
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  })
  return {
    storage: {
      getUser: vi.fn(),
      updateUser: vi.fn(),
      getUserSettings: vi.fn(),
      markActionTokenUsed: vi.fn(),
      invalidateActionTokensForEvent: vi.fn(),
    },
    calendarEvents: {
      list: vi.fn(),
      insert: vi.fn(),
      patch: vi.fn(),
      get: vi.fn(),
    },
    oauth2Client: { setCredentials: vi.fn(), on: vi.fn() },
    tokens: { createActionToken: vi.fn() },
  }
})

vi.mock("../../server/storage", () => ({ storage: mocks.storage }))
vi.mock("../../server/tokens", () => ({
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
  createCalendarEvent,
  mapCalendarEventToTask,
  refreshCalendarEventActions,
  rescheduleAllUserTasks,
  updateCalendarEventCompletion,
  updateCalendarEventTime,
} from "../../server/calendar"
import {
  createGetTasksHandler,
  createReorderTasksHandler,
} from "../../server/handlers/taskRoutes"
import { createMockResponse } from "../../server/handlers/testUtils"

const ROOT = path.resolve(import.meta.dirname, "..", "..")

type FakeEvent = {
  id?: string
  summary?: string
  description?: string
  status?: string
  transparency?: string
  updated?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  extendedProperties?: { private?: Record<string, string> }
}

const todo = (completed?: boolean) => ({
  private:
    completed === undefined
      ? { caltodo: "true" }
      : { caltodo: "true", caltodoCompleted: completed ? "true" : "false" },
})

const baseSettings = {
  id: "settings-1",
  userId: "user-1",
  calendarId: "primary",
  timezone: "UTC",
  workStartHour: 9,
  workEndHour: 17,
  eventColor: "2",
  defaultDuration: 30,
}

function resetMocks() {
  vi.clearAllMocks()
  mocks.storage.getUser.mockResolvedValue({
    accessToken: "access-1",
    refreshToken: "refresh-1",
  })
  mocks.storage.getUserSettings.mockResolvedValue(baseSettings)
  mocks.tokens.createActionToken.mockResolvedValue({
    id: "tok-id",
    token: "tok-raw",
    tokenHash: "tok-hash",
  })
}

// Google Calendar `events.list` with `singleEvents: true`: the timed events
// that end after timeMin and start before timeMax, ordered by start.
function listOverlapping(events: FakeEvent[]) {
  return async (params: { timeMin: string; timeMax: string }) => {
    const min = Date.parse(params.timeMin)
    const max = Date.parse(params.timeMax)
    const items = events
      .filter((event) => {
        const start = Date.parse(event.start?.dateTime ?? event.start?.date ?? "")
        const end = Date.parse(event.end?.dateTime ?? event.end?.date ?? "")
        return end > min && start < max
      })
      .sort(
        (a, b) =>
          Date.parse(a.start?.dateTime ?? a.start?.date ?? "") -
          Date.parse(b.start?.dateTime ?? b.start?.date ?? ""),
      )
    return { data: { items: structuredClone(items) } }
  }
}

const output: Record<string, unknown> = {
  source:
    "server/calendar.ts and server/handlers/taskRoutes.ts (Node, TZ=UTC) at the commit that adds this file",
}

afterEach(() => {
  vi.useRealTimers()
})

describe("calendar fixtures", () => {
  it("maps calendar events to tasks", () => {
    const events: Array<{ name: string; event: FakeEvent }> = [
      {
        name: "completed with updated time",
        event: {
          id: "e1",
          summary: "✅ Write tests",
          start: { dateTime: "2026-02-08T14:00:00.000Z" },
          end: { dateTime: "2026-02-08T15:00:00.000Z" },
          updated: "2026-02-08T15:30:00.000Z",
          description:
            "Add integration tests\n\nActions:\n- Manage: https://example.com/action/x\n\n---\nCreated by Todo",
          extendedProperties: todo(true),
        },
      },
      {
        name: "completed without updated time",
        event: {
          id: "e2",
          summary: "✅ Done",
          start: { dateTime: "2026-02-08T09:00:00Z" },
          end: { dateTime: "2026-02-08T10:00:00Z" },
          extendedProperties: todo(true),
        },
      },
      {
        name: "incomplete with offset times",
        event: {
          id: "e3",
          summary: "☑️ Offset",
          start: { dateTime: "2026-03-02T10:00:00+02:00" },
          end: { dateTime: "2026-03-02T10:45:00+02:00" },
          updated: "2026-03-01T08:00:00.123Z",
          extendedProperties: todo(false),
        },
      },
      {
        name: "marker without completion flag",
        event: {
          id: "e4",
          summary: "☑️ No flag",
          start: { dateTime: "2026-02-08T09:00:00.000Z" },
          end: { dateTime: "2026-02-08T09:15:00.000Z" },
          extendedProperties: todo(),
        },
      },
      {
        name: "invalid completion flag",
        event: {
          id: "e5",
          summary: "✅ Odd flag",
          start: { dateTime: "2026-02-08T09:00:00.000Z" },
          end: { dateTime: "2026-02-08T09:30:00.000Z" },
          updated: "2026-02-08T11:00:00.000Z",
          extendedProperties: { private: { caltodo: "true", caltodoCompleted: "TRUE" } },
        },
      },
      {
        name: "no marker",
        event: {
          id: "e6",
          summary: "Meeting",
          start: { dateTime: "2026-02-08T09:00:00.000Z" },
          end: { dateTime: "2026-02-08T10:00:00.000Z" },
        },
      },
      {
        name: "marker not exactly true",
        event: {
          id: "e7",
          summary: "☑️ Marker",
          start: { dateTime: "2026-02-08T09:00:00.000Z" },
          end: { dateTime: "2026-02-08T10:00:00.000Z" },
          extendedProperties: { private: { caltodo: "TRUE" } },
        },
      },
      {
        name: "missing id",
        event: {
          summary: "☑️ No id",
          start: { dateTime: "2026-02-08T09:00:00.000Z" },
          end: { dateTime: "2026-02-08T10:00:00.000Z" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "all-day start",
        event: {
          id: "e8",
          summary: "☑️ All day",
          start: { date: "2026-02-08" },
          end: { dateTime: "2026-02-08T10:00:00.000Z" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "all-day end",
        event: {
          id: "e9",
          summary: "☑️ All day end",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { date: "2026-02-09" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "legacy action marker",
        event: {
          id: "e10",
          summary: "☑️ Legacy",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          description:
            "My details\n\nActions:\n- Mark Complete: legacy-link\n- Reschedule: other\n\n---\nCreated by Todo",
          extendedProperties: todo(false),
        },
      },
      {
        name: "signature only",
        event: {
          id: "e11",
          summary: "☑️ Signature",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          description: "---\nCreated by Todo",
          extendedProperties: todo(false),
        },
      },
      {
        name: "details with whitespace and no actions",
        event: {
          id: "e12",
          summary: "☑️ Spaces",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          description: "  First line\nSecond line  \n\n\n---\nCreated by Todo",
          extendedProperties: todo(false),
        },
      },
      {
        name: "base description with details",
        event: {
          id: "e13",
          summary: "☑️ Base",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          description: "Only details\n\n---\nCreated by Todo",
          extendedProperties: todo(false),
        },
      },
      {
        name: "user-edited description",
        event: {
          id: "e14",
          summary: "☑️ Edited",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          description: "Edited by hand",
          extendedProperties: todo(false),
        },
      },
      {
        name: "empty summary",
        event: {
          id: "e15",
          summary: "",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "missing summary",
        event: {
          id: "e16",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "summary without prefix",
        event: {
          id: "e17",
          summary: "Renamed in calendar",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "double prefix",
        event: {
          id: "e18",
          summary: "✅ ☑️ Twice",
          start: { dateTime: "2026-02-08T10:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          extendedProperties: todo(true),
        },
      },
      {
        name: "end before start",
        event: {
          id: "e19",
          summary: "☑️ Backwards",
          start: { dateTime: "2026-02-08T11:00:00.000Z" },
          end: { dateTime: "2026-02-08T10:00:00.000Z" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "zero length",
        event: {
          id: "e20",
          summary: "☑️ Zero",
          start: { dateTime: "2026-02-08T11:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:00.000Z" },
          extendedProperties: todo(true),
        },
      },
      {
        name: "cancelled status is not checked by the mapper",
        event: {
          id: "e21",
          status: "cancelled",
          summary: "☑️ Cancelled",
          start: { dateTime: "2026-02-08T11:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:30:00.000Z" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "sub-minute duration",
        event: {
          id: "e22",
          summary: "☑️ Short",
          start: { dateTime: "2026-02-08T11:00:00.000Z" },
          end: { dateTime: "2026-02-08T11:00:29.000Z" },
          extendedProperties: todo(false),
        },
      },
      {
        name: "fractional seconds",
        event: {
          id: "e23",
          summary: "☑️ Fraction",
          start: { dateTime: "2026-02-08T11:00:00.5Z" },
          end: { dateTime: "2026-02-08T11:30:00.250Z" },
          updated: "2026-02-08T12:00:00.999Z",
          extendedProperties: todo(true),
        },
      },
      {
        name: "actions before signature with crlf",
        event: {
          id: "e24",
          summary: "☑️ CRLF",
          start: { dateTime: "2026-02-08T11:00:00Z" },
          end: { dateTime: "2026-02-08T12:00:00Z" },
          description: "Line\r\nTwo\r\n\r\nActions:\n- Manage: x\n\n---\nCreated by Todo",
          extendedProperties: todo(false),
        },
      },
    ]
    output.mapEvents = events.map(({ name, event }) => ({
      name,
      event,
      task: mapCalendarEventToTask(event) ?? null,
    }))
  })

  it("records the event request bodies", async () => {
    resetMocks()
    mocks.calendarEvents.insert.mockResolvedValueOnce({ data: { id: "evt-1" } })
    mocks.calendarEvents.patch.mockResolvedValue({ data: {} })
    const slot = {
      start: new Date("2026-03-02T15:00:00.000Z"),
      end: new Date("2026-03-02T15:30:00.000Z"),
    }
    await createCalendarEvent(
      "user-1",
      { title: "Write tests", details: "Cover boundary\nSecond line" },
      { ...baseSettings, timezone: "Europe/Helsinki", eventColor: "7" },
      slot,
      "https://todo.example",
    )
    const withDetails = {
      insert: mocks.calendarEvents.insert.mock.calls[0][0],
      actionsPatch: mocks.calendarEvents.patch.mock.calls[0][0],
      invalidate: mocks.storage.invalidateActionTokensForEvent.mock.calls[0],
    }

    resetMocks()
    mocks.calendarEvents.insert.mockResolvedValueOnce({ data: { id: "evt-2" } })
    mocks.calendarEvents.patch.mockResolvedValue({ data: {} })
    await createCalendarEvent(
      "user-1",
      { title: "No details", details: null },
      baseSettings,
      slot,
      "https://todo.example",
    )
    const withoutDetails = {
      insert: mocks.calendarEvents.insert.mock.calls[0][0],
      actionsPatch: mocks.calendarEvents.patch.mock.calls[0][0],
    }

    resetMocks()
    mocks.calendarEvents.patch.mockRejectedValueOnce(new Error("patch failed"))
    await refreshCalendarEventActions(
      "user-1",
      "primary",
      "evt-3",
      "Details",
      "https://todo.example",
    )
    const failedActionsPatch = {
      markUsed: mocks.storage.markActionTokenUsed.mock.calls,
      invalidate: mocks.storage.invalidateActionTokensForEvent.mock.calls,
    }

    resetMocks()
    const existing: FakeEvent = {
      id: "evt-4",
      summary: "☑️ Write tests",
      extendedProperties: {
        private: { caltodo: "true", caltodoCompleted: "false", oldField: "keep-me" },
      },
    }
    mocks.calendarEvents.get.mockResolvedValue({ data: existing })
    mocks.calendarEvents.patch.mockResolvedValue({ data: { id: "evt-4" } })
    await updateCalendarEventCompletion("user-1", "evt-4", baseSettings, true)
    const completePatch = mocks.calendarEvents.patch.mock.calls[0][0]

    resetMocks()
    mocks.calendarEvents.get.mockResolvedValue({
      data: { ...existing, summary: "✅ Write tests" },
    })
    mocks.calendarEvents.patch.mockResolvedValue({ data: { id: "evt-4" } })
    await updateCalendarEventCompletion("user-1", "evt-4", baseSettings, false)
    const redoPatch = mocks.calendarEvents.patch.mock.calls[0][0]

    resetMocks()
    mocks.calendarEvents.get.mockResolvedValue({ data: existing })
    mocks.calendarEvents.patch.mockResolvedValue({ data: {} })
    await updateCalendarEventTime(
      "user-1",
      "evt-4",
      { ...baseSettings, timezone: "America/New_York" },
      {
        start: new Date("2026-03-02T17:00:00.000Z"),
        end: new Date("2026-03-02T17:45:00.000Z"),
      },
    )
    const timePatch = mocks.calendarEvents.patch.mock.calls[0][0]

    output.requests = {
      createWithDetails: withDetails,
      createWithoutDetails: withoutDetails,
      failedActionsPatch,
      completePatch,
      redoPatch,
      timePatch,
    }
    expect(withDetails.insert.requestBody.summary).toBe("☑️ Write tests")
  })

  it("records reschedule-all scenarios", async () => {
    const scenarios: Array<{
      name: string
      now: string
      settings: typeof baseSettings
      priority?: string[]
      events: FakeEvent[]
      failPatch?: string[]
      cancelled?: string[]
    }> = [
      {
        name: "priority first, busy event, completed and all-day events skipped",
        now: "2026-03-02T09:00:00.000Z",
        settings: baseSettings,
        priority: ["p1"],
        events: [
          {
            id: "p2",
            summary: "☑️ Later",
            start: { dateTime: "2026-03-02T11:00:00.000Z" },
            end: { dateTime: "2026-03-02T11:30:00.000Z" },
            extendedProperties: todo(false),
          },
          {
            id: "busy",
            summary: "Team sync",
            start: { dateTime: "2026-03-02T09:00:00.000Z" },
            end: { dateTime: "2026-03-02T09:30:00.000Z" },
          },
          {
            id: "allday",
            summary: "☑️ All day",
            start: { date: "2026-03-02" },
            end: { date: "2026-03-03" },
            extendedProperties: todo(false),
          },
          {
            id: "p1",
            summary: "☑️ First",
            start: { dateTime: "2026-03-02T10:30:00.000Z" },
            end: { dateTime: "2026-03-02T11:00:00.000Z" },
            extendedProperties: todo(false),
          },
          {
            id: "done",
            summary: "✅ Done",
            start: { dateTime: "2026-03-02T12:00:00.000Z" },
            end: { dateTime: "2026-03-02T12:30:00.000Z" },
            extendedProperties: todo(true),
          },
        ],
      },
      {
        name: "already in place, past task, transparent busy, failure",
        now: "2026-02-09T08:10:00.000Z",
        settings: {
          ...baseSettings,
          timezone: "Europe/Helsinki",
          workStartHour: 8,
          workEndHour: 16,
        },
        events: [
          {
            id: "first",
            summary: "☑️ First",
            start: { dateTime: "2026-02-09T08:15:00.000Z" },
            end: { dateTime: "2026-02-09T09:15:00.000Z" },
            extendedProperties: todo(false),
          },
          {
            id: "past",
            summary: "☑️ Past",
            start: { dateTime: "2026-02-05T08:00:00.000Z" },
            end: { dateTime: "2026-02-05T08:45:00.000Z" },
            extendedProperties: todo(),
          },
          {
            id: "free",
            summary: "Out of office",
            transparency: "transparent",
            start: { dateTime: "2026-02-09T09:00:00.000Z" },
            end: { dateTime: "2026-02-09T12:00:00.000Z" },
          },
          {
            id: "lunch",
            summary: "Lunch",
            start: { dateTime: "2026-02-09T10:00:00.000Z" },
            end: { dateTime: "2026-02-09T11:00:00.000Z" },
          },
          {
            id: "broken",
            summary: "☑️ Broken",
            start: { dateTime: "2026-02-10T08:00:00.000Z" },
            end: { dateTime: "2026-02-10T09:00:00.000Z" },
            extendedProperties: todo(false),
          },
          {
            id: "gone",
            summary: "☑️ Gone",
            start: { dateTime: "2026-02-11T08:00:00.000Z" },
            end: { dateTime: "2026-02-11T08:30:00.000Z" },
            extendedProperties: todo(false),
          },
        ],
        failPatch: ["broken"],
        cancelled: ["gone"],
      },
      {
        name: "no slot for an oversized task",
        now: "2026-02-09T08:00:00.000Z",
        settings: { ...baseSettings, workStartHour: 9, workEndHour: 10 },
        events: [
          {
            id: "long",
            summary: "☑️ Long",
            start: { dateTime: "2026-02-09T09:00:00.000Z" },
            end: { dateTime: "2026-02-09T12:00:00.000Z" },
            extendedProperties: todo(false),
          },
          {
            id: "short",
            summary: "☑️ Short",
            start: { dateTime: "2026-02-10T09:00:00.000Z" },
            end: { dateTime: "2026-02-10T09:15:00.000Z" },
            extendedProperties: todo(false),
          },
        ],
      },
      {
        name: "zero-length task uses the default duration",
        now: "2026-02-09T08:00:00.000Z",
        settings: { ...baseSettings, defaultDuration: 45 },
        events: [
          {
            id: "zero",
            summary: "☑️ Zero",
            start: { dateTime: "2026-02-12T13:00:00.000Z" },
            end: { dateTime: "2026-02-12T13:00:00.000Z" },
            extendedProperties: todo(false),
          },
        ],
      },
    ]

    const results = []
    for (const scenario of scenarios) {
      resetMocks()
      vi.useFakeTimers()
      vi.setSystemTime(new Date(scenario.now))
      mocks.storage.getUserSettings.mockResolvedValue(scenario.settings)
      mocks.calendarEvents.list.mockImplementation(listOverlapping(scenario.events))
      mocks.calendarEvents.get.mockImplementation(
        async ({ eventId }: { eventId: string }) => {
          const event = scenario.events.find((item) => item.id === eventId)
          if (scenario.cancelled?.includes(eventId)) {
            return { data: { ...event, status: "cancelled" } }
          }
          return { data: structuredClone(event) }
        },
      )
      mocks.calendarEvents.patch.mockImplementation(
        async ({ eventId }: { eventId: string }) => {
          if (scenario.failPatch?.includes(eventId)) throw new Error("patch failed")
          return { data: {} }
        },
      )
      const summary = await rescheduleAllUserTasks("user-1", scenario.priority)
      results.push({
        ...scenario,
        patches: mocks.calendarEvents.patch.mock.calls.map(([call]) => ({
          eventId: call.eventId,
          start: call.requestBody.start,
          end: call.requestBody.end,
        })),
        listCalls: mocks.calendarEvents.list.mock.calls.map(([call]) => ({
          timeMin: call.timeMin,
          timeMax: call.timeMax,
        })),
        summary,
      })
      vi.useRealTimers()
    }
    output.rescheduleAll = results
  })

  it("records the task list order", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-02-10T12:00:00.000Z"))
    const events: FakeEvent[] = [
      {
        id: "late",
        summary: "☑️ Late",
        start: { dateTime: "2026-02-12T09:00:00.000Z" },
        end: { dateTime: "2026-02-12T10:00:00.000Z" },
        extendedProperties: todo(false),
      },
      {
        id: "done-old",
        summary: "✅ Old",
        start: { dateTime: "2026-02-01T09:00:00.000Z" },
        end: { dateTime: "2026-02-01T10:00:00.000Z" },
        updated: "2026-02-01T10:05:00.000Z",
        extendedProperties: todo(true),
      },
      {
        id: "early",
        summary: "☑️ Early",
        start: { dateTime: "2026-02-11T09:00:00.000Z" },
        end: { dateTime: "2026-02-11T09:30:00.000Z" },
        extendedProperties: todo(),
      },
      {
        id: "meeting",
        summary: "Meeting",
        start: { dateTime: "2026-02-11T08:00:00.000Z" },
        end: { dateTime: "2026-02-11T08:30:00.000Z" },
      },
      {
        id: "done-new",
        summary: "✅ New",
        start: { dateTime: "2026-02-09T09:00:00.000Z" },
        end: { dateTime: "2026-02-09T10:00:00.000Z" },
        extendedProperties: todo(true),
      },
      {
        id: "same-start",
        summary: "☑️ Same start",
        start: { dateTime: "2026-02-11T09:00:00.000Z" },
        end: { dateTime: "2026-02-11T10:00:00.000Z" },
        extendedProperties: todo(false),
      },
    ]
    let listParams: unknown
    const handler = createGetTasksHandler({
      getUserSettings: vi.fn().mockResolvedValue(baseSettings),
      getCalendarClient: vi.fn().mockResolvedValue({}),
      listCalendarEventsInRange: vi.fn(
        async (_calendar, calendarId, timeMin, timeMax) => {
          listParams = {
            calendarId,
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
          }
          return events
        },
      ),
      mapCalendarEventToTask,
    } as never)
    const response = createMockResponse()
    await handler({ user: { id: "user-1" } } as never, response.res as never, vi.fn())
    output.taskList = {
      now: "2026-02-10T12:00:00.000Z",
      events,
      listParams,
      body: response.body,
    }
  })

  it("records the reorder slot swap", async () => {
    const scenarios = [
      {
        name: "swap two tasks",
        taskIds: ["t1", "t2"],
        events: {
          t1: ["2026-02-10T10:00:00.000Z", "2026-02-10T10:30:00.000Z", 30],
          t2: ["2026-02-10T09:00:00.000Z", "2026-02-10T09:30:00.000Z", 30],
        },
      },
      {
        name: "different durations keep their own length",
        taskIds: ["c", "a", "b"],
        events: {
          a: ["2026-02-10T09:00:00.000Z", "2026-02-10T10:00:00.000Z", 60],
          b: ["2026-02-10T10:00:00.000Z", "2026-02-10T10:15:00.000Z", 15],
          c: ["2026-02-10T13:00:00.000Z", "2026-02-10T14:30:00.000Z", 90],
        },
      },
      {
        name: "deleted and unknown tasks are skipped",
        taskIds: ["gone", "x", "y", "missing"],
        events: {
          x: ["2026-02-11T09:00:00.000Z", "2026-02-11T09:45:00.000Z", 45],
          y: ["2026-02-10T09:00:00.000Z", "2026-02-10T09:45:00.000Z", 45],
          gone: "deleted",
        },
      },
      {
        name: "unchanged order makes no update",
        taskIds: ["a", "b"],
        events: {
          a: ["2026-02-10T09:00:00.000Z", "2026-02-10T09:30:00.000Z", 30],
          b: ["2026-02-10T10:00:00.000Z", "2026-02-10T10:30:00.000Z", 30],
        },
      },
    ]
    const results = []
    for (const scenario of scenarios) {
      const updates: unknown[] = []
      const { EVENT_DELETED } = await import("../../server/calendar")
      const map = new Map<string, unknown>()
      for (const [id, value] of Object.entries(scenario.events)) {
        if (value === "deleted") {
          map.set(id, EVENT_DELETED)
        } else {
          const [start, end, durationMinutes] = value as [string, string, number]
          map.set(id, {
            eventId: id,
            start: new Date(start),
            end: new Date(end),
            durationMinutes,
          })
        }
      }
      const handler = createReorderTasksHandler({
        getUserSettings: vi.fn().mockResolvedValue(baseSettings),
        getCalendarEventsForTasks: vi.fn().mockResolvedValue(map),
        updateCalendarEventTime: vi.fn(async (_user, eventId, _settings, slot) => {
          updates.push({
            eventId,
            start: slot.start.toISOString(),
            end: slot.end.toISOString(),
          })
          return true
        }),
      } as never)
      const response = createMockResponse()
      await handler(
        { user: { id: "user-1" }, body: { taskIds: scenario.taskIds } } as never,
        response.res as never,
        vi.fn(),
      )
      results.push({
        ...scenario,
        status: response.statusCode,
        body: response.body,
        updates,
      })
    }
    output.reorder = results
  })

  it("writes the calendar golden file", () => {
    const file = path.join(ROOT, "crates/domain/tests/fixtures/calendar.golden.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`)
  })
})
