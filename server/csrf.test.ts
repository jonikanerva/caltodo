import { describe, expect, it } from "vitest"
import { ensureCsrfToken, requireCsrfToken } from "./csrf"

describe("CSRF middleware", () => {
  it("adds a token to the session when missing", () => {
    const req = { session: {} } as never
    const next = () => undefined

    ensureCsrfToken(req, {} as never, next)
    expect(typeof req.session.csrfToken).toBe("string")
    expect(req.session.csrfToken.length).toBeGreaterThan(20)
  })

  it("rejects unsafe requests without a matching token", () => {
    let statusCode: number | null = null
    let body: unknown
    const req = {
      method: "POST",
      session: { csrfToken: "expected-token" },
      body: {},
      get: () => undefined,
    } as never
    const res = {
      status: (code: number) => {
        statusCode = code
        return {
          json: (payload: unknown) => {
            body = payload
          },
        }
      },
    } as never

    requireCsrfToken(req, res, () => undefined)
    expect(statusCode).toBe(403)
    expect(body).toEqual({ error: "Invalid CSRF token" })
  })

  it("accepts unsafe requests with a matching header token", () => {
    let called = false
    const req = {
      method: "PATCH",
      session: { csrfToken: "expected-token" },
      body: {},
      get: (name: string) => (name === "x-csrf-token" ? "expected-token" : undefined),
    } as never

    requireCsrfToken(req, {} as never, () => {
      called = true
    })
    expect(called).toBe(true)
  })
})
