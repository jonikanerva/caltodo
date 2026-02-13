import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMockResponse } from "./testUtils"

vi.mock("../storage", () => ({
  storage: {
    getUserSettings: vi.fn(),
  },
}))

vi.mock("../calendar", () => ({
  getCalendarEvent: vi.fn(),
  mapCalendarEventToTask: vi.fn(),
  updateCalendarEventCompletion: vi.fn(),
  findFreeSlot: vi.fn(),
  updateCalendarEventTime: vi.fn(),
  refreshCalendarEventActions: vi.fn(),
}))

vi.mock("../tokens", () => ({
  consumeActionToken: vi.fn(),
  getActionToken: vi.fn(),
}))

import { createActionPageHandler, createApiActionHandler } from "./actionRoutes"

describe("action page handler", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows sign-in prompt when user is not authenticated", async () => {
    const deps = {
      getActionToken: vi.fn(),
      getCalendarEvent: vi.fn(),
      mapCalendarEventToTask: vi.fn(),
    }
    const req = {
      params: { token: "tok-1" },
      isAuthenticated: () => false,
    } as never
    const res = createMockResponse()

    await createActionPageHandler(deps)(req, res.res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(String(res.body)).toContain("Sign in required")
  })

  it("renders manage page when token and task are valid", async () => {
    const deps = {
      getActionToken: vi.fn().mockResolvedValue({
        userId: "user-1",
        eventId: "event-1",
        calendarId: "primary",
      }),
      getCalendarEvent: vi.fn().mockResolvedValue({ id: "event-1" }),
      mapCalendarEventToTask: vi.fn().mockReturnValue({
        id: "event-1",
        title: "Task 1",
        details: null,
        completed: false,
      }),
    }
    const req = {
      params: { token: "tok-1" },
      isAuthenticated: () => true,
      user: { id: "user-1" },
      session: { csrfToken: "csrf-1" },
    } as never
    const res = createMockResponse()

    await createActionPageHandler(deps)(req, res.res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(String(res.body)).toContain("Manage task")
    expect(String(res.body)).toContain("csrf-1")
  })

  it("returns 403 page when token belongs to another user", async () => {
    const deps = {
      getActionToken: vi.fn().mockResolvedValue({
        userId: "other-user",
        eventId: "event-1",
        calendarId: "primary",
      }),
      getCalendarEvent: vi.fn(),
      mapCalendarEventToTask: vi.fn(),
    }
    const req = {
      params: { token: "tok-1" },
      isAuthenticated: () => true,
      user: { id: "user-1" },
      session: { csrfToken: "csrf-1" },
    } as never
    const res = createMockResponse()

    await createActionPageHandler(deps)(req, res.res as never, vi.fn())
    expect(res.statusCode).toBe(403)
    expect(String(res.body)).toContain("Not authorized")
  })
})

