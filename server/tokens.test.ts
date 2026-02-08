import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  return {
    createActionToken: vi.fn(),
    getActionTokenByHash: vi.fn(),
    markActionTokenUsed: vi.fn(),
  }
})

vi.mock("./config", () => ({
  actionTokenSecret: "action-token-secret-at-least-32-characters",
}))

vi.mock("./storage", () => ({
  storage: {
    createActionToken: mocks.createActionToken,
    getActionTokenByHash: mocks.getActionTokenByHash,
    markActionTokenUsed: mocks.markActionTokenUsed,
  },
}))

import { consumeActionToken, createActionToken, getActionToken } from "./tokens"

describe("tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("creates and persists a hashed action token", async () => {
    mocks.createActionToken.mockResolvedValueOnce({ id: "token-record-id" })

    const created = await createActionToken("user-1", "event-1", "calendar-1")

    expect(created.id).toBe("token-record-id")
    expect(created.token.length).toBeGreaterThan(10)
    expect(created.tokenHash).not.toBe(created.token)
    expect(mocks.createActionToken).toHaveBeenCalledTimes(1)
  })

  it("returns null for expired tokens", async () => {
    mocks.getActionTokenByHash.mockResolvedValueOnce({
      id: "record-1",
      userId: "user-1",
      eventId: "event-1",
      calendarId: "calendar-1",
      expiresAt: new Date(Date.now() - 1_000),
      usedAt: null,
    })

    const result = await getActionToken("raw-token")
    expect(result).toBeNull()
  })

  it("consumes a valid token only for expected user", async () => {
    mocks.getActionTokenByHash.mockResolvedValueOnce({
      id: "record-1",
      userId: "user-1",
      eventId: "event-1",
      calendarId: "calendar-1",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    })
    mocks.markActionTokenUsed.mockResolvedValueOnce({ id: "record-1" })

    const result = await consumeActionToken("raw-token", "user-1")

    expect(result).toMatchObject({
      id: "record-1",
      userId: "user-1",
      eventId: "event-1",
      calendarId: "calendar-1",
    })
    expect(mocks.markActionTokenUsed).toHaveBeenCalledWith("record-1")
  })
})
