import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "http"
import { createIntegrationFixtures } from "./fixtures"
import { createIntegrationHttpServer } from "./testServer"

describe("integration app harness", () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      server = undefined
    })
  })

  it("requires CSRF token on mutating auth endpoint", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)
    const agent = request.agent(server)

    await agent
      .post("/__test/login")
      .send({ userId: fixtures.users.user1.id })
      .expect(200)

    await agent.post("/api/auth/logout").expect(403)
  })

  it("isolates session state between agents", async () => {
    const fixtures = createIntegrationFixtures()
    server = await createIntegrationHttpServer(fixtures)
    const agentA = request.agent(server)
    const agentB = request.agent(server)

    await agentA
      .post("/__test/login")
      .send({ userId: fixtures.users.user1.id })
      .expect(200)

    const aUser = await agentA.get("/api/auth/user").expect(200)
    const bUser = await agentB.get("/api/auth/user").expect(401)

    expect(aUser.body.id).toBe(fixtures.users.user1.id)
    expect(bUser.body.error).toBe("Not authenticated")
  })
})
