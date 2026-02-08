import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./auth", () => ({
  GOOGLE_OAUTH_SCOPES: [],
  requireAuth: vi.fn(),
  setupAuth: vi.fn(),
}))

vi.mock("./csrf", () => ({
  ensureCsrfToken: vi.fn(),
  requireCsrfToken: vi.fn(),
}))

vi.mock("./storage", () => ({
  storage: {
    getUserSettings: vi.fn(),
    updateUserSettings: vi.fn(),
    createUserSettings: vi.fn(),
    deleteUserData: vi.fn(),
  },
}))

vi.mock("./calendar", () => ({
  EVENT_DELETED: Symbol("EVENT_DELETED"),
  listCalendars: vi.fn(),
  findFreeSlot: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEventTime: vi.fn(),
  updateCalendarEventCompletion: vi.fn(),
  rescheduleAllUserTasks: vi.fn(),
  getCalendarClient: vi.fn(),
  listCalendarEventsInRange: vi.fn(),
  mapCalendarEventToTask: vi.fn(),
  getCalendarEventsForTasks: vi.fn(),
  getCalendarEvent: vi.fn(),
  refreshCalendarEventActions: vi.fn(),
}))

vi.mock("./tokens", () => ({
  consumeActionToken: vi.fn(),
  getActionToken: vi.fn(),
}))

vi.mock("./cron", () => ({
  setupCronJobs: vi.fn(),
}))

import {
  createActionPageHandler,
  createApiActionHandler,
  createAuthGoogleCallbackSuccessHandler,
  createAuthGoogleCallbackAuthHandler,
  createAuthGoogleStartHandler,
  createAuthLogoutHandler,
  createAuthUserHandler,
  createBulkCompleteTasksHandler,
  createCompleteTaskHandler,
  createDeleteAccountHandler,
  createGetCalendarsHandler,
  createGetTasksHandler,
  createGetSettingsHandler,
  createPatchTaskHandler,
  createPatchSettingsHandler,
  createPostTasksHandler,
  createReloadTasksHandler,
  createReorderTasksHandler,
  createRescheduleAllTasksHandler,
  createRescheduleTaskHandler,
} from "./routes"

type MockResponse = {
  statusCode: number
  body: unknown
  redirectedTo: string | null
  clearedCookies: Array<{ name: string; options: unknown }>
  res: {
    status: (code: number) => MockResponse["res"]
    json: (payload: unknown) => MockResponse["res"]
    send: (payload: unknown) => MockResponse["res"]
    redirect: (path: string) => MockResponse["res"]
    clearCookie: (name: string, options?: unknown) => MockResponse["res"]
  }
}

function createMockResponse(): MockResponse {
  const state: {
    statusCode: number
    body: unknown
    redirectedTo: string | null
    clearedCookies: Array<{ name: string; options: unknown }>
  } = {
    statusCode: 200,
    body: undefined,
    redirectedTo: null,
    clearedCookies: [],
  }

  const res = {
    status(code: number) {
      state.statusCode = code
      return this
    },
    json(payload: unknown) {
      state.body = payload
      return this
    },
    send(payload: unknown) {
      state.body = payload
      return this
    },
    redirect(path: string) {
      state.redirectedTo = path
      return this
    },
    clearCookie(name: string, options?: unknown) {
      state.clearedCookies.push({ name, options })
      return this
    },
  }

  return {
    get statusCode() {
      return state.statusCode
    },
    get body() {
      return state.body
    },
    get redirectedTo() {
      return state.redirectedTo
    },
    get clearedCookies() {
      return state.clearedCookies
    },
    res,
  }
}

