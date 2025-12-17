import type { Express } from "express";
import { createServer, type Server } from "http";
import passport from "passport";
import { storage } from "./storage";
import { setupAuth, requireAuth } from "./auth";
import { 
  listCalendars, 
  findFreeSlot, 
  createCalendarEvent, 
  updateCalendarEvent,
  deleteCalendarEvent,
  rescheduleAllUserTasks,
  updateCalendarEventContent,
  getCalendarEventsForTasks,
  getCalendarEvent,
  EVENT_DELETED,
  stripEventTitlePrefix,
  type CalendarEventData
} from "./calendar";
import { setupCronJobs } from "./cron";
import { createTaskSchema, updateSettingsSchema, updateTaskSchema, type Task } from "@shared/schema";
import { verifyActionToken } from "./tokens";
import { z } from "zod";
import { ensureCsrfToken, requireCsrfToken } from "./csrf";

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

const patchTaskSchema = updateTaskSchema.extend({
  completed: z.boolean().optional(),
});

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
      const tasks = await storage.getTasksByUserId(req.user!.id);
      const settings = await storage.getUserSettings(req.user!.id);
      
      // Get event IDs for tasks that have calendar events
      const eventIds = tasks
        .filter(t => t.calendarEventId && !t.completed)
        .map(t => t.calendarEventId as string);
      
      // Fetch live event data from Google Calendar
      const calendarEvents = settings?.calendarId && eventIds.length > 0
        ? await getCalendarEventsForTasks(req.user!.id, settings.calendarId, eventIds)
        : new Map<string, CalendarEventData | typeof EVENT_DELETED | undefined>();
      
      // Track which task IDs had their events deleted - mark them as completed
      const completedByDeletionIds = new Set<string>();
      // Track title updates from calendar
      const titleUpdates = new Map<string, string>();
      
      // Sync tasks with calendar events
      for (const task of tasks) {
        if (task.calendarEventId) {
          const eventData = calendarEvents.get(task.calendarEventId);
          
          // Mark as completed if calendar event was deleted
          if (eventData === EVENT_DELETED) {
            console.log(`Marking task ${task.id} as completed because its calendar event was deleted`);
            await storage.updateTask(task.id, {
              completed: true,
              completedAt: new Date(),
              calendarEventId: null,
              scheduledStart: null,
              scheduledEnd: null,
            });
            completedByDeletionIds.add(task.id);
          } 
          // Update title if it was changed in calendar
          else if (eventData && eventData.summary) {
            const calendarTitle = stripEventTitlePrefix(eventData.summary);
            if (calendarTitle !== task.title) {
              console.log(`Updating task ${task.id} title from calendar: "${task.title}" -> "${calendarTitle}"`);
              await storage.updateTask(task.id, { title: calendarTitle });
              titleUpdates.set(task.id, calendarTitle);
            }
          }
        }
      }
      
      // Enrich tasks with live calendar data
      const enrichedTasks = tasks.map(task => {
        // If event was deleted, return task as completed
        if (completedByDeletionIds.has(task.id)) {
          return {
            ...task,
            completed: true,
            completedAt: new Date(),
            calendarEventId: null,
            scheduledStart: null,
            scheduledEnd: null,
          };
        }
        
        // Apply title update if changed in calendar
        const updatedTitle = titleUpdates.get(task.id);
        
        // Enrich with live calendar data if available
        if (task.calendarEventId && !task.completed) {
          const eventData = calendarEvents.get(task.calendarEventId);
          if (eventData && eventData !== EVENT_DELETED) {
            return {
              ...task,
              title: updatedTitle || task.title,
              scheduledStart: eventData.start,
              scheduledEnd: eventData.end,
            };
          }
        }
        return updatedTitle ? { ...task, title: updatedTitle } : task;
      });
      
      // Reorder priorities for uncompleted tasks based on calendar event order
      const uncompletedWithTimes = enrichedTasks
        .filter(t => !t.completed && t.scheduledStart)
        .sort((a, b) => new Date(a.scheduledStart!).getTime() - new Date(b.scheduledStart!).getTime());
      
      const uncompletedWithoutTimes = enrichedTasks
        .filter(t => !t.completed && !t.scheduledStart)
        .sort((a, b) => a.priority - b.priority);
      
      const completedTasks = enrichedTasks.filter(t => t.completed);
      
      // Update priorities based on calendar order (tasks with times first, sorted by time)
      let newPriority = 0;
      const priorityUpdates: { id: string; newPriority: number; currentPriority: number }[] = [];
      
      for (const task of uncompletedWithTimes) {
        if (task.priority !== newPriority) {
          priorityUpdates.push({ id: task.id, newPriority, currentPriority: task.priority });
        }
        newPriority++;
      }
      
      for (const task of uncompletedWithoutTimes) {
        if (task.priority !== newPriority) {
          priorityUpdates.push({ id: task.id, newPriority, currentPriority: task.priority });
        }
        newPriority++;
      }
      
      // Apply priority updates to database (in background, don't block response)
      if (priorityUpdates.length > 0) {
        Promise.all(
          priorityUpdates.map(update => 
            storage.updateTask(update.id, { priority: update.newPriority })
          )
        ).catch(err => console.error("Error updating priorities:", err));
      }
      
      // Return tasks sorted by new priority order
      const finalTasks = [
        ...uncompletedWithTimes.map((t, i) => ({ ...t, priority: i })),
        ...uncompletedWithoutTimes.map((t, i) => ({ ...t, priority: uncompletedWithTimes.length + i })),
        ...completedTasks,
      ];
      
      res.json(finalTasks);
    } catch (error) {
      console.error("Error fetching tasks:", error);
      res.status(500).json({ error: "Failed to get tasks" });
    }
  });

  app.post("/api/tasks", requireAuth, async (req, res) => {
    try {
      const data = createTaskSchema.parse(req.body);
      const settings = await storage.getUserSettings(req.user!.id);
      
      const existingTasks = await storage.getUncompletedTasksByUser(req.user!.id);
      let priority = existingTasks.length;
      
      if (data.urgent) {
        for (const task of existingTasks) {
          await storage.updateTask(task.id, { priority: task.priority + 1 });
        }
        priority = 0;
      }

      let task = await storage.createTask({
        userId: req.user!.id,
        title: data.title,
        details: data.details || null,
        duration: data.duration || null,
        reminderMinutes: data.reminderMinutes ?? null,
        urgent: data.urgent,
        priority,
        completed: false,
      });

      if (settings?.calendarId) {
        const taskDuration = task.duration || settings.defaultDuration;
        const slot = await findFreeSlot(req.user!.id, settings, taskDuration);
        
        if (slot) {
          const eventId = await createCalendarEvent(
            req.user!.id,
            task,
            settings,
            slot,
            getBaseUrl(req)
          );

          task = (await storage.updateTask(task.id, {
            calendarEventId: eventId,
            scheduledStart: slot.start,
            scheduledEnd: slot.end,
          }))!;
        }

        if (data.urgent) {
          await rescheduleAllUserTasks(req.user!.id, getBaseUrl(req));
        }
      }

      res.json(task);
    } catch (error) {
      console.error("Error creating task:", error);
      res.status(400).json({ error: "Failed to create task" });
    }
  });

  app.put("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const data = updateTaskSchema.parse(req.body);
      const task = await storage.getTask(id);
      
      if (!task || task.userId !== req.user!.id) {
        return res.status(404).json({ error: "Task not found" });
      }

      const durationChanged = data.duration !== undefined && data.duration !== task.duration;
      const reminderChanged = data.reminderMinutes !== undefined && data.reminderMinutes !== task.reminderMinutes;
      
      const updatedTask = await storage.updateTask(id, {
        title: data.title || task.title,
        details: data.details !== undefined ? data.details : task.details,
        duration: data.duration !== undefined ? data.duration : task.duration,
        reminderMinutes: data.reminderMinutes !== undefined ? data.reminderMinutes : task.reminderMinutes,
      });

      const settings = await storage.getUserSettings(req.user!.id);
      
      if (task.calendarEventId && settings?.calendarId && updatedTask) {
        if (durationChanged) {
          await rescheduleAllUserTasks(req.user!.id, getBaseUrl(req));
        } else if (reminderChanged && task.scheduledStart && task.scheduledEnd) {
          await updateCalendarEvent(
            req.user!.id,
            task.calendarEventId,
            settings,
            { start: task.scheduledStart, end: task.scheduledEnd },
            updatedTask,
            getBaseUrl(req)
          );
        } else {
          await updateCalendarEventContent(
            req.user!.id,
            task.calendarEventId,
            settings,
            updatedTask,
            getBaseUrl(req)
          );
        }
      }

      res.json(updatedTask);
    } catch (error) {
      console.error("Error updating task:", error);
      res.status(400).json({ error: "Failed to update task" });
    }
  });

  app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const task = await storage.getTask(id);
      
      if (!task || task.userId !== req.user!.id) {
        return res.status(404).json({ error: "Task not found" });
      }

      const data = patchTaskSchema.parse(req.body);
      const settings = await storage.getUserSettings(req.user!.id);

      if (data.completed === true && !task.completed) {
        if (task.calendarEventId && settings?.calendarId) {
          await deleteCalendarEvent(req.user!.id, task.calendarEventId, settings.calendarId);
        }

        const updatedTask = await storage.updateTask(id, {
          completed: true,
          completedAt: new Date(),
          calendarEventId: null,
          scheduledStart: null,
          scheduledEnd: null,
        });

        return res.json(updatedTask);
      }

      if (data.completed === false && task.completed) {
        const existingTasks = await storage.getUncompletedTasksByUser(req.user!.id);
        const priority = existingTasks.length;

        let updatedTask = await storage.updateTask(id, {
          completed: false,
          completedAt: null,
          priority,
        });

        if (settings?.calendarId) {
          const slot = await findFreeSlot(req.user!.id, settings, settings.defaultDuration);
          
          if (slot) {
            const eventId = await createCalendarEvent(
              req.user!.id,
              updatedTask!,
              settings,
              slot,
              getBaseUrl(req)
            );

            updatedTask = await storage.updateTask(id, {
              calendarEventId: eventId,
              scheduledStart: slot.start,
              scheduledEnd: slot.end,
            });
          }
        }

        return res.json(updatedTask);
      }

      if (
        data.title === undefined &&
        data.details === undefined &&
        data.duration === undefined &&
        data.reminderMinutes === undefined
      ) {
        return res.json(task);
      }

      const durationChanged = data.duration !== undefined && data.duration !== task.duration;
      const reminderChanged =
        data.reminderMinutes !== undefined && data.reminderMinutes !== task.reminderMinutes;

      const updatedTask = await storage.updateTask(id, {
        title: data.title ?? task.title,
        details: data.details !== undefined ? data.details : task.details,
        duration: data.duration !== undefined ? data.duration : task.duration,
        reminderMinutes:
          data.reminderMinutes !== undefined ? data.reminderMinutes : task.reminderMinutes,
      });

      if (task.calendarEventId && settings?.calendarId && updatedTask) {
        if (durationChanged) {
          await rescheduleAllUserTasks(req.user!.id, getBaseUrl(req));
        } else if (reminderChanged && task.scheduledStart && task.scheduledEnd) {
          await updateCalendarEvent(
            req.user!.id,
            task.calendarEventId,
            settings,
            { start: task.scheduledStart, end: task.scheduledEnd },
            updatedTask,
            getBaseUrl(req),
          );
        } else {
          await updateCalendarEventContent(
            req.user!.id,
            task.calendarEventId,
            settings,
            updatedTask,
            getBaseUrl(req),
          );
        }
      }

      res.json(updatedTask);
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
      
      // Get all tasks being reordered
      const tasks = await Promise.all(taskIds.map(id => storage.getTask(id)));
      const validTasks = tasks.filter(t => t && t.userId === req.user!.id) as Task[];
      
      // Collect existing time slots (sorted by start time)
      const existingSlots = validTasks
        .filter(t => t.scheduledStart && t.scheduledEnd && t.calendarEventId)
        .map(t => ({
          start: new Date(t.scheduledStart!),
          end: new Date(t.scheduledEnd!),
          duration: new Date(t.scheduledEnd!).getTime() - new Date(t.scheduledStart!).getTime(),
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      
      // Update priorities first
      for (let i = 0; i < taskIds.length; i++) {
        await storage.updateTask(taskIds[i], { priority: i });
      }
      
      // Reassign slots to tasks in new priority order
      // Tasks are now in priority order (taskIds array), slots are in time order
      if (settings?.calendarId && existingSlots.length > 0) {
        const tasksNeedingSlots = validTasks
          .filter(t => t.calendarEventId && t.scheduledStart)
          .sort((a, b) => taskIds.indexOf(a.id) - taskIds.indexOf(b.id));
        
        for (let i = 0; i < Math.min(tasksNeedingSlots.length, existingSlots.length); i++) {
          const task = tasksNeedingSlots[i];
          const slot = existingSlots[i];
          
          // Check if this task already has this slot
          const currentStart = new Date(task.scheduledStart!).getTime();
          if (currentStart === slot.start.getTime()) {
            continue; // No change needed
          }
          
          // Adjust slot end time based on task's duration preference
          const taskDuration = task.duration || settings.defaultDuration;
          const adjustedEnd = new Date(slot.start.getTime() + taskDuration * 60 * 1000);
          
          // Update calendar event with new time
          await updateCalendarEvent(
            req.user!.id,
            task.calendarEventId!,
            settings,
            { start: slot.start, end: adjustedEnd },
            task,
            getBaseUrl(req)
          );
          
          // Update task in database
          await storage.updateTask(task.id, {
            scheduledStart: slot.start,
            scheduledEnd: adjustedEnd,
          });
        }
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

      for (const taskId of taskIds) {
        const task = await storage.getTask(taskId);
        if (!task || task.userId !== req.user!.id) continue;

        if (task.calendarEventId && settings?.calendarId) {
          await deleteCalendarEvent(req.user!.id, task.calendarEventId, settings.calendarId);
        }

        await storage.updateTask(taskId, {
          completed: true,
          completedAt: new Date(),
          calendarEventId: null,
          scheduledStart: null,
          scheduledEnd: null,
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error bulk completing tasks:", error);
      res.status(500).json({ error: "Failed to complete tasks" });
    }
  });

  app.post("/api/tasks/reschedule-all", requireAuth, async (req, res) => {
    try {
      await rescheduleAllUserTasks(req.user!.id, getBaseUrl(req));
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

      const tasks = await storage.getTasksByUserId(req.user!.id);
      const incompleteTasks = tasks.filter((t) => !t.completed && t.calendarEventId);

      for (const task of incompleteTasks) {
        const event = await getCalendarEvent(req.user!.id, task.calendarEventId!, settings.calendarId);
        if (event) {
          await storage.updateTask(task.id, {
            scheduledStart: event.start,
            scheduledEnd: event.end,
          });
        } else {
          // Event was deleted externally - mark task as completed
          console.log(`Marking task ${task.id} as completed because calendar event was deleted`);
          await storage.updateTask(task.id, {
            completed: true,
            completedAt: new Date(),
            calendarEventId: null,
            scheduledStart: null,
            scheduledEnd: null,
          });
        }
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error reloading calendar data:", error);
      res.status(500).json({ error: "Failed to reload calendar data" });
    }
  });

  app.delete("/api/tasks/completed", requireAuth, async (req, res) => {
    try {
      const tasks = await storage.getTasksByUserId(req.user!.id);
      const completedTasks = tasks.filter((t) => t.completed);

      for (const task of completedTasks) {
        await storage.deleteTask(task.id);
      }

      res.json({ success: true, deleted: completedTasks.length });
    } catch (error) {
      console.error("Error deleting completed tasks:", error);
      res.status(500).json({ error: "Failed to delete completed tasks" });
    }
  });

  app.post("/api/tasks/:id/complete", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const task = await storage.getTask(id);
      
      if (!task || task.userId !== req.user!.id) {
        return res.status(404).json({ error: "Task not found" });
      }

      const settings = await storage.getUserSettings(req.user!.id);

      if (task.calendarEventId && settings?.calendarId) {
        await deleteCalendarEvent(req.user!.id, task.calendarEventId, settings.calendarId);
      }

      await storage.updateTask(id, {
        completed: true,
        completedAt: new Date(),
        calendarEventId: null,
        scheduledStart: null,
        scheduledEnd: null,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error completing task:", error);
      res.status(500).json({ error: "Failed to complete task" });
    }
  });

  app.post("/api/tasks/:id/reschedule", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const task = await storage.getTask(id);
      
      if (!task || task.userId !== req.user!.id) {
        return res.status(404).json({ error: "Task not found" });
      }

      const settings = await storage.getUserSettings(req.user!.id);
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" });
      }

      if (task.calendarEventId) {
        await deleteCalendarEvent(req.user!.id, task.calendarEventId, settings.calendarId);
      }

      const slot = await findFreeSlot(req.user!.id, settings, settings.defaultDuration);
      
      if (slot) {
        const eventId = await createCalendarEvent(
          req.user!.id,
          task,
          settings,
          slot,
          getBaseUrl(req)
        );

        await storage.updateTask(id, {
          calendarEventId: eventId,
          scheduledStart: slot.start,
          scheduledEnd: slot.end,
        });
      }

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

      const task = await storage.getTask(payload.taskId);
      if (!task) {
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

      const settings = await storage.getUserSettings(task.userId);
      const safeTitle = escapeHtml(task.title);

      if (payload.action === "complete") {
        if (task.calendarEventId && settings?.calendarId) {
          await deleteCalendarEvent(task.userId, task.calendarEventId, settings.calendarId);
        }

        await storage.updateTask(task.id, {
          completed: true,
          completedAt: new Date(),
          calendarEventId: null,
          scheduledStart: null,
          scheduledEnd: null,
        });

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

        if (task.calendarEventId) {
          await deleteCalendarEvent(task.userId, task.calendarEventId, settings.calendarId);
        }

        const taskDuration = task.duration || settings.defaultDuration;
        const slot = await findFreeSlot(task.userId, settings, taskDuration);
        
        if (slot) {
          const eventId = await createCalendarEvent(
            task.userId,
            task,
            settings,
            slot,
            getBaseUrl(req)
          );

          await storage.updateTask(task.id, {
            calendarEventId: eventId,
            scheduledStart: slot.start,
            scheduledEnd: slot.end,
          });
        }

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
