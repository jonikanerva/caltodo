import type { RequestHandler } from "express"
import { z } from "zod"
import { storage } from "../storage"
import {
  getCalendarEvent,
  mapCalendarEventToTask,
  updateCalendarEventCompletion,
  findFreeSlot,
  updateCalendarEventTime,
  refreshCalendarEventActions,
} from "../calendar"
import { consumeActionToken, getActionToken } from "../tokens"
import { escapeHtml, getBaseUrl, readPathParam, renderActionShell } from "./common"

const actionRequestSchema = z.object({
  action: z.enum(["complete", "reschedule"]),
})

type ActionPageRouteDeps = {
  getActionToken: typeof getActionToken
  getCalendarEvent: typeof getCalendarEvent
  mapCalendarEventToTask: typeof mapCalendarEventToTask
}

type ActionApiRouteDeps = {
  getActionToken: typeof getActionToken
  consumeActionToken: typeof consumeActionToken
  getUserSettings: typeof storage.getUserSettings
  getCalendarEvent: typeof getCalendarEvent
  mapCalendarEventToTask: typeof mapCalendarEventToTask
  updateCalendarEventCompletion: typeof updateCalendarEventCompletion
  findFreeSlot: typeof findFreeSlot
  updateCalendarEventTime: typeof updateCalendarEventTime
  refreshCalendarEventActions: typeof refreshCalendarEventActions
}

const defaultActionPageRouteDeps: ActionPageRouteDeps = {
  getActionToken,
  getCalendarEvent,
  mapCalendarEventToTask,
}

const defaultActionApiRouteDeps: ActionApiRouteDeps = {
  getActionToken,
  consumeActionToken,
  getUserSettings: storage.getUserSettings.bind(storage),
  getCalendarEvent,
  mapCalendarEventToTask,
  updateCalendarEventCompletion,
  findFreeSlot,
  updateCalendarEventTime,
  refreshCalendarEventActions,
}

export function createActionPageHandler(
  deps: ActionPageRouteDeps = defaultActionPageRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const token = readPathParam(req.params, "token")
      if (!token) {
        const body = `
          <h1>Invalid link</h1>
          <p>This action link is not valid.</p>
          <a class="button-link" href="/">Go to Todo</a>
        `
        return res.status(400).send(renderActionShell("Invalid Link", body))
      }

      if (!req.isAuthenticated() || !req.user) {
        const loginUrl = `/api/auth/google?actionToken=${encodeURIComponent(token)}`
        const body = `
          <h1>Sign in required</h1>
          <p>Sign in to manage this task with your Todo account.</p>
          <a class="button-link" href="${escapeHtml(loginUrl)}">Sign in with Google</a>
        `
        return res.status(200).send(renderActionShell("Sign in required", body))
      }

      const actionToken = await deps.getActionToken(token)
      if (!actionToken) {
        const body = `
          <h1>Invalid or expired link</h1>
          <p>This action link is no longer valid. Please use the app to manage your tasks.</p>
          <a class="button-link" href="/">Go to Todo</a>
        `
        return res.status(400).send(renderActionShell("Invalid Link", body))
      }

      if (actionToken.userId !== req.user.id) {
        const body = `
          <h1>Not authorized</h1>
          <p>This action link belongs to a different account.</p>
          <a class="button-link" href="/">Go to Todo</a>
        `
        return res.status(403).send(renderActionShell("Not authorized", body))
      }

      const event = await deps.getCalendarEvent(
        req.user.id,
        actionToken.eventId,
        actionToken.calendarId,
      )
      if (!event) {
        const body = `
          <h1>Task not found</h1>
          <p>This task may have been deleted.</p>
          <a class="button-link" href="/">Go to Todo</a>
        `
        return res.status(404).send(renderActionShell("Task not found", body))
      }

      const task = deps.mapCalendarEventToTask(event)
      if (!task) {
        const body = `
          <h1>Task not found</h1>
          <p>This link is no longer valid for that task.</p>
          <a class="button-link" href="/">Go to Todo</a>
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
        <a class="button-link" href="/">Go to Todo</a>
      `
      return res.status(500).send(renderActionShell("Error", body))
    }
  }
}

export function createApiActionHandler(
  deps: ActionApiRouteDeps = defaultActionApiRouteDeps,
  baseUrlProvider: () => string = getBaseUrl,
): RequestHandler {
  return async (req, res) => {
    try {
      const token = readPathParam(req.params, "token")
      if (!token) {
        return res.status(400).json({ error: "Invalid action token" })
      }
      const wantsHtml = req.headers.accept?.includes("text/html")
      const respondError = (status: number, title: string, message: string) => {
        if (wantsHtml) {
          const body = `
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(message)}</p>
            <a class="button-link" href="/">Go to Todo</a>
          `
          return res.status(status).send(renderActionShell(title, body))
        }
        return res.status(status).json({ error: message })
      }

      const parsed = actionRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        return respondError(400, "Invalid action", "Invalid action.")
      }

      const candidateActionToken = await deps.getActionToken(token)
      if (!candidateActionToken) {
        return respondError(400, "Invalid link", "Invalid or expired link.")
      }
      if (candidateActionToken.userId !== req.user!.id) {
        return respondError(403, "Not authorized", "Unauthorized.")
      }
      const actionToken = await deps.consumeActionToken(token, req.user!.id)
      if (!actionToken) {
        return respondError(400, "Invalid link", "Invalid or expired link.")
      }

      const settings = await deps.getUserSettings(req.user!.id)
      if (!settings) {
        return respondError(400, "Missing settings", "No settings configured.")
      }

      const calendarId = actionToken.calendarId
      const event = await deps.getCalendarEvent(
        req.user!.id,
        actionToken.eventId,
        calendarId,
      )
      if (!event) {
        return respondError(404, "Task not found", "Task not found.")
      }

      const task = deps.mapCalendarEventToTask(event)
      if (!task) {
        return respondError(404, "Task not found", "Task not found.")
      }

      const actionSettings = { ...settings, calendarId }
      if (parsed.data.action === "complete") {
        const updatedEvent = await deps.updateCalendarEventCompletion(
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
        const slot = await deps.findFreeSlot(
          req.user!.id,
          actionSettings,
          durationMinutes,
        )

        if (!slot) {
          return respondError(
            409,
            "No free time slots",
            "No free time slots available in the next 90 days.",
          )
        }

        const updated = await deps.updateCalendarEventTime(
          req.user!.id,
          actionToken.eventId,
          actionSettings,
          slot,
        )
        if (!updated) {
          return respondError(404, "Task not found", "Task not found.")
        }
      }

      await deps.refreshCalendarEventActions(
        req.user!.id,
        calendarId,
        actionToken.eventId,
        task.details,
        baseUrlProvider(),
      )

      if (wantsHtml) {
        const actionLabel =
          parsed.data.action === "complete" ? "Task completed" : "Task rescheduled"
        const body = `
          <h1>${escapeHtml(actionLabel)}</h1>
          <p>${escapeHtml(task.title || "Task")} has been updated.</p>
          <a class="button-link" href="/">Go to Todo</a>
        `
        return res.status(200).send(renderActionShell(actionLabel, body))
      }

      return res.json({ success: true })
    } catch (error) {
      console.error("Error processing action:", error)
      return res.status(500).json({ error: "Failed to process action" })
    }
  }
}