describe("auth handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("stores pending token and delegates to passport authenticate", async () => {
    let capturedOptions: unknown
    const authenticate = vi.fn((_strategy: string, options: unknown) => {
      capturedOptions = options
      return (_req: unknown, _res: unknown, next: () => void) => next()
    })
    const req = { query: { actionToken: "tok-1" }, session: {} } as never
    const res = createMockResponse()
    const next = vi.fn()

    await createAuthGoogleStartHandler(authenticate, ["scope1", "scope2"])(
      req,
      res.res as never,
      next,
    )

    expect(req.session.pendingActionToken).toBe("tok-1")
    expect(authenticate).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ scope: ["scope1", "scope2"] }),
    )
    expect(capturedOptions).toBeTruthy()
  })

  it("redirects to pending action on callback success", () => {
    const req = { session: { pendingActionToken: "abc/123" } } as never
    const res = createMockResponse()

    createAuthGoogleCallbackSuccessHandler()(req, res.res as never, vi.fn())
    expect(res.redirectedTo).toBe("/action/abc%2F123")
    expect(req.session.pendingActionToken).toBeUndefined()
  })

  it("creates callback auth middleware from passport authenticate", () => {
    const middleware = vi.fn()
    const authenticate = vi.fn().mockReturnValue(middleware)
    const created = createAuthGoogleCallbackAuthHandler(authenticate)
    expect(authenticate).toHaveBeenCalledWith("google", { failureRedirect: "/" })
    expect(created).toBe(middleware)
  })

  it("returns 401 when user is not authenticated", () => {
    const req = { isAuthenticated: () => false } as never
    const res = createMockResponse()

    createAuthUserHandler()(req, res.res as never, vi.fn())
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: "Not authenticated" })
  })

  it("logs out and clears cookie", () => {
    const req = {
      logout: (cb: (err?: Error) => void) => cb(),
      session: { destroy: (cb: () => void) => cb() },
    } as never
    const res = createMockResponse()

    createAuthLogoutHandler()(req, res.res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(res.clearedCookies.some((entry) => entry.name === "connect.sid")).toBe(true)
  })
})

describe("settings and account handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("deletes account data and ends session", async () => {
    const deps = { deleteUserData: vi.fn().mockResolvedValue(undefined) }
    const req = {
      user: { id: "user-1" },
      logout: (cb: (err?: Error) => void) => cb(),
      session: { destroy: (cb: () => void) => cb() },
    } as never
    const res = createMockResponse()

    await createDeleteAccountHandler(deps)(req, res.res as never, vi.fn())
    expect(deps.deleteUserData).toHaveBeenCalledWith("user-1")
    expect(res.body).toEqual({ success: true })
  })

  it("returns existing settings when found", async () => {
    const deps = {
      getUserSettings: vi.fn().mockResolvedValue({ calendarId: "primary" }),
      updateUserSettings: vi.fn(),
      createUserSettings: vi.fn(),
    }
    const req = { user: { id: "user-1" } } as never
    const res = createMockResponse()

    await createGetSettingsHandler(deps)(req, res.res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ calendarId: "primary" })
  })

  it("patches existing settings", async () => {
    const deps = {
      getUserSettings: vi.fn().mockResolvedValue({ id: "s1", calendarId: "primary" }),
      updateUserSettings: vi
        .fn()
        .mockResolvedValue({ id: "s1", calendarId: "primary", workStartHour: 9 }),
      createUserSettings: vi.fn(),
    }
    const req = {
      user: { id: "user-1" },
      body: {
        calendarId: "primary",
        workStartHour: 9,
        workEndHour: 17,
        timezone: "America/New_York",
        defaultDuration: 30,
        eventColor: "1",
      },
    } as never
    const res = createMockResponse()

    await createPatchSettingsHandler(deps)(req, res.res as never, vi.fn())
    expect(deps.updateUserSettings).toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
  })
})

