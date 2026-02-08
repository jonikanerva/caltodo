import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMockResponse } from "./testUtils"

vi.mock("../auth", () => ({
  GOOGLE_OAUTH_SCOPES: [],
}))

vi.mock("../storage", () => ({
  storage: {
    getUserSettings: vi.fn(),
    updateUserSettings: vi.fn(),
    createUserSettings: vi.fn(),
    deleteUserData: vi.fn(),
  },
}))

vi.mock("../calendar", () => ({
  listCalendars: vi.fn(),
}))

import {
  createAuthGoogleCallbackAuthHandler,
  createAuthGoogleCallbackSuccessHandler,
  createAuthGoogleStartHandler,
  createAuthLogoutHandler,
  createAuthUserHandler,
  createDeleteAccountHandler,
  createGetCalendarsHandler,
  createGetSettingsHandler,
  createPatchSettingsHandler,
} from "./authRoutes"

describe("auth handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("stores pending token and delegates to passport authenticate", async () => {
    const authenticate = vi.fn(
      () => (_req: unknown, _res: unknown, next: () => void) => next(),
    )
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

  it("lists calendars for user", async () => {
    const deps = {
      listCalendars: vi.fn().mockResolvedValue([{ id: "primary", summary: "Main" }]),
    }
    const req = { user: { id: "user-1" } } as never
    const res = createMockResponse()

    await createGetCalendarsHandler(deps)(req, res.res as never, vi.fn())
    expect(res.body).toEqual([{ id: "primary", summary: "Main" }])
  })
})
