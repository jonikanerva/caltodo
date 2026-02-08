import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

// Mock config, db, and storage before importing auth
vi.mock("./config", () => ({
  sessionSecret: "test-session-secret-at-least-32-chars",
  actionTokenSecret: "test-action-token-secret-32-chars",
  tokenEncryptionKey: "test-encryption-key-at-least-32-chars",
}))

vi.mock("./db", () => ({
  pool: {},
  db: {},
}))

vi.mock("./storage", () => ({
  storage: {
    getUser: vi.fn(),
    getUserByGoogleId: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
  },
}))

import { requireAuth, GOOGLE_OAUTH_SCOPES } from "./auth"

describe("requireAuth middleware", () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    mockReq = {}
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
    mockNext = vi.fn()
  })

  it("calls next when user is authenticated", () => {
    mockReq.isAuthenticated = () => true

    requireAuth(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalled()
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it("returns 401 when user is not authenticated", () => {
    mockReq.isAuthenticated = () => false

    requireAuth(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).not.toHaveBeenCalled()
    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" })
  })
})

describe("GOOGLE_OAUTH_SCOPES", () => {
  it("includes required OAuth scopes", () => {
    expect(GOOGLE_OAUTH_SCOPES).toContain("profile")
    expect(GOOGLE_OAUTH_SCOPES).toContain("email")
    expect(GOOGLE_OAUTH_SCOPES).toContain(
      "https://www.googleapis.com/auth/calendar.readonly",
    )
    expect(GOOGLE_OAUTH_SCOPES).toContain(
      "https://www.googleapis.com/auth/calendar.events.owned",
    )
  })

  it("has exactly 4 scopes", () => {
    expect(GOOGLE_OAUTH_SCOPES).toHaveLength(4)
  })
})