describe("calendar and task utility handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("lists calendars for user", async () => {
    const deps = {
      listCalendars: vi.fn().mockResolvedValue([{ id: "primary", summary: "Main" }]),
    }
    const req = { user: { id: "user-1" } } as never
    const res = createMockResponse()

    await createGetCalendarsHandler(deps)(req, res.res as never, vi.fn())
    expect(res.body).toEqual([{ id: "primary", summary: "Main" }])
  })

  it("reschedules all tasks", async () => {
    const deps = { rescheduleAllUserTasks: vi.fn().mockResolvedValue(undefined) }
    const req = { user: { id: "user-1" } } as never
    const res = createMockResponse()

    await createRescheduleAllTasksHandler(deps)(req, res.res as never, vi.fn())
    expect(deps.rescheduleAllUserTasks).toHaveBeenCalledWith("user-1")
    expect(res.body).toEqual({ success: true })
  })

  it("reload handler returns 400 when no calendar configured", async () => {
    const deps = { getUserSettings: vi.fn().mockResolvedValue({ calendarId: null }) }
    const req = { user: { id: "user-1" } } as never
    const res = createMockResponse()

    await createReloadTasksHandler(deps)(req, res.res as never, vi.fn())
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: "No calendar configured" })
  })

  it("complete task handler returns success when completion update succeeds", async () => {
    const deps = {
      getUserSettings: vi.fn().mockResolvedValue({ calendarId: "primary" }),
      updateCalendarEventCompletion: vi.fn().mockResolvedValue({ id: "e1" }),
    }
    const req = { user: { id: "user-1" }, params: { id: "e1" } } as never
    const res = createMockResponse()

    await createCompleteTaskHandler(deps)(req, res.res as never, vi.fn())
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true })
  })
})

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
})

describe("createGetTasksHandler", () => {
  const deps = {
    getUserSettings: vi.fn(),
    getCalendarClient: vi.fn(),
    listCalendarEventsInRange: vi.fn(),
    mapCalendarEventToTask: vi.fn(),
  }

  const req = {
    user: { id: "user-1" },
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns an empty list when no calendar is configured", async () => {
    deps.getUserSettings.mockResolvedValueOnce({ calendarId: null })
    const response = createMockResponse()

    await createGetTasksHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual([])
    expect(deps.getCalendarClient).not.toHaveBeenCalled()
  })

  it("returns 500 when calendar client cannot be created", async () => {
    deps.getUserSettings.mockResolvedValueOnce({ calendarId: "primary" })
    deps.getCalendarClient.mockResolvedValueOnce(null)
    const response = createMockResponse()

    await createGetTasksHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({ error: "Failed to access calendar" })
  })

  it("sorts uncompleted tasks by scheduled start and completed by completion time", async () => {
    deps.getUserSettings.mockResolvedValueOnce({ calendarId: "primary" })
    deps.getCalendarClient.mockResolvedValueOnce({ client: true })
    deps.listCalendarEventsInRange.mockResolvedValueOnce([
      { id: "u2" },
      { id: "c1" },
      { id: "u1" },
      { id: "c2" },
    ])
    deps.mapCalendarEventToTask.mockImplementation((event: { id: string }) => {
      const data = {
        u1: {
          id: "u1",
          title: "Task U1",
          details: null,
          duration: 30,
          scheduledStart: "2026-02-08T08:00:00.000Z",
          scheduledEnd: "2026-02-08T08:30:00.000Z",
          completed: false,
          completedAt: null,
          priority: 0,
        },
        u2: {
          id: "u2",
          title: "Task U2",
          details: null,
          duration: 30,
          scheduledStart: "2026-02-08T07:00:00.000Z",
          scheduledEnd: "2026-02-08T07:30:00.000Z",
          completed: false,
          completedAt: null,
          priority: 0,
        },
        c1: {
          id: "c1",
          title: "Task C1",
          details: null,
          duration: 30,
          scheduledStart: "2026-02-08T06:00:00.000Z",
          scheduledEnd: "2026-02-08T06:30:00.000Z",
          completed: true,
          completedAt: "2026-02-08T10:00:00.000Z",
          priority: 0,
        },
        c2: {
          id: "c2",
          title: "Task C2",
          details: null,
          duration: 30,
          scheduledStart: "2026-02-08T05:00:00.000Z",
          scheduledEnd: "2026-02-08T05:30:00.000Z",
          completed: true,
          completedAt: "2026-02-08T11:00:00.000Z",
          priority: 0,
        },
      } as const
      return data[event.id as keyof typeof data] ?? null
    })
    const response = createMockResponse()

    await createGetTasksHandler(deps)(req, response.res as never, vi.fn())

    const ids = (response.body as { id: string }[]).map((task) => task.id)
    expect(response.statusCode).toBe(200)
    expect(ids).toEqual(["u2", "u1", "c2", "c1"])
    expect((response.body as { priority: number }[])[0].priority).toBe(0)
    expect((response.body as { priority: number }[])[1].priority).toBe(1)
  })
})

