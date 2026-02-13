import { vi } from "vitest"
import { EVENT_DELETED } from "../calendar"

type TestUser = {
  id: string
  googleId: string
  email: string
  displayName: string
}

type TestSettings = {
  userId: string
  calendarId: string | null
  timezone: string
  workStartHour: number
  workEndHour: number
  defaultDuration: number
  eventColor: string
}

type ActionTokenRecord = {
  id: string
  userId: string
  eventId: string
  calendarId: string
  expiresAt: Date
}

type EventRecord = {
  id: string
  summary?: string
  description?: string
  start?: { dateTime?: string }
  end?: { dateTime?: string }
  extendedProperties?: { private?: Record<string, string> }
  status?: string
  updated?: string
}

function createTaskFromEvent(event: EventRecord) {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) {
    return null
  }

  const isTodo = event.extendedProperties?.private?.caltodo === "true"
  if (!isTodo) return null

  const completed = event.extendedProperties?.private?.caltodoCompleted === "true"

  return {
    id: event.id,
    title: (event.summary || "").replace(/^☑️\s|^✅\s/, "") || "Task",
    details: event.description || null,
    duration: Math.max(
      1,
      Math.round(
        (new Date(event.end.dateTime).getTime() -
          new Date(event.start.dateTime).getTime()) /
          60000,
      ),
    ),
    scheduledStart: new Date(event.start.dateTime).toISOString(),
    scheduledEnd: new Date(event.end.dateTime).toISOString(),
    completed,
    completedAt: completed
      ? event.updated || new Date(event.end.dateTime).toISOString()
      : null,
    priority: 0,
  }
}

