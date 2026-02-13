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
  expect(typeof response.body.csrfToken).toBe("string")
  return response.body.csrfToken
}

describe("auth/session integration", () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      server = undefined
    })
  })

  it("returns 401 for unauthenticated protected route", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)

    await request(server).get("/api/tasks").expect(401)
  })

  it("keeps authenticated session across request sequence", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)

    const authUser = await agent.get("/api/auth/user").expect(200)
    const settings = await agent.get("/api/settings").expect(200)

    expect(authUser.body.id).toBe(fixtures.users.user1.id)
    expect(settings.body.calendarId).toBe("primary")
  })

  it("invalidates session after logout", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    await agent.post("/api/auth/logout").set("x-csrf-token", csrfToken).expect(200)

    await agent.get("/api/auth/user").expect(401)
    await agent.get("/api/tasks").expect(401)
  })

  it("enforces action token ownership across users", async () => {
    const fixtures = createIntegrationFixtures()
    fixtures.seedActionToken("tok-owned-by-user2", {
      id: "at-1",
      userId: fixtures.users.user2.id,
      eventId: "event-1",
      calendarId: "primary",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })

    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await loginAs(agent, fixtures.users.user1.id)
    const csrfToken = await getCsrfToken(agent)

    const response = await agent
      .post("/api/action/tok-owned-by-user2")
      .set("x-csrf-token", csrfToken)
      .send({ action: "complete" })
      .expect(403)

    expect(response.body).toEqual({ error: "Unauthorized." })
  })
})
