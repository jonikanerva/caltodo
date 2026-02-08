// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { getCurrentUser } from "./auth"
import { getCsrfToken, setCsrfToken } from "./csrf"

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  setCsrfToken(undefined)
})
afterAll(() => server.close())

describe("getCurrentUser", () => {
  it("returns null for unauthenticated responses", async () => {
    server.use(http.get("/api/auth/user", () => new HttpResponse(null, { status: 401 })))

    await expect(getCurrentUser()).resolves.toBeNull()
  })

  it("stores csrf token from the auth payload", async () => {
    server.use(
      http.get("/api/auth/user", () =>
        HttpResponse.json({
          id: "user-1",
          googleId: "google-1",
          email: "user@example.com",
          displayName: "User",
          csrfToken: "csrf-from-auth",
        }),
      ),
    )

    const user = await getCurrentUser()
    expect(user?.id).toBe("user-1")
    expect(getCsrfToken()).toBe("csrf-from-auth")
  })
})
