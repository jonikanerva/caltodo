import type { Express, Response } from "express";
import { createServer, type Server } from "http";
import passport from "passport";
import { storage } from "./storage";
import { setupAuth, requireAuth } from "./auth";
import { 
  listCalendars, 
  findFreeSlot, 
  createCalendarEvent, 
  updateCalendarEventTime,
  updateCalendarEventCompletion,
  rescheduleAllUserTasks,
  getCalendarClient,
  listCalendarEventsInRange,
  mapCalendarEventToTask,
  getCalendarEventsForTasks,
  getCalendarEvent,
  EVENT_DELETED,
  stripEventTitlePrefix,
  type CalendarEventData
} from "./calendar";
import { setupCronJobs } from "./cron";
import { createTaskSchema, updateSettingsSchema } from "@shared/schema";
import { verifyActionToken } from "./tokens";
import { z } from "zod";
import { ensureCsrfToken, requireCsrfToken } from "./csrf";
import type { CalendarTask } from "@shared/types";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getBaseUrl(req: any): string {
  const normalize = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };

  const configuredOrigin =
    normalize(process.env.PRODUCTION_APP_URL) ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);
  if (configuredOrigin) {
    return configuredOrigin;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("PRODUCTION_APP_URL must be set in production to build trusted action links");
  }

  return "http://localhost:5000";
}

const patchTaskSchema = z.object({
  completed: z.boolean(),
});

const isProduction = process.env.NODE_ENV === "production" || !!process.env.PRODUCTION_APP_URL;

