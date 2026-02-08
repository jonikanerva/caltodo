import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the db module before importing storage
vi.mock("./db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}))

// Mock crypto to avoid needing real encryption key
vi.mock("./crypto", () => ({
  encryptToken: vi.fn((v) => (v ? `encrypted:${v}` : v)),
  decryptToken: vi.fn((v) =>
    v?.startsWith("encrypted:") ? v.replace("encrypted:", "") : v,
  ),
}))

import { db } from "./db"
import { DatabaseStorage } from "./storage"
import { encryptToken, decryptToken } from "./crypto"
import type { User, UserSettings, ActionToken } from "@shared/schema"

describe("DatabaseStorage", () => {
  let storage: DatabaseStorage

  beforeEach(() => {
    vi.clearAllMocks()
    storage = new DatabaseStorage()
  })

  describe("getUser", () => {
    it("returns undefined when user not found", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      vi.mocked(db.select).mockImplementation(mockSelect)

      const result = await storage.getUser("nonexistent-id")
      expect(result).toBeUndefined()
    })

    it("returns user with decrypted tokens when found", async () => {
      const dbUser: User = {
        id: "user-1",
        googleId: "google-123",
        email: "test@example.com",
        displayName: "Test User",
        accessToken: "encrypted:access-token",
        refreshToken: "encrypted:refresh-token",
      }

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([dbUser]),
        }),
      })
      vi.mocked(db.select).mockImplementation(mockSelect)

      const result = await storage.getUser("user-1")

      expect(result).toBeDefined()
      expect(result?.id).toBe("user-1")
      expect(decryptToken).toHaveBeenCalledWith("encrypted:access-token")
      expect(decryptToken).toHaveBeenCalledWith("encrypted:refresh-token")
    })
  })

  describe("getUserByGoogleId", () => {
    it("returns undefined when user not found", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      vi.mocked(db.select).mockImplementation(mockSelect)

      const result = await storage.getUserByGoogleId("unknown-google-id")
      expect(result).toBeUndefined()
    })

    it("returns user when found by google id", async () => {
      const dbUser: User = {
        id: "user-1",
        googleId: "google-123",
        email: "test@example.com",
        displayName: "Test User",
        accessToken: null,
        refreshToken: null,
      }

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([dbUser]),
        }),
      })
      vi.mocked(db.select).mockImplementation(mockSelect)

      const result = await storage.getUserByGoogleId("google-123")
      expect(result?.googleId).toBe("google-123")
    })
  })

  describe("createUser", () => {
    it("encrypts tokens before inserting", async () => {
      const insertedUser: User = {
        id: "new-user-id",
        googleId: "google-new",
        email: "new@example.com",
        displayName: "New User",
        accessToken: "encrypted:new-access",
        refreshToken: "encrypted:new-refresh",
      }

      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([insertedUser]),
        }),
      })
      vi.mocked(db.insert).mockImplementation(mockInsert)

      const result = await storage.createUser({
        googleId: "google-new",
        email: "new@example.com",
        displayName: "New User",
        accessToken: "new-access",
        refreshToken: "new-refresh",
      })

      expect(encryptToken).toHaveBeenCalledWith("new-access")
      expect(encryptToken).toHaveBeenCalledWith("new-refresh")
      expect(result.id).toBe("new-user-id")
    })
  })

  describe("updateUser", () => {
    it("returns undefined when user not found", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      const result = await storage.updateUser("nonexistent", { displayName: "Updated" })
      expect(result).toBeUndefined()
    })

    it("encrypts tokens when updating", async () => {
      const updatedUser: User = {
        id: "user-1",
        googleId: "google-123",
        email: "test@example.com",
        displayName: "Test User",
        accessToken: "encrypted:updated-access",
        refreshToken: "encrypted:existing-refresh",
      }

      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedUser]),
          }),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      const result = await storage.updateUser("user-1", {
        accessToken: "updated-access",
      })

      expect(encryptToken).toHaveBeenCalledWith("updated-access")
      expect(result?.id).toBe("user-1")
    })

    it("does not encrypt tokens not in update data", async () => {
      const updatedUser: User = {
        id: "user-1",
        googleId: "google-123",
        email: "new-email@example.com",
        displayName: "Test User",
        accessToken: null,
        refreshToken: null,
      }

      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedUser]),
          }),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      vi.mocked(encryptToken).mockClear()

      await storage.updateUser("user-1", { email: "new-email@example.com" })

      // encryptToken should not be called for non-token updates
      expect(encryptToken).not.toHaveBeenCalled()
    })
  })

  describe("deleteUserData", () => {
    it("deletes user data in a transaction", async () => {
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
          const tx = {
            delete: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }
          await callback(tx)
        })
      vi.mocked(db.transaction).mockImplementation(mockTransaction)

      await storage.deleteUserData("user-1")

      expect(db.transaction).toHaveBeenCalled()
    })
  })

  describe("getUserSettings", () => {
    it("returns undefined when settings not found", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      vi.mocked(db.select).mockImplementation(mockSelect)

      const result = await storage.getUserSettings("user-1")
      expect(result).toBeUndefined()
    })

    it("returns settings when found", async () => {
      const settings: UserSettings = {
        id: "settings-1",
        userId: "user-1",
        calendarId: "primary",
        workStartHour: 9,
        workEndHour: 17,
        timezone: "America/New_York",
        defaultDuration: 60,
        eventColor: "1",
      }

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([settings]),
        }),
      })
      vi.mocked(db.select).mockImplementation(mockSelect)

      const result = await storage.getUserSettings("user-1")
      expect(result?.calendarId).toBe("primary")
    })
  })

  describe("createUserSettings", () => {
    it("creates and returns settings", async () => {
      const newSettings: UserSettings = {
        id: "settings-new",
        userId: "user-1",
        calendarId: null,
        workStartHour: 9,
        workEndHour: 17,
        timezone: "America/New_York",
        defaultDuration: 60,
        eventColor: "1",
      }

      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newSettings]),
        }),
      })
      vi.mocked(db.insert).mockImplementation(mockInsert)

      const result = await storage.createUserSettings({
        userId: "user-1",
        workStartHour: 9,
        workEndHour: 17,
        timezone: "America/New_York",
        defaultDuration: 60,
        eventColor: "1",
      })

      expect(result.id).toBe("settings-new")
    })
  })

  describe("updateUserSettings", () => {
    it("returns undefined when settings not found", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      const result = await storage.updateUserSettings("user-1", { workStartHour: 8 })
      expect(result).toBeUndefined()
    })

    it("updates and returns settings", async () => {
      const updatedSettings: UserSettings = {
        id: "settings-1",
        userId: "user-1",
        calendarId: "primary",
        workStartHour: 8,
        workEndHour: 18,
        timezone: "America/New_York",
        defaultDuration: 60,
        eventColor: "1",
      }

      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedSettings]),
          }),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      const result = await storage.updateUserSettings("user-1", {
        workStartHour: 8,
        workEndHour: 18,
      })

      expect(result?.workStartHour).toBe(8)
    })
  })

  describe("createActionToken", () => {
    it("creates and returns action token", async () => {
      const token: ActionToken = {
        id: "token-1",
        tokenHash: "hash123",
        userId: "user-1",
        eventId: "event-1",
        calendarId: "primary",
        expiresAt: new Date("2026-02-15"),
        usedAt: null,
        createdAt: new Date(),
      }

      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([token]),
        }),
      })
      vi.mocked(db.insert).mockImplementation(mockInsert)

      const result = await storage.createActionToken({
        tokenHash: "hash123",
        userId: "user-1",
        eventId: "event-1",
        calendarId: "primary",
        expiresAt: new Date("2026-02-15"),
      })

      expect(result.tokenHash).toBe("hash123")
    })
  })

  describe("getActionTokenByHash", () => {
    it("returns undefined when token not found", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      vi.mocked(db.select).mockImplementation(mockSelect)

      const result = await storage.getActionTokenByHash("unknown-hash")
      expect(result).toBeUndefined()
    })

    it("returns token when found", async () => {
      const token: ActionToken = {
        id: "token-1",
        tokenHash: "hash123",
        userId: "user-1",
        eventId: "event-1",
        calendarId: "primary",
        expiresAt: new Date("2026-02-15"),
        usedAt: null,
        createdAt: new Date(),
      }

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([token]),
        }),
      })
      vi.mocked(db.select).mockImplementation(mockSelect)

      const result = await storage.getActionTokenByHash("hash123")
      expect(result?.id).toBe("token-1")
    })
  })

  describe("markActionTokenUsed", () => {
    it("returns undefined when token not found or already used", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      const result = await storage.markActionTokenUsed("nonexistent")
      expect(result).toBeUndefined()
    })

    it("marks token as used and returns it", async () => {
      const usedToken: ActionToken = {
        id: "token-1",
        tokenHash: "hash123",
        userId: "user-1",
        eventId: "event-1",
        calendarId: "primary",
        expiresAt: new Date("2026-02-15"),
        usedAt: new Date(),
        createdAt: new Date(),
      }

      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([usedToken]),
          }),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      const result = await storage.markActionTokenUsed("token-1")
      expect(result?.usedAt).toBeDefined()
    })
  })

  describe("cleanupActionTokens", () => {
    it("returns count of deleted tokens", async () => {
      const mockDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "1" }, { id: "2" }]),
        }),
      })
      vi.mocked(db.delete).mockImplementation(mockDelete)

      const result = await storage.cleanupActionTokens(
        new Date(),
        new Date(Date.now() - 86400000),
      )

      // Called twice: once for expired, once for used
      expect(db.delete).toHaveBeenCalledTimes(2)
      expect(result).toBe(4) // 2 + 2
    })
  })

  describe("invalidateActionTokensForEvent", () => {
    it("invalidates tokens for event", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      await storage.invalidateActionTokensForEvent("user-1", "event-1", "primary")

      expect(db.update).toHaveBeenCalled()
    })

    it("excludes specific token hash when provided", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      })
      vi.mocked(db.update).mockImplementation(mockUpdate)

      await storage.invalidateActionTokensForEvent(
        "user-1",
        "event-1",
        "primary",
        "keep-this-hash",
      )

      expect(db.update).toHaveBeenCalled()
    })
  })
})
