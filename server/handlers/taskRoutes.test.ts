import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMockResponse } from "./testUtils"

vi.mock("../storage", () => ({
  storage: {
    getUserSettings: vi.fn(),
    updateUserSettings: vi.fn(),
    createUserSettings: vi.fn(),
    deleteUserData: vi.fn(),
  },
}))

vi.mock("../calendar", () => ({
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

import {
  createBulkCompleteTasksHandler,
  createCompleteTaskHandler,
  createGetTasksHandler,
  createPatchTaskHandler,
  createPostTasksHandler,
  createReloadTasksHandler,
  createReorderTasksHandler,
  createRescheduleAllTasksHandler,
  createRescheduleTaskHandler,
} from "./taskRoutes"

describe("task utility handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reschedules all tasks", async () => {
    const deps = {
      rescheduleAllUserTasks: vi.fn().mockResolvedValue({
        moved: 1,
        unchanged: 2,
        skippedNoSlot: 0,
        skippedInvalid: 0,
        failed: 0,
      }),
    }
    const req = { user: { id: "user-1" } } as never
    const res = createMockResponse()

    await createRescheduleAllTasksHandler(deps)(req, res.res as never, vi.fn())
    expect(deps.rescheduleAllUserTasks).toHaveBeenCalledWith("user-1")
    expect(res.body).toEqual({
      success: true,
      summary: {
        moved: 1,
        unchanged: 2,
        skippedNoSlot: 0,
        skippedInvalid: 0,
        failed: 0,
      },
    })
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

  it("maps createCalendarEvent null to 500 contract error", async () => {
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
    })
    deps.findFreeSlot.mockResolvedValueOnce({
      start: new Date("2026-02-09T10:00:00.000Z"),
      end: new Date("2026-02-09T10:45:00.000Z"),
    })
    deps.createCalendarEvent.mockResolvedValueOnce(null)
    const response = createMockResponse()

    await createPostTasksHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({ error: "Failed to create calendar event" })
  })

  it("maps upstream slot-resolution throw to 500 create-task error", async () => {
    deps.getUserSettings.mockResolvedValueOnce({
      calendarId: "primary",
      defaultDuration: 30,
    })
    deps.findFreeSlot.mockRejectedValueOnce(new Error("calendar api down"))
    const response = createMockResponse()

    await createPostTasksHandler(deps, () => "http://localhost:5000")(
      req,
      response.res as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({ error: "Failed to create task" })
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

  it("maps updateCalendarEventTime false to task-not-found response", async () => {
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
    deps.updateCalendarEventTime.mockResolvedValueOnce(false)
    const response = createMockResponse()

    await createRescheduleTaskHandler(deps)(req, response.res as never, vi.fn())

    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: "Task not found" })
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