function clearSessionCookie(res: Response): void {
  res.clearCookie("connect.sid", {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: isProduction,
  });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupAuth(app);
  app.use(ensureCsrfToken);
  app.use(requireCsrfToken);

  const cronBaseUrl = process.env.PRODUCTION_APP_URL 
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://localhost:5000");
  
  setupCronJobs(cronBaseUrl);

  // Log the callback URL being used for debugging
  console.log("OAuth callback URL:", 
    process.env.PRODUCTION_APP_URL 
      ? `${process.env.PRODUCTION_APP_URL}/api/auth/google/callback`
      : process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/auth/google/callback`
        : "http://localhost:5000/api/auth/google/callback"
  );
  
  app.get("/api/auth/google", passport.authenticate("google", {
    scope: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    accessType: "offline",
    prompt: "consent",
  }));

  app.get(
    "/api/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/" }),
    (req, res) => {
      res.redirect("/");
    }
  );

  app.get("/api/auth/user", (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const { id, googleId, email, displayName } = req.user;
    res.json({ id, googleId, email, displayName, csrfToken: req.session?.csrfToken });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      if (req.session) {
        req.session.destroy(() => {
          clearSessionCookie(res);
          res.json({ success: true });
        });
      } else {
        clearSessionCookie(res);
        res.json({ success: true });
      }
    });
  });

  app.get("/api/settings", requireAuth, async (req, res) => {
    try {
      const settings = await storage.getUserSettings(req.user!.id);
      res.json(settings || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to get settings" });
    }
  });

  app.patch("/api/settings", requireAuth, async (req, res) => {
    try {
      const data = updateSettingsSchema.parse(req.body);
      let settings = await storage.getUserSettings(req.user!.id);
      
      if (settings) {
        settings = await storage.updateUserSettings(req.user!.id, data);
      } else {
        settings = await storage.createUserSettings({
          userId: req.user!.id,
          ...data,
        });
      }
      
      res.json(settings);
    } catch (error) {
      console.error("Error updating settings:", error);
      res.status(400).json({ error: "Invalid settings data" });
    }
  });

  app.get("/api/calendars", requireAuth, async (req, res) => {
    try {
      console.log("Fetching calendars for user:", req.user!.id);
      const calendars = await listCalendars(req.user!.id);
      console.log("Calendars found:", calendars.length);
      res.json(calendars);
    } catch (error) {
      console.error("Error fetching calendars:", error);
      res.status(500).json({ error: "Failed to list calendars" });
    }
  });

  app.get("/api/tasks", requireAuth, async (req, res) => {
    try {
      const settings = await storage.getUserSettings(req.user!.id);
      if (!settings?.calendarId) {
        return res.json([]);
      }

      const calendar = await getCalendarClient(req.user!.id);
      if (!calendar) {
        return res.status(500).json({ error: "Failed to access calendar" });
      }

      const now = new Date();
      const timeMin = new Date(now);
      timeMin.setDate(timeMin.getDate() - 14);
      const timeMax = new Date(now);
      timeMax.setDate(timeMax.getDate() + 90);

      const events = await listCalendarEventsInRange(calendar, settings.calendarId, timeMin, timeMax);
      const tasks = events
        .map(mapCalendarEventToTask)
        .filter((task): task is CalendarTask => Boolean(task));

      const uncompletedTasks = tasks
        .filter((task) => !task.completed)
        .sort((a, b) => new Date(a.scheduledStart || 0).getTime() - new Date(b.scheduledStart || 0).getTime())
        .map((task, index) => ({ ...task, priority: index }));

      const completedTasks = tasks
        .filter((task) => task.completed)
        .sort((a, b) => {
          const dateA = new Date(a.completedAt || a.scheduledEnd || 0).getTime();
          const dateB = new Date(b.completedAt || b.scheduledEnd || 0).getTime();
          return dateB - dateA;
        });

      res.json([...uncompletedTasks, ...completedTasks]);
    } catch (error) {
      console.error("Error fetching tasks:", error);
      res.status(500).json({ error: "Failed to get tasks" });
    }
  });

  app.post("/api/tasks", requireAuth, async (req, res) => {
    try {
      const data = createTaskSchema.parse(req.body);
      const settings = await storage.getUserSettings(req.user!.id);

      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" });
      }

      const taskDuration = data.duration || settings.defaultDuration;
      const slot = await findFreeSlot(req.user!.id, settings, taskDuration);

      if (!slot) {
        return res.status(409).json({ error: "No free time slots available in the next 90 days." });
      }

      const eventId = await createCalendarEvent(
        req.user!.id,
        {
          title: data.title,
          details: data.details || null,
          reminderMinutes: data.reminderMinutes ?? null,
        },
        settings,
        slot,
        getBaseUrl(req)
      );

      if (!eventId) {
        return res.status(500).json({ error: "Failed to create calendar event" });
      }

      if (data.urgent) {
        await rescheduleAllUserTasks(req.user!.id, [eventId]);
      }

      const createdEvent = await getCalendarEvent(req.user!.id, eventId, settings.calendarId);
      if (!createdEvent) {
        return res.status(500).json({ error: "Failed to load created event" });
      }

      const task = mapCalendarEventToTask(createdEvent);
      if (!task) {
        return res.status(500).json({ error: "Failed to map created event" });
      }

      res.json(task);
    } catch (error) {
      console.error("Error creating task:", error);
      res.status(400).json({ error: "Failed to create task" });
    }
  });

  app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const data = patchTaskSchema.parse(req.body);
      const settings = await storage.getUserSettings(req.user!.id);
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" });
      }

      const updatedEvent = await updateCalendarEventCompletion(
        req.user!.id,
        id,
        settings,
        data.completed
      );

      if (!updatedEvent) {
        return res.status(404).json({ error: "Task not found" });
      }

      const task = mapCalendarEventToTask(updatedEvent);
      if (!task) {
        return res.status(500).json({ error: "Failed to map updated task" });
      }

      res.json(task);
    } catch (error) {
      console.error("Error updating task:", error);
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  app.post("/api/tasks/reorder", requireAuth, async (req, res) => {
    try {
      const { taskIds } = req.body;
      
      if (!Array.isArray(taskIds)) {
        return res.status(400).json({ error: "taskIds must be an array" });
      }

      const settings = await storage.getUserSettings(req.user!.id);

      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" });
      }

      const calendarEvents = await getCalendarEventsForTasks(
        req.user!.id,
        settings.calendarId,
        taskIds
      );

      const eventDataList = taskIds
        .map((id) => calendarEvents.get(id))
        .filter(
          (eventData): eventData is CalendarEventData =>
            Boolean(eventData && eventData !== EVENT_DELETED && eventData.start && eventData.end)
        );

      if (eventDataList.length === 0) {
        return res.status(404).json({ error: "No tasks found to reorder" });
      }

      const existingSlots = eventDataList
        .map((eventData) => ({
          start: eventData.start,
          end: eventData.end,
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());

      const orderedEvents = taskIds
        .map((id) => ({ id, data: calendarEvents.get(id) }))
        .filter(
          (entry): entry is { id: string; data: CalendarEventData } =>
            Boolean(entry.data && entry.data !== EVENT_DELETED && entry.data.start && entry.data.end)
        );

      for (let i = 0; i < Math.min(orderedEvents.length, existingSlots.length); i++) {
        const eventEntry = orderedEvents[i];
        const slot = existingSlots[i];
        const eventData = eventEntry.data;

        const currentStart = eventData.start.getTime();
        if (currentStart === slot.start.getTime()) {
          continue;
        }

        const durationMinutes =
          eventData.durationMinutes ||
          Math.round((eventData.end.getTime() - eventData.start.getTime()) / 60000) ||
          settings.defaultDuration;
        const adjustedEnd = new Date(slot.start.getTime() + durationMinutes * 60 * 1000);

        await updateCalendarEventTime(
          req.user!.id,
          eventEntry.id,
          settings,
          { start: slot.start, end: adjustedEnd }
        );
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error reordering tasks:", error);
      res.status(500).json({ error: "Failed to reorder tasks" });
    }
  });

  app.post("/api/tasks/bulk-complete", requireAuth, async (req, res) => {
    try {
      const { taskIds } = req.body;
      
      if (!Array.isArray(taskIds)) {
        return res.status(400).json({ error: "taskIds must be an array" });
      }

      const settings = await storage.getUserSettings(req.user!.id);

      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" });
      }

      for (const taskId of taskIds) {
        await updateCalendarEventCompletion(req.user!.id, taskId, settings, true);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error bulk completing tasks:", error);
      res.status(500).json({ error: "Failed to complete tasks" });
    }
  });

  app.post("/api/tasks/reschedule-all", requireAuth, async (req, res) => {
    try {
      await rescheduleAllUserTasks(req.user!.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error rescheduling all tasks:", error);
      res.status(500).json({ error: "Failed to reschedule tasks" });
    }
  });

  // Reload calendar data - fetch latest event times from Google Calendar
  app.post("/api/tasks/reload", requireAuth, async (req, res) => {
    try {
      const settings = await storage.getUserSettings(req.user!.id);
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error reloading calendar data:", error);
      res.status(500).json({ error: "Failed to reload calendar data" });
    }
  });

  app.post("/api/tasks/:id/complete", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const settings = await storage.getUserSettings(req.user!.id);
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" });
      }

      const updatedEvent = await updateCalendarEventCompletion(req.user!.id, id, settings, true);
      if (!updatedEvent) {
        return res.status(404).json({ error: "Task not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error completing task:", error);
      res.status(500).json({ error: "Failed to complete task" });
    }
  });

  app.post("/api/tasks/:id/reschedule", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const settings = await storage.getUserSettings(req.user!.id);
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" });
      }

      const event = await getCalendarEvent(req.user!.id, id, settings.calendarId);
      if (!event || !event.start?.dateTime || !event.end?.dateTime) {
        return res.status(404).json({ error: "Task not found" });
      }

      const start = new Date(event.start.dateTime);
      const end = new Date(event.end.dateTime);
      const durationMinutes = Math.max(
        1,
        Math.round((end.getTime() - start.getTime()) / 60000)
      );
      const slot = await findFreeSlot(req.user!.id, settings, durationMinutes);

      if (!slot) {
        return res.status(409).json({ error: "No free time slots available in the next 90 days." });
      }

      await updateCalendarEventTime(req.user!.id, id, settings, slot);

      res.json({ success: true });
    } catch (error) {
      console.error("Error rescheduling task:", error);
      res.status(500).json({ error: "Failed to reschedule task" });
    }
  });

  app.get("/api/action/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const payload = verifyActionToken(token);
      
      if (!payload) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Invalid Link</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>Invalid or Expired Link</h1>
            <p>This action link is no longer valid. Please use the app to manage your tasks.</p>
            <a href="/">Go to CalTodo</a>
          </body>
          </html>
        `);
      }

      const settings = await storage.getUserSettings(payload.userId);
      if (!settings?.calendarId) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
          <head><title>No Calendar</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>No Calendar Configured</h1>
            <p>Please configure a calendar in settings first.</p>
            <a href="/settings">Go to Settings</a>
          </body>
          </html>
        `);
      }

      const event = await getCalendarEvent(payload.userId, payload.eventId, settings.calendarId);
      if (!event) {
        return res.status(404).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Task Not Found</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>Task Not Found</h1>
            <p>This task may have been deleted.</p>
            <a href="/">Go to CalTodo</a>
          </body>
          </html>
        `);
      }
      const safeTitle = escapeHtml(stripEventTitlePrefix(event.summary || "Task"));

      if (payload.action === "complete") {
        const updatedEvent = await updateCalendarEventCompletion(
          payload.userId,
          payload.eventId,
          settings,
          true
        );
        if (!updatedEvent) {
          return res.status(404).send(`
            <!DOCTYPE html>
            <html>
            <head><title>Task Not Found</title></head>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1>Task Not Found</h1>
              <p>This task may have been deleted.</p>
              <a href="/">Go to CalTodo</a>
            </body>
            </html>
          `);
        }

        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Task Completed</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>Task Completed!</h1>
            <p>"${safeTitle}" has been marked as done.</p>
            <a href="/">Go to CalTodo</a>
          </body>
          </html>
        `);
      }

      if (payload.action === "reschedule") {
        if (!event.start?.dateTime || !event.end?.dateTime) {
          return res.status(400).send(`
            <!DOCTYPE html>
            <html>
            <head><title>Invalid Event</title></head>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1>Invalid Event</h1>
              <p>This event does not have a valid time range.</p>
              <a href="/">Go to CalTodo</a>
            </body>
            </html>
          `);
        }

        const start = new Date(event.start.dateTime);
        const end = new Date(event.end.dateTime);
        const durationMinutes = Math.max(
          1,
          Math.round((end.getTime() - start.getTime()) / 60000)
        );
        const slot = await findFreeSlot(payload.userId, settings, durationMinutes);

        if (!slot) {
          return res.status(409).send(`
            <!DOCTYPE html>
            <html>
            <head><title>No Free Slots</title></head>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1>No Free Time Slots</h1>
              <p>No free time slots are available in the next 90 days.</p>
              <a href="/">Go to CalTodo</a>
            </body>
            </html>
          `);
        }

        await updateCalendarEventTime(payload.userId, payload.eventId, settings, slot);

        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Task Rescheduled</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>Task Rescheduled!</h1>
            <p>"${safeTitle}" has been moved to the next available time slot.</p>
            <a href="/">Go to CalTodo</a>
          </body>
          </html>
        `);
      }

      res.status(400).send("Invalid action");
    } catch (error) {
      console.error("Error processing action:", error);
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>Something went wrong</h1>
          <p>Please try again or use the app to manage your tasks.</p>
          <a href="/">Go to CalTodo</a>
        </body>
        </html>
      `);
    }
  });

  return httpServer;
}