describe("createPostTasksHandler", () => {
  const deps = {
    getUserSettings: vi.fn(),
    findFreeSlot: vi.fn(),
    createCalendarEvent: vi.fn(),
    rescheduleAllUserTasks: vi.fn(),
    getCalendarEvent: vi.fn(),
    mapCalendarEventToTask: vi.fn(),
  }
  const req = {
    user: { id: "user-1" },
    body: {
      title: "Write tests",
      details: "Cover routes",
      urgent: true,
      duration: 45,
    },
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 when no calendar is configured", async () => {
    deps.getUserSettings.mockResolvedValueOnce({ calendarId: null })
    const response = createMockResponse()

    await createPostTasksHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: "No calendar configured" })
  })

  it("returns 409 when no slot is available", async () => {
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
    })
    deps.findFreeSlot.mockResolvedValueOnce(null)
    const response = createMockResponse()

    await createPostTasksHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({
      error: "No free time slots available in the next 90 days.",
    })
  })

  it("creates and returns a mapped task", async () => {
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
    })
    deps.findFreeSlot.mockResolvedValueOnce({
      start: new Date("2026-02-09T10:00:00.000Z"),
      end: new Date("2026-02-09T10:45:00.000Z"),
    })
    deps.createCalendarEvent.mockResolvedValueOnce("event-1")
    deps.getCalendarEvent.mockResolvedValueOnce({ id: "event-1" })
    deps.mapCalendarEventToTask.mockReturnValueOnce({
      id: "event-1",
      title: "Write tests",
      details: "Cover routes",
      duration: 45,
      scheduledStart: "2026-02-09T10:00:00.000Z",
      scheduledEnd: "2026-02-09T10:45:00.000Z",
      completed: false,
      completedAt: null,
      priority: 0,
    })
    const response = createMockResponse()

    await createPostTasksHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(200)
    expect(deps.rescheduleAllUserTasks).toHaveBeenCalledWith("user-1", ["event-1"])
    expect(response.body).toMatchObject({ id: "event-1", title: "Write tests" })
  })
})

describe("createPatchTaskHandler", () => {
  const deps = {
    getUserSettings: vi.fn(),
    updateCalendarEventCompletion: vi.fn(),
    mapCalendarEventToTask: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 for invalid task id", async () => {
    const req = { user: { id: "user-1" }, params: {}, body: { completed: true } } as never
    const response = createMockResponse()

    await createPatchTaskHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: "Invalid task id" })
  })

  it("returns 404 when task does not exist", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "event-1" },
      body: { completed: true },
    } as never
    deps.getUserSettings.mockResolvedValueOnce({ calendarId: "primary" })
    deps.updateCalendarEventCompletion.mockResolvedValueOnce(null)
    const response = createMockResponse()

    await createPatchTaskHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: "Task not found" })
  })

  it("returns mapped updated task", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "event-1" },
      body: { completed: true },
    } as never
    deps.getUserSettings.mockResolvedValueOnce({ calendarId: "primary" })
    deps.updateCalendarEventCompletion.mockResolvedValueOnce({ id: "event-1" })
    deps.mapCalendarEventToTask.mockReturnValueOnce({
      id: "event-1",
      title: "Done",
      details: null,
      duration: 30,
      scheduledStart: "2026-02-09T10:00:00.000Z",
      scheduledEnd: "2026-02-09T10:30:00.000Z",
      completed: true,
      completedAt: "2026-02-09T10:35:00.000Z",
      priority: 0,
    })
    const response = createMockResponse()

    await createPatchTaskHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({ id: "event-1", completed: true })
  })
})

