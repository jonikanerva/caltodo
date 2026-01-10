import { sql } from "drizzle-orm"
import { pgTable, text, varchar, integer, timestamp, json } from "drizzle-orm/pg-core"
import { relations } from "drizzle-orm"
import { createInsertSchema } from "drizzle-zod"
import { z } from "zod"

// Session table managed by connect-pg-simple (do not modify)
export const userSessions = pgTable("user_sessions", {
  sid: varchar("sid").primaryKey(),
  sess: json("sess").notNull(),
  expire: timestamp("expire", { precision: 6 }).notNull(),
})

export const users = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  googleId: text("google_id").notNull().unique(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
})

export const usersRelations = relations(users, ({ one }) => ({
  settings: one(userSettings),
}))

export const userSettings = pgTable("user_settings", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id)
    .unique(),
  calendarId: text("calendar_id"),
  workStartHour: integer("work_start_hour").notNull().default(9),
  workEndHour: integer("work_end_hour").notNull().default(17),
  timezone: text("timezone").notNull().default("America/New_York"),
  defaultDuration: integer("default_duration").notNull().default(60),
  eventColor: text("event_color").notNull().default("1"),
})

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, {
    fields: [userSettings.userId],
    references: [users.id],
  }),
}))

export const actionTokens = pgTable("action_tokens", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tokenHash: text("token_hash").notNull().unique(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  eventId: text("event_id").notNull(),
  calendarId: text("calendar_id").notNull(),
  expiresAt: timestamp("expires_at", { precision: 6 }).notNull(),
  usedAt: timestamp("used_at", { precision: 6 }),
  createdAt: timestamp("created_at", { precision: 6 }).notNull().defaultNow(),
})

export const insertUserSchema = createInsertSchema(users).omit({ id: true })
export const insertUserSettingsSchema = createInsertSchema(userSettings).omit({
  id: true,
})

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  details: z.string().optional(),
  urgent: z.boolean().optional().default(false),
  duration: z.number().min(15).max(480).optional(),
})

export const updateSettingsSchema = z.object({
  calendarId: z.string().optional(),
  workStartHour: z.number().min(0).max(23),
  workEndHour: z.number().min(0).max(23),
  timezone: z.string().refine((tz) => {
    try {
      return Intl.supportedValuesOf("timeZone").includes(tz)
    } catch {
      return false
    }
  }, "Invalid timezone"),
  defaultDuration: z.number().min(15).max(480),
  eventColor: z.string(),
})

export type InsertUser = z.infer<typeof insertUserSchema>
export type User = typeof users.$inferSelect
export type InsertUserSettings = z.infer<typeof insertUserSettingsSchema>
export type UserSettings = typeof userSettings.$inferSelect
export type ActionToken = typeof actionTokens.$inferSelect
export type InsertActionToken = typeof actionTokens.$inferInsert
export type CreateTask = z.infer<typeof createTaskSchema>
export type UpdateSettings = z.infer<typeof updateSettingsSchema>
