import {
  users,
  userSettings,
  actionTokens,
  userSessions,
  type User,
  type InsertUser,
  type UserSettings,
  type InsertUserSettings,
  type ActionToken,
  type InsertActionToken,
} from "@shared/schema"
import { db } from "./db"
import { and, eq, isNotNull, isNull, lt, ne, sql } from "drizzle-orm"
import { decryptToken, encryptToken } from "./crypto"

export interface IStorage {
  getUser(id: string): Promise<User | undefined>
  getUserByGoogleId(googleId: string): Promise<User | undefined>
  createUser(user: InsertUser): Promise<User>
  updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined>
  deleteUserData(userId: string): Promise<void>

  getUserSettings(userId: string): Promise<UserSettings | undefined>
  createUserSettings(settings: InsertUserSettings): Promise<UserSettings>
  updateUserSettings(
    userId: string,
    data: Partial<InsertUserSettings>,
  ): Promise<UserSettings | undefined>

  createActionToken(token: InsertActionToken): Promise<ActionToken>
  getActionTokenByHash(tokenHash: string): Promise<ActionToken | undefined>
  markActionTokenUsed(id: string): Promise<ActionToken | undefined>
  cleanupActionTokens(now: Date, usedBefore: Date): Promise<number>
  invalidateActionTokensForEvent(
    userId: string,
    eventId: string,
    calendarId: string,
    keepTokenHash?: string,
  ): Promise<void>
}

export class DatabaseStorage implements IStorage {
  private decryptUserTokens(user: User | undefined): User | undefined {
    if (!user) return undefined
    return {
      ...user,
      accessToken: decryptToken(user.accessToken) ?? null,
      refreshToken: decryptToken(user.refreshToken) ?? null,
    }
  }

  private withEncryptedTokens<T extends Partial<InsertUser>>(data: T): T {
    const accessTokenPatch = Object.prototype.hasOwnProperty.call(data, "accessToken")
      ? { accessToken: encryptToken(data.accessToken) ?? null }
      : {}

    const refreshTokenPatch = Object.prototype.hasOwnProperty.call(data, "refreshToken")
      ? { refreshToken: encryptToken(data.refreshToken) ?? null }
      : {}

    return {
      ...data,
      ...accessTokenPatch,
      ...refreshTokenPatch,
    } as T
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id))
    return this.decryptUserTokens(user) || undefined
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.googleId, googleId))
    return this.decryptUserTokens(user) || undefined
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(this.withEncryptedTokens(insertUser))
      .returning()
    return this.decryptUserTokens(user)!
  }

  async updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set(this.withEncryptedTokens(data))
      .where(eq(users.id, id))
      .returning()
    return this.decryptUserTokens(user) || undefined
  }

  async deleteUserData(userId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(actionTokens).where(eq(actionTokens.userId, userId))
      await tx.delete(userSettings).where(eq(userSettings.userId, userId))
      await tx.delete(users).where(eq(users.id, userId))
      await tx
        .delete(userSessions)
        .where(sql`${userSessions.sess} -> 'passport' ->> 'user' = ${userId}`)
    })
  }

  async getUserSettings(userId: string): Promise<UserSettings | undefined> {
    const [settings] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
    return settings || undefined
  }

  async createUserSettings(settings: InsertUserSettings): Promise<UserSettings> {
    const [result] = await db.insert(userSettings).values(settings).returning()
    return result
  }

  async updateUserSettings(
    userId: string,
    data: Partial<InsertUserSettings>,
  ): Promise<UserSettings | undefined> {
    const [result] = await db
      .update(userSettings)
      .set(data)
      .where(eq(userSettings.userId, userId))
      .returning()
    return result || undefined
  }

  async createActionToken(token: InsertActionToken): Promise<ActionToken> {
    const [result] = await db.insert(actionTokens).values(token).returning()
    return result
  }

  async getActionTokenByHash(tokenHash: string): Promise<ActionToken | undefined> {
    const [result] = await db
      .select()
      .from(actionTokens)
      .where(eq(actionTokens.tokenHash, tokenHash))
    return result || undefined
  }

  async markActionTokenUsed(id: string): Promise<ActionToken | undefined> {
    const [result] = await db
      .update(actionTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(actionTokens.id, id), isNull(actionTokens.usedAt)))
      .returning()
    return result || undefined
  }

  async cleanupActionTokens(now: Date, usedBefore: Date): Promise<number> {
    const expired = await db
      .delete(actionTokens)
      .where(lt(actionTokens.expiresAt, now))
      .returning({ id: actionTokens.id })

    const used = await db
      .delete(actionTokens)
      .where(and(isNotNull(actionTokens.usedAt), lt(actionTokens.usedAt, usedBefore)))
      .returning({ id: actionTokens.id })

    return expired.length + used.length
  }

  async invalidateActionTokensForEvent(
    userId: string,
    eventId: string,
    calendarId: string,
    keepTokenHash?: string,
  ): Promise<void> {
    const baseConditions = [
      eq(actionTokens.userId, userId),
      eq(actionTokens.eventId, eventId),
      eq(actionTokens.calendarId, calendarId),
      isNull(actionTokens.usedAt),
    ]
    const conditions = keepTokenHash
      ? [...baseConditions, ne(actionTokens.tokenHash, keepTokenHash)]
      : baseConditions
    await db
      .update(actionTokens)
      .set({ usedAt: new Date() })
      .where(and(...conditions))
  }
}

export const storage = new DatabaseStorage()