describe("createRescheduleTaskHandler", () => {
  const deps = {
    getUserSettings: vi.fn(),
    getCalendarEvent: vi.fn(),
    findFreeSlot: vi.fn(),
    updateCalendarEventTime: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 for invalid task id", async () => {
    const req = { user: { id: "user-1" }, params: {} } as never
    const response = createMockResponse()
    await createRescheduleTaskHandler(deps)(req, response.res as never, vi.fn())
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: "Invalid task id" })
  })

  it("returns 409 when no new slot is available", async () => {
    const req = { user: { id: "user-1" }, params: { id: "event-1" } } as never
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
    })
    deps.getCalendarEvent.mockResolvedValueOnce({
      start: { dateTime: "2026-02-09T10:00:00.000Z" },
      end: { dateTime: "2026-02-09T10:30:00.000Z" },
    })
    deps.findFreeSlot.mockResolvedValueOnce(null)
    const response = createMockResponse()

    await createRescheduleTaskHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({
      error: "No free time slots available in the next 90 days.",
    })
  })

  it("reschedules task when a free slot exists", async () => {
    const req = { user: { id: "user-1" }, params: { id: "event-1" } } as never
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
    })
    deps.getCalendarEvent.mockResolvedValueOnce({
      start: { dateTime: "2026-02-09T10:00:00.000Z" },
      end: { dateTime: "2026-02-09T10:30:00.000Z" },
    })
    deps.findFreeSlot.mockResolvedValueOnce({
      start: new Date("2026-02-10T10:00:00.000Z"),
      end: new Date("2026-02-10T10:30:00.000Z"),
    })
    deps.updateCalendarEventTime.mockResolvedValueOnce(true)
    const response = createMockResponse()

    await createRescheduleTaskHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ success: true })
  })
})

describe("createReorderTasksHandler", () => {
  const deps = {
    getUserSettings: vi.fn(),
    getCalendarEventsForTasks: vi.fn(),
    updateCalendarEventTime: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 for invalid payload", async () => {
    const req = { user: { id: "user-1" }, body: { taskIds: "bad" } } as never
    const response = createMockResponse()

    await createReorderTasksHandler(deps)(req, response.res as never, vi.fn())
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: "Invalid taskIds payload" })
  })

  it("returns 404 when no valid task events are found", async () => {
    const req = { user: { id: "user-1" }, body: { taskIds: ["t1"] } } as never
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
    })
    deps.getCalendarEventsForTasks.mockResolvedValueOnce(new Map([["t1", null]]))
    const response = createMockResponse()

    await createReorderTasksHandler(deps)(req, response.res as never, vi.fn())
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: "No tasks found to reorder" })
  })

  it("updates event times when order changes", async () => {
    const req = { user: { id: "user-1" }, body: { taskIds: ["t1", "t2"] } } as never
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
    })
    const event1 = {
      start: new Date("2026-02-10T10:00:00.000Z"),
      end: new Date("2026-02-10T10:30:00.000Z"),
      durationMinutes: 30,
    }
    const event2 = {
      start: new Date("2026-02-10T09:00:00.000Z"),
      end: new Date("2026-02-10T09:30:00.000Z"),
      durationMinutes: 30,
    }
    deps.getCalendarEventsForTasks.mockResolvedValueOnce(
      new Map([
        ["t1", event1],
        ["t2", event2],
      ]),
    )
    deps.updateCalendarEventTime.mockResolvedValue(true)
    const response = createMockResponse()

    await createReorderTasksHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ success: true })
    expect(deps.updateCalendarEventTime).toHaveBeenCalled()
  })
})

describe("createBulkCompleteTasksHandler", () => {
  const deps = {
    getUserSettings: vi.fn(),
    updateCalendarEventCompletion: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 for invalid payload", async () => {
    const req = { user: { id: "user-1" }, body: { taskIds: [] } } as never
    const response = createMockResponse()

    await createBulkCompleteTasksHandler(deps)(req, response.res as never, vi.fn())
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: "Invalid taskIds payload" })
  })

  it("marks all tasks complete for valid payload", async () => {
    const req = { user: { id: "user-1" }, body: { taskIds: ["t1", "t2"] } } as never
    deps.getUserSettings.mockResolvedValueOnce({ calendarId: "primary" })
    deps.updateCalendarEventCompletion.mockResolvedValue({})
    const response = createMockResponse()

    await createBulkCompleteTasksHandler(deps)(req, response.res as never, vi.fn())
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ success: true })
    expect(deps.updateCalendarEventCompletion).toHaveBeenCalledTimes(2)
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
})
