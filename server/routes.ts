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
  updateCalendarEventContent
} from "./calendar";
import { setupCronJobs } from "./cron";
import { createTaskSchema, updateSettingsSchema, updateTaskSchema } from "@shared/schema";
import { verifyActionToken } from "./tokens";

function getBaseUrl(req: any): string {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupAuth(app);

  const baseUrl = process.env.REPL_SLUG
    ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER?.toLowerCase()}.repl.co`
    : "http://localhost:5000";
  
  setupCronJobs(baseUrl);

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
    res.json(req.user);
  });

  app.post("/api/auth/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ success: true });
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
      res.json(tasks);
    } catch (error) {
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

      const { completed } = req.body;
      const settings = await storage.getUserSettings(req.user!.id);

      if (completed === true && !task.completed) {
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

      if (completed === false && task.completed) {
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

      const updatedTask = await storage.updateTask(id, req.body);
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

      for (let i = 0; i < taskIds.length; i++) {
        await storage.updateTask(taskIds[i], { priority: i });
      }

      await rescheduleAllUserTasks(req.user!.id, getBaseUrl(req));

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
            <p>"${task.title}" has been marked as done.</p>
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
            <p>"${task.title}" has been moved to the next available time slot.</p>
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