describe("createApiActionHandler", () => {
  const deps = {
    getActionToken: vi.fn(),
    consumeActionToken: vi.fn(),
    getUserSettings: vi.fn(),
    getCalendarEvent: vi.fn(),
    mapCalendarEventToTask: vi.fn(),
    updateCalendarEventCompletion: vi.fn(),
    findFreeSlot: vi.fn(),
    updateCalendarEventTime: vi.fn(),
    refreshCalendarEventActions: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 for missing token", async () => {
    const req = {
      user: { id: "user-1" },
      params: {},
      body: { action: "complete" },
    } as never
    const response = createMockResponse()

    await createApiActionHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: "Invalid action token" })
  })

  it("returns 403 when token belongs to another user", async () => {
    const req = {
      user: { id: "user-1" },
      params: { token: "abc" },
      body: { action: "complete" },
      headers: {},
    } as never
    deps.getActionToken.mockResolvedValueOnce({ userId: "other-user" })
    const response = createMockResponse()

    await createApiActionHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ error: "Unauthorized." })
  })

  it("completes task and returns success json", async () => {
    const req = {
      user: { id: "user-1" },
      params: { token: "abc" },
      body: { action: "complete" },
      headers: {},
    } as never
    deps.getActionToken.mockResolvedValueOnce({ userId: "user-1" })
    deps.consumeActionToken.mockResolvedValueOnce({
      eventId: "event-1",
      calendarId: "primary",
    })
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
      timezone: "UTC",
    })
    deps.getCalendarEvent.mockResolvedValueOnce({
      id: "event-1",
      start: { dateTime: "2026-02-09T10:00:00.000Z" },
      end: { dateTime: "2026-02-09T10:30:00.000Z" },
    })
    deps.mapCalendarEventToTask.mockReturnValueOnce({
      id: "event-1",
      title: "Task 1",
      details: null,
      completed: false,
    })
    deps.updateCalendarEventCompletion.mockResolvedValueOnce({ id: "event-1" })
    deps.refreshCalendarEventActions.mockResolvedValueOnce(undefined)
    const response = createMockResponse()

    await createApiActionHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ success: true })
  })

  it("reschedules task and returns html when requested", async () => {
    const req = {
      user: { id: "user-1" },
      params: { token: "abc" },
      body: { action: "reschedule" },
      headers: { accept: "text/html" },
    } as never
    deps.getActionToken.mockResolvedValueOnce({ userId: "user-1" })
    deps.consumeActionToken.mockResolvedValueOnce({
      eventId: "event-1",
      calendarId: "primary",
    })
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
      timezone: "UTC",
    })
    deps.getCalendarEvent.mockResolvedValueOnce({
      id: "event-1",
      start: { dateTime: "2026-02-09T10:00:00.000Z" },
      end: { dateTime: "2026-02-09T10:30:00.000Z" },
    })
    deps.mapCalendarEventToTask.mockReturnValueOnce({
      id: "event-1",
      title: "Task 1",
      details: null,
      completed: false,
    })
    deps.findFreeSlot.mockResolvedValueOnce({
      start: new Date("2026-02-10T10:00:00.000Z"),
      end: new Date("2026-02-10T10:30:00.000Z"),
    })
    deps.updateCalendarEventTime.mockResolvedValueOnce(true)
    deps.refreshCalendarEventActions.mockResolvedValueOnce(undefined)
    const response = createMockResponse()

    await createApiActionHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(200)
    expect(typeof response.body).toBe("string")
    expect(String(response.body)).toContain("Task rescheduled")
  })

  it("returns html error contract when completion update returns null", async () => {
    const req = {
      user: { id: "user-1" },
      params: { token: "abc" },
      body: { action: "complete" },
      headers: { accept: "text/html" },
    } as never
    deps.getActionToken.mockResolvedValueOnce({ userId: "user-1" })
    deps.consumeActionToken.mockResolvedValueOnce({
      eventId: "event-1",
      calendarId: "primary",
    })
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
      timezone: "UTC",
    })
    deps.getCalendarEvent.mockResolvedValueOnce({
      id: "event-1",
      start: { dateTime: "2026-02-09T10:00:00.000Z" },
      end: { dateTime: "2026-02-09T10:30:00.000Z" },
    })
    deps.mapCalendarEventToTask.mockReturnValueOnce({
      id: "event-1",
      title: "Task 1",
      details: null,
      completed: false,
    })
    deps.updateCalendarEventCompletion.mockResolvedValueOnce(null)
    const response = createMockResponse()

    await createApiActionHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(404)
    expect(typeof response.body).toBe("string")
    expect(String(response.body)).toContain("Task not found")
  })

  it("returns json 500 when action refresh throws", async () => {
    const req = {
      user: { id: "user-1" },
      params: { token: "abc" },
      body: { action: "complete" },
      headers: {},
    } as never
    deps.getActionToken.mockResolvedValueOnce({ userId: "user-1" })
    deps.consumeActionToken.mockResolvedValueOnce({
      eventId: "event-1",
      calendarId: "primary",
    })
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
      timezone: "UTC",
    })
    deps.getCalendarEvent.mockResolvedValueOnce({
      id: "event-1",
      start: { dateTime: "2026-02-09T10:00:00.000Z" },
      end: { dateTime: "2026-02-09T10:30:00.000Z" },
    })
    deps.mapCalendarEventToTask.mockReturnValueOnce({
      id: "event-1",
      title: "Task 1",
      details: null,
      completed: false,
    })
    deps.updateCalendarEventCompletion.mockResolvedValueOnce({ id: "event-1" })
    deps.refreshCalendarEventActions.mockRejectedValueOnce(
      new Error("calendar patch failed"),
    )
    const response = createMockResponse()

    await createApiActionHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({ error: "Failed to process action" })
  })
})
