import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { calendar_v3 } from "googleapis"

const mocks = vi.hoisted(() => {
  const storage = {
    getUser: vi.fn(),
    updateUser: vi.fn(),
    getUserSettings: vi.fn(),
    markActionTokenUsed: vi.fn(),
    invalidateActionTokensForEvent: vi.fn(),
  }

  const calendarEvents = {
    list: vi.fn(),
    insert: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
  }

  const oauth2Client = {
    setCredentials: vi.fn(),
    on: vi.fn(),
  }

  const tokens = {
    createActionToken: vi.fn(),
  }

  return {
    storage,
    calendarEvents,
    oauth2Client,
    tokens,
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
    calendar: vi.fn(() => ({
      events: mocks.calendarEvents,
    })),
  },
}))

import {
  createCalendarEvent,
  getCalendarClient,
  refreshCalendarEventActions,
  rescheduleAllUserTasks,
  updateCalendarEventCompletion,
  updateCalendarEventTime,
} from "./calendar"

const baseSettings = {
  userId: "user-1",
  calendarId: "primary",
  timezone: "UTC",
  workStartHour: 9,
  workEndHour: 17,
  eventColor: "2",
  defaultDuration: 30,
}

describe("calendar adapter contract", () => {
  beforeEach(() => {
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
    mocks.calendarEvents.patch.mockResolvedValue({ data: {} })
    mocks.calendarEvents.get.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("getCalendarClient", () => {
    it("returns null when user is missing", async () => {
      mocks.storage.getUser.mockResolvedValueOnce(null)

      const calendar = await getCalendarClient("user-1")

      expect(calendar).toBeNull()
    })

    it("returns null when user has no access token", async () => {
      mocks.storage.getUser.mockResolvedValueOnce({
        accessToken: null,
        refreshToken: "r1",
      })

      const calendar = await getCalendarClient("user-1")

      expect(calendar).toBeNull()
    })

    it("persists refreshed OAuth tokens from callback", async () => {
      await getCalendarClient("user-1")

      const tokenListener = mocks.oauth2Client.on.mock.calls.find(
        (call: unknown[]) => call[0] === "tokens",
      )?.[1] as
        | ((tokens: { access_token?: string; refresh_token?: string }) => Promise<void>)
        | undefined

      expect(tokenListener).toBeTypeOf("function")

      await tokenListener?.({
        access_token: "next-access",
        refresh_token: "next-refresh",
      })

      expect(mocks.storage.updateUser).toHaveBeenCalledWith("user-1", {
        accessToken: "next-access",
        refreshToken: "next-refresh",
      })
    })
  })

  describe("createCalendarEvent", () => {
    it("creates event and appends action links", async () => {
      mocks.calendarEvents.insert.mockResolvedValueOnce({ data: { id: "evt-1" } })

      const id = await createCalendarEvent(
        "user-1",
        { title: "Write tests", details: "Cover boundary" },
        baseSettings,
        {
          start: new Date("2026-03-02T15:00:00.000Z"),
          end: new Date("2026-03-02T15:30:00.000Z"),
        },
        "https://todo.example",
      )

      expect(id).toBe("evt-1")
      expect(mocks.calendarEvents.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: "primary",
          requestBody: expect.objectContaining({
            summary: "☑️ Write tests",
            start: expect.objectContaining({
              dateTime: "2026-03-02T15:00:00.000Z",
              timeZone: "UTC",
            }),
            end: expect.objectContaining({
              dateTime: "2026-03-02T15:30:00.000Z",
              timeZone: "UTC",
            }),
          }),
        }),
      )
      expect(mocks.calendarEvents.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: "primary",
          eventId: "evt-1",
          requestBody: expect.objectContaining({
            description: expect.stringContaining("https://todo.example/action/tok-raw"),
          }),
        }),
      )
      expect(mocks.storage.invalidateActionTokensForEvent).toHaveBeenCalledWith(
        "user-1",
        "evt-1",
        "primary",
        "tok-hash",
      )
    })

    it("returns null when insert fails", async () => {
      mocks.calendarEvents.insert.mockRejectedValueOnce(new Error("insert failed"))

      const id = await createCalendarEvent(
        "user-1",
        { title: "Write tests", details: null },
        baseSettings,
        {
          start: new Date("2026-03-02T15:00:00.000Z"),
          end: new Date("2026-03-02T15:30:00.000Z"),
        },
        "https://todo.example",
      )

      expect(id).toBeNull()
      expect(mocks.calendarEvents.patch).not.toHaveBeenCalled()
    })
  })

  describe("updateCalendarEventTime", () => {
    it("returns false for cancelled or non-Todo events", async () => {
      mocks.calendarEvents.get.mockResolvedValueOnce({ data: { status: "cancelled" } })
      const cancelled = await updateCalendarEventTime("user-1", "evt-1", baseSettings, {
        start: new Date("2026-03-02T15:00:00.000Z"),
        end: new Date("2026-03-02T15:30:00.000Z"),
      })

      mocks.calendarEvents.get.mockResolvedValueOnce({ data: { id: "evt-2" } })
      const nonTodo = await updateCalendarEventTime("user-1", "evt-2", baseSettings, {
        start: new Date("2026-03-02T16:00:00.000Z"),
        end: new Date("2026-03-02T16:30:00.000Z"),
      })

      expect(cancelled).toBe(false)
      expect(nonTodo).toBe(false)
      expect(mocks.calendarEvents.patch).not.toHaveBeenCalled()
    })

    it("patches slot with timezone-aware body for Todo events", async () => {
      mocks.calendarEvents.get.mockResolvedValueOnce({
        data: { extendedProperties: { private: { caltodo: "true" } } },
      })

      const updated = await updateCalendarEventTime("user-1", "evt-3", baseSettings, {
        start: new Date("2026-03-02T17:00:00.000Z"),
        end: new Date("2026-03-02T17:45:00.000Z"),
      })

      expect(updated).toBe(true)
      expect(mocks.calendarEvents.patch).toHaveBeenCalledWith({
        calendarId: "primary",
        eventId: "evt-3",
        requestBody: {
          start: {
            dateTime: "2026-03-02T17:00:00.000Z",
            timeZone: "UTC",
          },
          end: {
            dateTime: "2026-03-02T17:45:00.000Z",
            timeZone: "UTC",
          },
        },
      })
    })
  })

  describe("updateCalendarEventCompletion", () => {
    it("returns null for cancelled/non-Todo events", async () => {
      mocks.calendarEvents.get.mockResolvedValueOnce({ data: { status: "cancelled" } })
      const cancelled = await updateCalendarEventCompletion(
        "user-1",
        "evt-1",
        baseSettings,
        true,
      )

      mocks.calendarEvents.get.mockResolvedValueOnce({ data: { id: "evt-2" } })
      const nonTodo = await updateCalendarEventCompletion(
        "user-1",
        "evt-2",
        baseSettings,
        true,
      )

      expect(cancelled).toBeNull()
      expect(nonTodo).toBeNull()
    })

    it("updates summary and completion properties", async () => {
      const existingEvent: calendar_v3.Schema$Event = {
        summary: "☑️ Write tests",
        extendedProperties: {
          private: {
            caltodo: "true",
            oldField: "keep-me",
          },
        },
      }
      mocks.calendarEvents.get.mockResolvedValueOnce({ data: existingEvent })
      mocks.calendarEvents.patch.mockResolvedValueOnce({ data: { id: "evt-1" } })

      const updated = await updateCalendarEventCompletion(
        "user-1",
        "evt-1",
        baseSettings,
        true,
      )

      expect(updated).toEqual({ id: "evt-1" })
      expect(mocks.calendarEvents.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: "primary",
          eventId: "evt-1",
          requestBody: {
            summary: "✅ Write tests",
            transparency: "transparent",
            extendedProperties: {
              private: {
                caltodo: "true",
                caltodoCompleted: "true",
                oldField: "keep-me",
              },
            },
          },
        }),
      )
    })
  })

  describe("refreshCalendarEventActions", () => {
    it("regenerates action token and patches event description", async () => {
      await refreshCalendarEventActions(
        "user-1",
        "primary",
        "evt-1",
        "Task details",
        "https://todo.example",
      )

      expect(mocks.tokens.createActionToken).toHaveBeenCalledWith(
        "user-1",
        "evt-1",
        "primary",
      )
      expect(mocks.calendarEvents.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: "evt-1",
          requestBody: expect.objectContaining({
            description: expect.stringContaining("https://todo.example/action/tok-raw"),
          }),
        }),
      )
    })

    it("handles token generation failure gracefully", async () => {
      mocks.tokens.createActionToken.mockRejectedValueOnce(new Error("token failed"))

      await expect(
        refreshCalendarEventActions(
          "user-1",
          "primary",
          "evt-1",
          "Task details",
          "https://todo.example",
        ),
      ).resolves.toBeUndefined()

      expect(mocks.calendarEvents.patch).not.toHaveBeenCalled()
    })
  })

  describe("rescheduleAllUserTasks", () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-03-02T09:00:00.000Z"))
    })

    it("prioritizes provided IDs and skips invalid/non-task events", async () => {
      mocks.calendarEvents.list.mockResolvedValue({
        data: {
          items: [
            {
              id: "priority-2",
              summary: "☑️ Later",
              start: { dateTime: "2026-03-02T11:00:00.000Z" },
              end: { dateTime: "2026-03-02T11:30:00.000Z" },
              extendedProperties: {
                private: { caltodo: "true", caltodoCompleted: "false" },
              },
            },
            {
              id: "busy-1",
              summary: "Team sync",
              start: { dateTime: "2026-03-02T09:00:00.000Z" },
              end: { dateTime: "2026-03-02T09:30:00.000Z" },
            },
            {
              id: "invalid-1",
              summary: "☑️ Invalid",
              start: { date: "2026-03-02" },
              end: { dateTime: "2026-03-02T10:00:00.000Z" },
              extendedProperties: {
                private: { caltodo: "true", caltodoCompleted: "false" },
              },
            },
            {
              id: "priority-1",
              summary: "☑️ First",
              start: { dateTime: "2026-03-02T10:30:00.000Z" },
              end: { dateTime: "2026-03-02T11:00:00.000Z" },
              extendedProperties: {
                private: { caltodo: "true", caltodoCompleted: "false" },
              },
            },
            {
              id: "done-1",
              summary: "✅ Done",
              start: { dateTime: "2026-03-02T12:00:00.000Z" },
              end: { dateTime: "2026-03-02T12:30:00.000Z" },
              extendedProperties: {
                private: { caltodo: "true", caltodoCompleted: "true" },
              },
            },
          ],
        },
      })
      mocks.calendarEvents.get.mockImplementation(
        async ({ eventId }: { eventId: string }) => {
          if (eventId === "priority-1") {
            return {
              data: {
                id: "priority-1",
                summary: "☑️ First",
                extendedProperties: { private: { caltodo: "true" } },
              },
            }
          }
          if (eventId === "priority-2") {
            return {
              data: {
                id: "priority-2",
                summary: "☑️ Later",
                extendedProperties: { private: { caltodo: "true" } },
              },
            }
          }
          return { data: { id: eventId } }
        },
      )

      await rescheduleAllUserTasks("user-1", ["priority-1"])

      expect(mocks.calendarEvents.patch).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          eventId: "priority-1",
          requestBody: expect.objectContaining({
            start: expect.objectContaining({ dateTime: "2026-03-02T09:30:00.000Z" }),
          }),
        }),
      )
      expect(mocks.calendarEvents.patch).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          eventId: "priority-2",
          requestBody: expect.objectContaining({
            start: expect.objectContaining({ dateTime: "2026-03-02T10:00:00.000Z" }),
          }),
        }),
      )
      const patchedIds = mocks.calendarEvents.patch.mock.calls.map(
        (call: [{ eventId: string }]) => call[0].eventId,
      )
      expect(patchedIds).not.toContain("invalid-1")
      expect(patchedIds).not.toContain("done-1")
    })
  })
})
