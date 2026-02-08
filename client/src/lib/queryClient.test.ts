// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { apiRequest, getQueryFn } from "./queryClient"
import { getCsrfToken, setCsrfToken } from "./csrf"

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  setCsrfToken(undefined)
})
afterAll(() => server.close())
beforeEach(() => setCsrfToken(undefined))

describe("apiRequest", () => {
  it("sends X-CSRF-Token header on non-GET requests", async () => {
    setCsrfToken("csrf-123")

    server.use(
      http.post("/api/tasks", ({ request }) => {
        return HttpResponse.json({
          token: request.headers.get("x-csrf-token"),
        })
      }),
    )

    const response = await apiRequest("POST", "/api/tasks", { title: "Test task" })
    const data = (await response.json()) as { token: string | null }
    expect(data.token).toBe("csrf-123")
  })
})

describe("getQueryFn", () => {
  it("returns null for 401 when on401 is returnNull", async () => {
    server.use(http.get("/api/auth/user", () => new HttpResponse(null, { status: 401 })))

    const queryFn = getQueryFn<{ id: string } | null>({ on401: "returnNull" })
    const result = await queryFn({ queryKey: ["/api/auth/user"] } as never)
    expect(result).toBeNull()
  })

  it("stores csrf token from /api/auth/user responses", async () => {
    server.use(
      http.get("/api/auth/user", () =>
        HttpResponse.json({ id: "user-1", csrfToken: "csrf-abc" }),
      ),
    )

    const queryFn = getQueryFn<{ id: string; csrfToken: string }>({ on401: "throw" })
    const result = await queryFn({ queryKey: ["/api/auth/user"] } as never)
    expect(result.id).toBe("user-1")
    expect(getCsrfToken()).toBe("csrf-abc")
  })
})
