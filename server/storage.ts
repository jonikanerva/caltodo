import {
  users,
  userSettings,
  type User,
  type InsertUser,
  type UserSettings,
  type InsertUserSettings,
} from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { decryptToken, encryptToken } from "./crypto";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByGoogleId(googleId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined>;
  
  getUserSettings(userId: string): Promise<UserSettings | undefined>;
  createUserSettings(settings: InsertUserSettings): Promise<UserSettings>;
  updateUserSettings(userId: string, data: Partial<InsertUserSettings>): Promise<UserSettings | undefined>;
}

export class DatabaseStorage implements IStorage {
  private decryptUserTokens(user: User | undefined): User | undefined {
    if (!user) return undefined;
    return {
      ...user,
      accessToken: decryptToken(user.accessToken) ?? null,
      refreshToken: decryptToken(user.refreshToken) ?? null,
    };
  }

  private withEncryptedTokens<T extends Partial<InsertUser>>(data: T): T {
    const result: Partial<InsertUser> = { ...data };
    if (Object.prototype.hasOwnProperty.call(result, "accessToken")) {
      (result as any).accessToken = encryptToken(result.accessToken) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(result, "refreshToken")) {
      (result as any).refreshToken = encryptToken(result.refreshToken) ?? null;
    }
    return result as T;
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return this.decryptUserTokens(user) || undefined;
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.googleId, googleId));
    return this.decryptUserTokens(user) || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(this.withEncryptedTokens(insertUser)).returning();
    return this.decryptUserTokens(user)!;
  }

  async updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set(this.withEncryptedTokens(data))
      .where(eq(users.id, id))
      .returning();
    return this.decryptUserTokens(user) || undefined;
  }

  async getUserSettings(userId: string): Promise<UserSettings | undefined> {
    const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
    return settings || undefined;
  }

  async createUserSettings(settings: InsertUserSettings): Promise<UserSettings> {
    const [result] = await db.insert(userSettings).values(settings).returning();
    return result;
  }

  async updateUserSettings(userId: string, data: Partial<InsertUserSettings>): Promise<UserSettings | undefined> {
    const [result] = await db
      .update(userSettings)
      .set(data)
      .where(eq(userSettings.userId, userId))
      .returning();
    return result || undefined;
  }
}

export const storage = new DatabaseStorage();