export function createIntegrationFixtures() {
  const user1: TestUser = {
    id: "user-1",
    googleId: "google-1",
    email: "user1@example.com",
    displayName: "User One",
  }
  const user2: TestUser = {
    id: "user-2",
    googleId: "google-2",
    email: "user2@example.com",
    displayName: "User Two",
  }

  const usersById = new Map<string, TestUser>([
    [user1.id, user1],
    [user2.id, user2],
  ])

  const settingsByUserId = new Map<string, TestSettings>([
    [
      user1.id,
      {
        userId: user1.id,
        calendarId: "primary",
        timezone: "UTC",
        workStartHour: 9,
        workEndHour: 17,
        defaultDuration: 30,
        eventColor: "1",
      },
    ],
    [
      user2.id,
      {
        userId: user2.id,
        calendarId: "primary",
        timezone: "UTC",
        workStartHour: 9,
        workEndHour: 17,
        defaultDuration: 30,
        eventColor: "1",
      },
    ],
  ])

  const eventsById = new Map<string, EventRecord>()
  const actionTokens = new Map<string, ActionTokenRecord>()

  let createdEventCounter = 1
  const defaultCalendarClient = { id: "mock-calendar-client" }

  const getUserSettings = vi.fn(async (userId: string) => {
    return settingsByUserId.get(userId) || null
  })

  const updateUserSettings = vi.fn(
    async (userId: string, patch: Partial<TestSettings>) => {
      const current = settingsByUserId.get(userId)
      if (!current) return null
      const updated = { ...current, ...patch }
      settingsByUserId.set(userId, updated)
      return updated
    },
  )

  const createUserSettings = vi.fn(async (settings: TestSettings) => {
    settingsByUserId.set(settings.userId, settings)
    return settings
  })

  const deleteUserData = vi.fn(async (userId: string) => {
    settingsByUserId.delete(userId)
  })

  const listCalendars = vi.fn(async (_userId: string) => {
    return [{ id: "primary", summary: "Primary", primary: true }]
  })

  const getCalendarClient = vi.fn(async (_userId: string) => defaultCalendarClient)

  const listCalendarEventsInRange = vi.fn(async () => {
    return Array.from(eventsById.values())
  })

  const mapCalendarEventToTask = vi.fn((event: EventRecord) => createTaskFromEvent(event))

  const findFreeSlot = vi.fn(
    async (_userId: string, _settings: TestSettings, duration: number) => {
      const start = new Date("2026-03-02T10:00:00.000Z")
      const end = new Date(start.getTime() + Math.max(1, duration) * 60 * 1000)
      return { start, end }
    },
  )

  const createCalendarEvent = vi.fn(
    async (
      _userId: string,
      input: { title: string; details: string | null },
      settings: TestSettings,
      slot: { start: Date; end: Date },
    ) => {
      if (!settings.calendarId) return null
      const eventId = `evt-${createdEventCounter++}`
      eventsById.set(eventId, {
        id: eventId,
        summary: `☑️ ${input.title}`,
        description: input.details || undefined,
        start: { dateTime: slot.start.toISOString() },
        end: { dateTime: slot.end.toISOString() },
        extendedProperties: {
          private: {
            caltodo: "true",
            caltodoCompleted: "false",
          },
        },
      })
      return eventId
    },
  )

  const getCalendarEvent = vi.fn(async (_userId: string, eventId: string) => {
    return eventsById.get(eventId) || null
  })

  const updateCalendarEventCompletion = vi.fn(
    async (
      _userId: string,
      eventId: string,
      _settings: TestSettings,
      completed: boolean,
    ) => {
      const event = eventsById.get(eventId)
      if (!event) return null
      event.summary = `${completed ? "✅" : "☑️"} ${(event.summary || "Task").replace(
        /^☑️\s|^✅\s/,
        "",
      )}`
      event.extendedProperties = {
        private: {
          ...(event.extendedProperties?.private || {}),
          caltodo: "true",
          caltodoCompleted: completed ? "true" : "false",
        },
      }
      event.updated = new Date().toISOString()
      return event
    },
  )

  const updateCalendarEventTime = vi.fn(
    async (
      _userId: string,
      eventId: string,
      _settings: TestSettings,
      slot: { start: Date; end: Date },
    ) => {
      const event = eventsById.get(eventId)
      if (!event) return false
      event.start = { dateTime: slot.start.toISOString() }
      event.end = { dateTime: slot.end.toISOString() }
      return true
    },
  )

  const getCalendarEventsForTasks = vi.fn(
    async (_userId: string, _calendarId: string, taskIds: string[]) => {
      const entries: Array<[string, unknown]> = taskIds.map((id) => {
        const event = eventsById.get(id)
        if (!event || !event.start?.dateTime || !event.end?.dateTime) {
          return [id, EVENT_DELETED]
        }

        return [
          id,
          {
            eventId: id,
            start: new Date(event.start.dateTime),
            end: new Date(event.end.dateTime),
            durationMinutes: Math.max(
              1,
              Math.round(
                (new Date(event.end.dateTime).getTime() -
                  new Date(event.start.dateTime).getTime()) /
                  60000,
              ),
            ),
            completed: event.extendedProperties?.private?.caltodoCompleted === "true",
          },
        ]
      })

      return new Map(entries)
    },
  )

  const rescheduleAllUserTasks = vi.fn(async () => undefined)
  const refreshCalendarEventActions = vi.fn(async () => undefined)

  const getActionToken = vi.fn(async (token: string) => {
    return actionTokens.get(token) || null
  })

  const consumeActionToken = vi.fn(async (token: string, expectedUserId?: string) => {
    const record = actionTokens.get(token)
    if (!record) return null
    if (expectedUserId && record.userId !== expectedUserId) return null
    actionTokens.delete(token)
    return record
  })

  return {
    users: { user1, user2 },
    usersById,
    settingsByUserId,
    eventsById,
    actionTokens,
    mocks: {
      auth: {
        getUserSettings,
        updateUserSettings,
        createUserSettings,
        deleteUserData,
        listCalendars,
      },
      task: {
        getUserSettings,
        getCalendarClient,
        listCalendarEventsInRange,
        mapCalendarEventToTask,
        findFreeSlot,
        createCalendarEvent,
        rescheduleAllUserTasks,
        getCalendarEvent,
        updateCalendarEventCompletion,
        updateCalendarEventTime,
        getCalendarEventsForTasks,
      },
      action: {
        getActionToken,
        consumeActionToken,
        getUserSettings,
        getCalendarEvent,
        mapCalendarEventToTask,
        updateCalendarEventCompletion,
        findFreeSlot,
        updateCalendarEventTime,
        refreshCalendarEventActions,
      },
    },
    seedActionToken(token: string, record: ActionTokenRecord) {
      actionTokens.set(token, record)
    },
    seedEvent(event: EventRecord) {
      eventsById.set(event.id, event)
    },
    setUserSettings(userId: string, settings: TestSettings | null) {
      if (!settings) {
        settingsByUserId.delete(userId)
        return
      }
      settingsByUserId.set(userId, settings)
    },
  }
}
