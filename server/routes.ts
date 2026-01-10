import type { Express, Response } from "express"
import { createServer, type Server } from "http"
import passport from "passport"
import { storage } from "./storage"
import { setupAuth, requireAuth } from "./auth"
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
  refreshCalendarEventActions,
  EVENT_DELETED,
  type CalendarEventData,
} from "./calendar"
import { setupCronJobs } from "./cron"
import { createTaskSchema, updateSettingsSchema } from "@shared/schema"
import { getActionToken } from "./tokens"
import { z } from "zod"
import { ensureCsrfToken, requireCsrfToken } from "./csrf"
import type { CalendarTask } from "@shared/types"

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function renderActionShell(title: string, body: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${escapeHtml(title)}</title>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 32px; }
        .card { max-width: 520px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08); }
        h1 { font-size: 20px; margin: 0 0 12px; }
        p { margin: 0 0 16px; color: #334155; }
        .actions { display: flex; gap: 12px; flex-wrap: wrap; }
        .actions form { margin: 0; }
        button, .button-link { background: #2563eb; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-size: 14px; cursor: pointer; text-decoration: none; display: inline-block; }
        button.secondary { background: #0f172a; }
        button:disabled { background: #94a3b8; cursor: not-allowed; }
        .status { margin-top: 16px; font-size: 14px; color: #475569; }
        .muted { color: #64748b; font-size: 13px; }
      </style>
    </head>
    <body>
      <div class="card">
        ${body}
      </div>
    </body>
    </html>
  `
}

function getBaseUrl(req: any): string {
  const normalize = (url: string | undefined): string | null => {
    if (!url) return null
    try {
      return new URL(url).origin
    } catch {
      return null
    }
  }

  const configuredOrigin =
    normalize(process.env.PRODUCTION_APP_URL) ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
  if (configuredOrigin) {
    return configuredOrigin
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PRODUCTION_APP_URL must be set in production to build trusted action links",
    )
  }

  return "http://localhost:5000"
}

const patchTaskSchema = z.object({
  completed: z.boolean(),
})

const actionRequestSchema = z.object({
  action: z.enum(["complete", "reschedule"]),
})

const isProduction =
  process.env.NODE_ENV === "production" || !!process.env.PRODUCTION_APP_URL

function clearSessionCookie(res: Response): void {
  res.clearCookie("connect.sid", {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: isProduction,
  })
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  setupAuth(app)
  app.use(ensureCsrfToken)
  app.use(requireCsrfToken)

  const cronBaseUrl =
    process.env.PRODUCTION_APP_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://localhost:5000")

  setupCronJobs(cronBaseUrl)

  // Log the callback URL being used for debugging
  console.log(
    "OAuth callback URL:",
    process.env.PRODUCTION_APP_URL
      ? `${process.env.PRODUCTION_APP_URL}/api/auth/google/callback`
      : process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/auth/google/callback`
        : "http://localhost:5000/api/auth/google/callback",
  )

  app.get("/api/auth/google", (req, res, next) => {
    const actionToken =
      typeof req.query.actionToken === "string" ? req.query.actionToken : null
    if (actionToken && req.session) {
      req.session.pendingActionToken = actionToken
    }

    return passport.authenticate("google", {
      scope: [
        "profile",
        "email",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      accessType: "offline",
      prompt: "consent",
    })(req, res, next)
  })

  app.get(
    "/api/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/" }),
    (req, res) => {
      const pendingActionToken = req.session?.pendingActionToken
      if (pendingActionToken) {
        delete req.session.pendingActionToken
        return res.redirect(`/action/${encodeURIComponent(pendingActionToken)}`)
      }
      res.redirect("/")
    },
  )

  app.get("/api/auth/user", (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" })
    }
    const { id, googleId, email, displayName } = req.user
    res.json({ id, googleId, email, displayName, csrfToken: req.session?.csrfToken })
  })

  app.post("/api/auth/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" })
      }
      if (req.session) {
        req.session.destroy(() => {
          clearSessionCookie(res)
          res.json({ success: true })
        })
      } else {
        clearSessionCookie(res)
        res.json({ success: true })
      }
    })
  })

  app.get("/api/settings", requireAuth, async (req, res) => {
    try {
      const settings = await storage.getUserSettings(req.user!.id)
      res.json(settings || null)
    } catch (error) {
      res.status(500).json({ error: "Failed to get settings" })
    }
  })

  app.patch("/api/settings", requireAuth, async (req, res) => {
    try {
      const data = updateSettingsSchema.parse(req.body)
      let settings = await storage.getUserSettings(req.user!.id)

      if (settings) {
        settings = await storage.updateUserSettings(req.user!.id, data)
      } else {
        settings = await storage.createUserSettings({
          userId: req.user!.id,
          ...data,
        })
      }

      res.json(settings)
    } catch (error) {
      console.error("Error updating settings:", error)
      res.status(400).json({ error: "Invalid settings data" })
    }
  })

  app.get("/api/calendars", requireAuth, async (req, res) => {
    try {
      console.log("Fetching calendars for user:", req.user!.id)
      const calendars = await listCalendars(req.user!.id)
      console.log("Calendars found:", calendars.length)
      res.json(calendars)
    } catch (error) {
      console.error("Error fetching calendars:", error)
      res.status(500).json({ error: "Failed to list calendars" })
    }
  })

  app.get("/api/tasks", requireAuth, async (req, res) => {
    try {
      const settings = await storage.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.json([])
      }

      const calendar = await getCalendarClient(req.user!.id)
      if (!calendar) {
        return res.status(500).json({ error: "Failed to access calendar" })
      }

      const now = new Date()
      const timeMin = new Date(now)
      timeMin.setDate(timeMin.getDate() - 14)
      const timeMax = new Date(now)
      timeMax.setDate(timeMax.getDate() + 90)

      const events = await listCalendarEventsInRange(
        calendar,
        settings.calendarId,
        timeMin,
        timeMax,
      )
      const tasks = events
        .map(mapCalendarEventToTask)
        .filter((task): task is CalendarTask => Boolean(task))

      const uncompletedTasks = tasks
        .filter((task) => !task.completed)
        .sort(
          (a, b) =>
            new Date(a.scheduledStart || 0).getTime() -
            new Date(b.scheduledStart || 0).getTime(),
        )
        .map((task, index) => ({ ...task, priority: index }))

      const completedTasks = tasks
        .filter((task) => task.completed)
        .sort((a, b) => {
          const dateA = new Date(a.completedAt || a.scheduledEnd || 0).getTime()
          const dateB = new Date(b.completedAt || b.scheduledEnd || 0).getTime()
          return dateB - dateA
        })

      res.json([...uncompletedTasks, ...completedTasks])
    } catch (error) {
      console.error("Error fetching tasks:", error)
      res.status(500).json({ error: "Failed to get tasks" })
    }
  })

  app.post("/api/tasks", requireAuth, async (req, res) => {
    try {
      const data = createTaskSchema.parse(req.body)
      const settings = await storage.getUserSettings(req.user!.id)

      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const taskDuration = data.duration || settings.defaultDuration
      const slot = await findFreeSlot(req.user!.id, settings, taskDuration)

      if (!slot) {
        return res
          .status(409)
          .json({ error: "No free time slots available in the next 90 days." })
      }

      const eventId = await createCalendarEvent(
        req.user!.id,
        {
          title: data.title,
          details: data.details || null,
        },
        settings,
        slot,
        getBaseUrl(req),
      )

      if (!eventId) {
        return res.status(500).json({ error: "Failed to create calendar event" })
      }

      if (data.urgent) {
        await rescheduleAllUserTasks(req.user!.id, [eventId])
      }

      const createdEvent = await getCalendarEvent(
        req.user!.id,
        eventId,
        settings.calendarId,
      )
      if (!createdEvent) {
        return res.status(500).json({ error: "Failed to load created event" })
      }

      const task = mapCalendarEventToTask(createdEvent)
      if (!task) {
        return res.status(500).json({ error: "Failed to map created event" })
      }

      res.json(task)
    } catch (error) {
      console.error("Error creating task:", error)
      res.status(400).json({ error: "Failed to create task" })
    }
  })

  app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params
      const data = patchTaskSchema.parse(req.body)
      const settings = await storage.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const updatedEvent = await updateCalendarEventCompletion(
        req.user!.id,
        id,
        settings,
        data.completed,
      )

      if (!updatedEvent) {
        return res.status(404).json({ error: "Task not found" })
      }

      const task = mapCalendarEventToTask(updatedEvent)
      if (!task) {
        return res.status(500).json({ error: "Failed to map updated task" })
      }

      res.json(task)
    } catch (error) {
      console.error("Error updating task:", error)
      res.status(500).json({ error: "Failed to update task" })
    }
  })

  app.post("/api/tasks/reorder", requireAuth, async (req, res) => {
    try {
      const { taskIds } = req.body

      if (!Array.isArray(taskIds)) {
        return res.status(400).json({ error: "taskIds must be an array" })
      }

      const settings = await storage.getUserSettings(req.user!.id)

      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const calendarEvents = await getCalendarEventsForTasks(
        req.user!.id,
        settings.calendarId,
        taskIds,
      )

      const eventDataList = taskIds
        .map((id) => calendarEvents.get(id))
        .filter((eventData): eventData is CalendarEventData =>
          Boolean(
            eventData && eventData !== EVENT_DELETED && eventData.start && eventData.end,
          ),
        )

      if (eventDataList.length === 0) {
        return res.status(404).json({ error: "No tasks found to reorder" })
      }

      const existingSlots = eventDataList
        .map((eventData) => ({
          start: eventData.start,
          end: eventData.end,
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime())

      const orderedEvents = taskIds
        .map((id) => ({ id, data: calendarEvents.get(id) }))
        .filter((entry): entry is { id: string; data: CalendarEventData } =>
          Boolean(
            entry.data &&
            entry.data !== EVENT_DELETED &&
            entry.data.start &&
            entry.data.end,
          ),
        )

      for (let i = 0; i < Math.min(orderedEvents.length, existingSlots.length); i++) {
        const eventEntry = orderedEvents[i]
        const slot = existingSlots[i]
        const eventData = eventEntry.data

        const currentStart = eventData.start.getTime()
        if (currentStart === slot.start.getTime()) {
          continue
        }

        const durationMinutes =
          eventData.durationMinutes ||
          Math.round((eventData.end.getTime() - eventData.start.getTime()) / 60000) ||
          settings.defaultDuration
        const adjustedEnd = new Date(slot.start.getTime() + durationMinutes * 60 * 1000)

        await updateCalendarEventTime(req.user!.id, eventEntry.id, settings, {
          start: slot.start,
          end: adjustedEnd,
        })
      }

      res.json({ success: true })
    } catch (error) {
      console.error("Error reordering tasks:", error)
      res.status(500).json({ error: "Failed to reorder tasks" })
    }
  })

  app.post("/api/tasks/bulk-complete", requireAuth, async (req, res) => {
    try {
      const { taskIds } = req.body

      if (!Array.isArray(taskIds)) {
        return res.status(400).json({ error: "taskIds must be an array" })
      }

      const settings = await storage.getUserSettings(req.user!.id)

      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      for (const taskId of taskIds) {
        await updateCalendarEventCompletion(req.user!.id, taskId, settings, true)
      }

      res.json({ success: true })
    } catch (error) {
      console.error("Error bulk completing tasks:", error)
      res.status(500).json({ error: "Failed to complete tasks" })
    }
  })

  app.post("/api/tasks/reschedule-all", requireAuth, async (req, res) => {
    try {
      await rescheduleAllUserTasks(req.user!.id)
      res.json({ success: true })
    } catch (error) {
      console.error("Error rescheduling all tasks:", error)
      res.status(500).json({ error: "Failed to reschedule tasks" })
    }
  })

  // Reload calendar data - fetch latest event times from Google Calendar
  app.post("/api/tasks/reload", requireAuth, async (req, res) => {
    try {
      const settings = await storage.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      res.json({ success: true })
    } catch (error) {
      console.error("Error reloading calendar data:", error)
      res.status(500).json({ error: "Failed to reload calendar data" })
    }
  })

  app.post("/api/tasks/:id/complete", requireAuth, async (req, res) => {
    try {
      const { id } = req.params
      const settings = await storage.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const updatedEvent = await updateCalendarEventCompletion(
        req.user!.id,
        id,
        settings,
        true,
      )
      if (!updatedEvent) {
        return res.status(404).json({ error: "Task not found" })
      }

      res.json({ success: true })
    } catch (error) {
      console.error("Error completing task:", error)
      res.status(500).json({ error: "Failed to complete task" })
    }
  })

  app.post("/api/tasks/:id/reschedule", requireAuth, async (req, res) => {
    try {
      const { id } = req.params
      const settings = await storage.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const event = await getCalendarEvent(req.user!.id, id, settings.calendarId)
      if (!event || !event.start?.dateTime || !event.end?.dateTime) {
        return res.status(404).json({ error: "Task not found" })
      }

      const start = new Date(event.start.dateTime)
      const end = new Date(event.end.dateTime)
      const durationMinutes = Math.max(
        1,
        Math.round((end.getTime() - start.getTime()) / 60000),
      )
      const slot = await findFreeSlot(req.user!.id, settings, durationMinutes)

      if (!slot) {
        return res
          .status(409)
          .json({ error: "No free time slots available in the next 90 days." })
      }

      await updateCalendarEventTime(req.user!.id, id, settings, slot)

      res.json({ success: true })
    } catch (error) {
      console.error("Error rescheduling task:", error)
      res.status(500).json({ error: "Failed to reschedule task" })
    }
  })

  app.get("/action/:token", async (req, res) => {
    try {
      const { token } = req.params

      if (!req.isAuthenticated() || !req.user) {
        const loginUrl = `/api/auth/google?actionToken=${encodeURIComponent(token)}`
        const body = `
          <h1>Sign in required</h1>
          <p>Sign in to manage this task with your CalTodo account.</p>
          <a class="button-link" href="${escapeHtml(loginUrl)}">Sign in with Google</a>
        `
        return res.status(200).send(renderActionShell("Sign in required", body))
      }

      const actionToken = await getActionToken(token)
      if (!actionToken) {
        const body = `
          <h1>Invalid or expired link</h1>
          <p>This action link is no longer valid. Please use the app to manage your tasks.</p>
          <a class="button-link" href="/">Go to CalTodo</a>
        `
        return res.status(400).send(renderActionShell("Invalid Link", body))
      }

      if (actionToken.userId !== req.user.id) {
        const body = `
          <h1>Not authorized</h1>
          <p>This action link belongs to a different account.</p>
          <a class="button-link" href="/">Go to CalTodo</a>
        `
        return res.status(403).send(renderActionShell("Not authorized", body))
      }

      const event = await getCalendarEvent(
        req.user.id,
        actionToken.eventId,
        actionToken.calendarId,
      )
      if (!event) {
        const body = `
          <h1>Task not found</h1>
          <p>This task may have been deleted.</p>
          <a class="button-link" href="/">Go to CalTodo</a>
        `
        return res.status(404).send(renderActionShell("Task not found", body))
      }

      const task = mapCalendarEventToTask(event)
      if (!task) {
        const body = `
          <h1>Task not found</h1>
          <p>This link is no longer valid for that task.</p>
          <a class="button-link" href="/">Go to CalTodo</a>
        `
        return res.status(404).send(renderActionShell("Task not found", body))
      }

      const csrfToken = req.session?.csrfToken || ""
      const actionUrl = escapeHtml(`/api/action/${encodeURIComponent(token)}`)
      const csrfInput = `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />`
      const completedNote = task.completed
        ? `<p class="muted">This task is already marked complete.</p>`
        : ""

      const body = `
        <h1>Manage task</h1>
        <p>"${escapeHtml(task.title || "Task")}"</p>
        ${completedNote}
        <div class="actions">
          <form method="POST" action="${actionUrl}">
            ${csrfInput}
            <input type="hidden" name="action" value="complete" />
            <button type="submit" ${task.completed ? "disabled" : ""}>Mark complete</button>
          </form>
          <form method="POST" action="${actionUrl}">
            ${csrfInput}
            <input type="hidden" name="action" value="reschedule" />
            <button type="submit" class="secondary">Reschedule</button>
          </form>
        </div>
      `

      return res.status(200).send(renderActionShell("Manage task", body))
    } catch (error) {
      console.error("Error rendering action page:", error)
      const body = `
        <h1>Something went wrong</h1>
        <p>Please try again or use the app to manage your tasks.</p>
        <a class="button-link" href="/">Go to CalTodo</a>
      `
      return res.status(500).send(renderActionShell("Error", body))
    }
  })

  app.post("/api/action/:token", requireAuth, async (req, res) => {
    try {
      const { token } = req.params
      const wantsHtml = req.headers.accept?.includes("text/html")
      const respondError = (status: number, title: string, message: string) => {
        if (wantsHtml) {
          const body = `
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(message)}</p>
            <a class="button-link" href="/">Go to CalTodo</a>
          `
          return res.status(status).send(renderActionShell(title, body))
        }
        return res.status(status).json({ error: message })
      }

      const parsed = actionRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        return respondError(400, "Invalid action", "Invalid action.")
      }

      const actionToken = await getActionToken(token)
      if (!actionToken) {
        return respondError(400, "Invalid link", "Invalid or expired link.")
      }

      if (actionToken.userId !== req.user!.id) {
        return respondError(403, "Not authorized", "Unauthorized.")
      }

      const settings = await storage.getUserSettings(req.user!.id)
      if (!settings) {
        return respondError(400, "Missing settings", "No settings configured.")
      }

      const calendarId = actionToken.calendarId
      const event = await getCalendarEvent(req.user!.id, actionToken.eventId, calendarId)
      if (!event) {
        return respondError(404, "Task not found", "Task not found.")
      }

      const task = mapCalendarEventToTask(event)
      if (!task) {
        return respondError(404, "Task not found", "Task not found.")
      }

      const actionSettings = { ...settings, calendarId }
      if (parsed.data.action === "complete") {
        const updatedEvent = await updateCalendarEventCompletion(
          req.user!.id,
          actionToken.eventId,
          actionSettings,
          true,
        )
        if (!updatedEvent) {
          return respondError(404, "Task not found", "Task not found.")
        }
      } else {
        if (!event.start?.dateTime || !event.end?.dateTime) {
          return respondError(400, "Invalid event", "Invalid event time range.")
        }

        const start = new Date(event.start.dateTime)
        const end = new Date(event.end.dateTime)
        const durationMinutes = Math.max(
          1,
          Math.round((end.getTime() - start.getTime()) / 60000),
        )
        const slot = await findFreeSlot(req.user!.id, actionSettings, durationMinutes)

        if (!slot) {
          return respondError(
            409,
            "No free time slots",
            "No free time slots available in the next 90 days.",
          )
        }

        const updated = await updateCalendarEventTime(
          req.user!.id,
          actionToken.eventId,
          actionSettings,
          slot,
        )
        if (!updated) {
          return respondError(404, "Task not found", "Task not found.")
        }
      }

      await refreshCalendarEventActions(
        req.user!.id,
        calendarId,
        actionToken.eventId,
        task.details,
        getBaseUrl(req),
      )

      if (wantsHtml) {
        const actionLabel =
          parsed.data.action === "complete" ? "Task completed" : "Task rescheduled"
        const body = `
          <h1>${escapeHtml(actionLabel)}</h1>
          <p>${escapeHtml(task.title || "Task")} has been updated.</p>
          <a class="button-link" href="/">Go to CalTodo</a>
        `
        return res.status(200).send(renderActionShell(actionLabel, body))
      }

      return res.json({ success: true })
    } catch (error) {
      console.error("Error processing action:", error)
      return res.status(500).json({ error: "Failed to process action" })
    }
  })

  return httpServer
}
