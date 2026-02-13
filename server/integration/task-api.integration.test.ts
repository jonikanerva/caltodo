import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "http"
import { EVENT_DELETED } from "../calendar"
import { createIntegrationFixtures } from "./fixtures"
import { createIntegrationHttpServer } from "./testServer"

async function loginAs(agent: request.Agent, userId: string) {
  await agent.post("/__test/login").send({ userId }).expect(200)
}

async function getCsrfToken(agent: request.Agent): Promise<string> {
  const response = await agent.get("/api/auth/user").expect(200)
  return response.body.csrfToken as string
}

describe("task API integration", () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      server = undefined
    })
  })

  it("GET /api/tasks returns empty list when calendar is not configured", async () => {
    const fixtures = createIntegrationFixtures()
    const current = fixtures.settingsByUserId.get(fixtures.users.user1.id)
    fixtures.setUserSettings(
      fixtures.users.user1.id,
      current ? { ...current, calendarId: null } : null,
    )

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const response = await agent.get("/api/tasks").expect(200)

    expect(response.body).toEqual([])
  })

  it("GET /api/tasks maps calendar client failure to 500", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.mocks.task.getCalendarClient.mockResolvedValueOnce(null)

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const response = await agent.get("/api/tasks").expect(500)

    expect(response.body).toEqual({ error: "Failed to access calendar" })
  })

  it("GET /api/tasks returns sorted tasks", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.mocks.task.listCalendarEventsInRange.mockResolvedValueOnce([
      { id: "u2" },
      { id: "c1" },
      { id: "u1" },
    ])
    fixtures.mocks.task.mapCalendarEventToTask.mockImplementation(
      (event: { id: string }) => {
        const map = {
          u1: {
            id: "u1",
            title: "U1",
            details: null,
            duration: 30,
            scheduledStart: "2026-03-02T10:00:00.000Z",
            scheduledEnd: "2026-03-02T10:30:00.000Z",
            completed: false,
            completedAt: null,
            priority: 0,
          },
          u2: {
            id: "u2",
            title: "U2",
            details: null,
            duration: 30,
            scheduledStart: "2026-03-02T09:00:00.000Z",
            scheduledEnd: "2026-03-02T09:30:00.000Z",
            completed: false,
            completedAt: null,
            priority: 0,
          },
          c1: {
            id: "c1",
            title: "C1",
            details: null,
            duration: 30,
            scheduledStart: "2026-03-01T09:00:00.000Z",
            scheduledEnd: "2026-03-01T09:30:00.000Z",
            completed: true,
            completedAt: "2026-03-02T12:00:00.000Z",
            priority: 0,
          },
        } as const

        return map[event.id as keyof typeof map] || null
      },
    )

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const response = await agent.get("/api/tasks").expect(200)

    expect(response.body.map((task: { id: string }) => task.id)).toEqual([
      "u2",
      "u1",
      "c1",
    ])
  })

  it("POST /api/tasks handles success and no-slot conflicts", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    const created = await agent
      .post("/api/tasks")
      .set("x-csrf-token", csrfToken)
      .send({ title: "Write docs", details: "Integration flow", duration: 45 })
      .expect(200)

    expect(created.body.id).toBeDefined()
    expect(created.body.title).toBe("Write docs")

    fixtures.mocks.task.findFreeSlot.mockResolvedValueOnce(null)
    const conflict = await agent
      .post("/api/tasks")
      .set("x-csrf-token", csrfToken)
      .send({ title: "Second task", duration: 30 })
      .expect(409)

    expect(conflict.body).toEqual({
      error: "No free time slots available in the next 90 days.",
    })
  })

  it("POST /api/tasks maps null create result to 500", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.mocks.task.createCalendarEvent.mockResolvedValueOnce(null)

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    const response = await agent
      .post("/api/tasks")
      .set("x-csrf-token", csrfToken)
      .send({ title: "Will fail", duration: 30 })
      .expect(500)

    expect(response.body).toEqual({ error: "Failed to create calendar event" })
  })

  it("PATCH /api/tasks/:id handles missing settings and not found", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    fixtures.setUserSettings(fixtures.users.user1.id, null)

    await agent
      .patch("/api/tasks/evt-missing")
      .set("x-csrf-token", csrfToken)
      .send({ completed: true })
      .expect(400)

    const current = fixtures.settingsByUserId.get(fixtures.users.user2.id)
    if (current) {
      fixtures.setUserSettings(fixtures.users.user1.id, {
        ...current,
        userId: fixtures.users.user1.id,
      })
    }

    fixtures.mocks.task.updateCalendarEventCompletion.mockResolvedValueOnce(null)

    const notFound = await agent
      .patch("/api/tasks/evt-missing")
      .set("x-csrf-token", csrfToken)
      .send({ completed: true })
      .expect(404)

    expect(notFound.body).toEqual({ error: "Task not found" })
  })

  it("POST /api/tasks/:id/reschedule maps event/slot/update failures", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    fixtures.mocks.task.getCalendarEvent.mockResolvedValueOnce(null)
    await agent
      .post("/api/tasks/evt-1/reschedule")
      .set("x-csrf-token", csrfToken)
      .expect(404)

    fixtures.mocks.task.getCalendarEvent.mockResolvedValueOnce({
      id: "evt-1",
      start: { dateTime: "2026-03-02T10:00:00.000Z" },
      end: { dateTime: "2026-03-02T10:30:00.000Z" },
    })
    fixtures.mocks.task.findFreeSlot.mockResolvedValueOnce(null)

    await agent
      .post("/api/tasks/evt-1/reschedule")
      .set("x-csrf-token", csrfToken)
      .expect(409)

    fixtures.mocks.task.getCalendarEvent.mockResolvedValueOnce({
      id: "evt-1",
      start: { dateTime: "2026-03-02T10:00:00.000Z" },
      end: { dateTime: "2026-03-02T10:30:00.000Z" },
    })
    fixtures.mocks.task.findFreeSlot.mockResolvedValueOnce({
      start: new Date("2026-03-02T12:00:00.000Z"),
      end: new Date("2026-03-02T12:30:00.000Z"),
    })
    fixtures.mocks.task.updateCalendarEventTime.mockResolvedValueOnce(false)

    const notFound = await agent
      .post("/api/tasks/evt-1/reschedule")
      .set("x-csrf-token", csrfToken)
      .expect(404)

    expect(notFound.body).toEqual({ error: "Task not found" })
  })

  it("POST /api/tasks/reorder handles invalid payload, deleted events, and success", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.seedEvent({
      id: "t1",
      summary: "☑️ T1",
      start: { dateTime: "2026-03-02T10:00:00.000Z" },
      end: { dateTime: "2026-03-02T10:30:00.000Z" },
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    })
    fixtures.seedEvent({
      id: "t2",
      summary: "☑️ T2",
      start: { dateTime: "2026-03-02T09:00:00.000Z" },
      end: { dateTime: "2026-03-02T09:30:00.000Z" },
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    })

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    await agent
      .post("/api/tasks/reorder")
      .set("x-csrf-token", csrfToken)
      .send({ taskIds: "bad" })
      .expect(400)

    fixtures.mocks.task.getCalendarEventsForTasks.mockResolvedValueOnce(
      new Map([["ghost", EVENT_DELETED]]),
    )
    await agent
      .post("/api/tasks/reorder")
      .set("x-csrf-token", csrfToken)
      .send({ taskIds: ["ghost"] })
      .expect(404)

    const success = await agent
      .post("/api/tasks/reorder")
      .set("x-csrf-token", csrfToken)
      .send({ taskIds: ["t1", "t2"] })
      .expect(200)

    expect(success.body).toEqual({ success: true })
    expect(fixtures.mocks.task.updateCalendarEventTime).toHaveBeenCalled()
  })
})
