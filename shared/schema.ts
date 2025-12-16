import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  googleId: text("google_id").notNull().unique(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  settings: one(userSettings),
  tasks: many(tasks),
}));

export const userSettings = pgTable("user_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id).unique(),
  calendarId: text("calendar_id"),
  workStartHour: integer("work_start_hour").notNull().default(9),
  workEndHour: integer("work_end_hour").notNull().default(17),
  timezone: text("timezone").notNull().default("America/New_York"),
  defaultDuration: integer("default_duration").notNull().default(60),
  eventColor: text("event_color").notNull().default("1"),
});

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, {
    fields: [userSettings.userId],
    references: [users.id],
  }),
}));

export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  details: text("details"),
  calendarEventId: text("calendar_event_id"),
  scheduledStart: timestamp("scheduled_start"),
  scheduledEnd: timestamp("scheduled_end"),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  priority: integer("priority").notNull().default(0),
  urgent: boolean("urgent").notNull().default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const tasksRelations = relations(tasks, ({ one }) => ({
  user: one(users, {
    fields: [tasks.userId],
    references: [users.id],
  }),
}));

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export const insertUserSettingsSchema = createInsertSchema(userSettings).omit({ id: true });
export const insertTaskSchema = createInsertSchema(tasks).omit({ id: true, createdAt: true });

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  details: z.string().optional(),
  urgent: z.boolean().optional().default(false),
});

export const updateSettingsSchema = z.object({
  calendarId: z.string().optional(),
  workStartHour: z.number().min(0).max(23),
  workEndHour: z.number().min(0).max(23),
  timezone: z.string(),
  defaultDuration: z.number().min(15).max(480),
  eventColor: z.string(),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertUserSettings = z.infer<typeof insertUserSettingsSchema>;
export type UserSettings = typeof userSettings.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;
export type CreateTask = z.infer<typeof createTaskSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
