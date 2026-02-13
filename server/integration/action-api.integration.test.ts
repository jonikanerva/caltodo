import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "http"
import { createIntegrationFixtures } from "./fixtures"
import { createIntegrationHttpServer } from "./testServer"

async function loginAs(agent: request.Agent, userId: string) {
  await agent.post("/__test/login").send({ userId }).expect(200)
}

async function getCsrfToken(agent: request.Agent): Promise<string> {
  const response = await agent.get("/api/auth/user").expect(200)
  return response.body.csrfToken as string
}

describe("action API integration", () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      server = undefined
    })
  })

  it("GET /action/:token returns sign-in prompt when unauthenticated", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.seedActionToken("tok-public", {
      id: "at-1",
      userId: fixtures.users.user1.id,
      eventId: "evt-1",
      calendarId: "primary",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })

    server = await createIntegrationHttpServer(fixtures)
    const response = await request(server).get("/action/tok-public").expect(200)

    expect(response.text).toContain("Sign in required")
  })

  it("GET /action/:token enforces ownership and not-found contracts", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.seedActionToken("tok-user2", {
      id: "at-2",
      userId: fixtures.users.user2.id,
      eventId: "evt-missing",
      calendarId: "primary",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const unauthorized = await agent.get("/action/tok-user2").expect(403)
    expect(unauthorized.text).toContain("Not authorized")

    fixtures.seedActionToken("tok-user1", {
      id: "at-3",
      userId: fixtures.users.user1.id,
      eventId: "evt-missing",
      calendarId: "primary",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })
    fixtures.mocks.action.getCalendarEvent.mockResolvedValueOnce(null)

    const missing = await agent.get("/action/tok-user1").expect(404)
    expect(missing.text).toContain("Task not found")
  })

  it("POST /api/action/:token JSON handles invalid token and owner mismatch", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    await agent
      .post("/api/action/not-a-token")
      .set("x-csrf-token", csrfToken)
      .send({ action: "complete" })
      .expect(400)

    fixtures.seedActionToken("tok-owner-mismatch", {
      id: "at-4",
      userId: fixtures.users.user2.id,
      eventId: "evt-2",
      calendarId: "primary",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })

    const unauthorized = await agent
      .post("/api/action/tok-owner-mismatch")
      .set("x-csrf-token", csrfToken)
      .send({ action: "complete" })
      .expect(403)

    expect(unauthorized.body).toEqual({ error: "Unauthorized." })
  })

  it("POST /api/action/:token JSON completes task and returns success", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.seedEvent({
      id: "evt-complete",
      summary: "☑️ Complete me",
      start: { dateTime: "2026-03-02T10:00:00.000Z" },
      end: { dateTime: "2026-03-02T10:30:00.000Z" },
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    })
    fixtures.seedActionToken("tok-complete", {
      id: "at-5",
      userId: fixtures.users.user1.id,
      eventId: "evt-complete",
      calendarId: "primary",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    const response = await agent
      .post("/api/action/tok-complete")
      .set("x-csrf-token", csrfToken)
      .send({ action: "complete" })
      .expect(200)

    expect(response.body).toEqual({ success: true })
  })

  it("POST /api/action/:token returns 500 when action refresh fails", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.seedEvent({
      id: "evt-refresh",
      summary: "☑️ Refresh fail",
      start: { dateTime: "2026-03-02T10:00:00.000Z" },
      end: { dateTime: "2026-03-02T10:30:00.000Z" },
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    })
    fixtures.seedActionToken("tok-refresh", {
      id: "at-6",
      userId: fixtures.users.user1.id,
      eventId: "evt-refresh",
      calendarId: "primary",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })
    fixtures.mocks.action.refreshCalendarEventActions.mockRejectedValueOnce(
      new Error("refresh failed"),
    )

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    const response = await agent
      .post("/api/action/tok-refresh")
      .set("x-csrf-token", csrfToken)
      .send({ action: "complete" })
      .expect(500)

    expect(response.body).toEqual({ error: "Failed to process action" })

    fixtures.mocks.action.refreshCalendarEventActions.mockResolvedValueOnce(undefined)
    const retry = await agent
      .post("/api/action/tok-refresh")
      .set("x-csrf-token", csrfToken)
      .send({ action: "complete" })
      .expect(200)
    expect(retry.body).toEqual({ success: true })
  })

  it("POST /api/action/:token HTML returns parity for error and success", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.seedEvent({
      id: "evt-html",
      summary: "☑️ HTML task",
      start: { dateTime: "2026-03-02T10:00:00.000Z" },
      end: { dateTime: "2026-03-02T10:30:00.000Z" },
      extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
    })
    fixtures.seedActionToken("tok-html", {
      id: "at-7",
      userId: fixtures.users.user1.id,
      eventId: "evt-html",
      calendarId: "primary",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    const invalidHtml = await agent
      .post("/api/action/not-a-token")
      .set("accept", "text/html")
      .set("x-csrf-token", csrfToken)
      .send({ action: "complete" })
      .expect(400)
    expect(invalidHtml.text).toContain("Invalid or expired link")

    fixtures.mocks.action.findFreeSlot.mockResolvedValueOnce({
      start: new Date("2026-03-02T12:00:00.000Z"),
      end: new Date("2026-03-02T12:30:00.000Z"),
    })
    fixtures.mocks.action.updateCalendarEventTime.mockResolvedValueOnce(true)

    const successHtml = await agent
      .post("/api/action/tok-html")
      .set("accept", "text/html")
      .set("x-csrf-token", csrfToken)
      .send({ action: "reschedule" })
      .expect(200)

    expect(successHtml.text).toContain("Task rescheduled")
  })
})
