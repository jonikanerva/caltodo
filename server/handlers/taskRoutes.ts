import type { RequestHandler } from "express"
import { z } from "zod"
import { taskIdsSchema, createTaskSchema } from "@shared/schema"
import type { CalendarTask } from "@shared/types"
import { storage } from "../storage"
import {
  getCalendarClient,
  listCalendarEventsInRange,
  mapCalendarEventToTask,
  findFreeSlot,
  createCalendarEvent,
  rescheduleAllUserTasks,
  getCalendarEvent,
  updateCalendarEventCompletion,
  updateCalendarEventTime,
  getCalendarEventsForTasks,
  EVENT_DELETED,
  type CalendarEventData,
} from "../calendar"
import { getBaseUrl, readPathParam } from "./common"

const patchTaskSchema = z.object({
  completed: z.boolean(),
})

type TaskRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
  getCalendarClient: typeof getCalendarClient
  listCalendarEventsInRange: typeof listCalendarEventsInRange
  mapCalendarEventToTask: typeof mapCalendarEventToTask
}

type CreateTaskRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
  findFreeSlot: typeof findFreeSlot
  createCalendarEvent: typeof createCalendarEvent
  rescheduleAllUserTasks: typeof rescheduleAllUserTasks
  getCalendarEvent: typeof getCalendarEvent
  mapCalendarEventToTask: typeof mapCalendarEventToTask
}

type UpdateTaskRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
  updateCalendarEventCompletion: typeof updateCalendarEventCompletion
  mapCalendarEventToTask: typeof mapCalendarEventToTask
}

type RescheduleTaskRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
  getCalendarEvent: typeof getCalendarEvent
  findFreeSlot: typeof findFreeSlot
  updateCalendarEventTime: typeof updateCalendarEventTime
}

type ReorderTasksRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
  getCalendarEventsForTasks: typeof getCalendarEventsForTasks
  updateCalendarEventTime: typeof updateCalendarEventTime
}

type BulkCompleteTasksRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
  updateCalendarEventCompletion: typeof updateCalendarEventCompletion
}

type RescheduleAllTasksRouteDeps = {
  rescheduleAllUserTasks: typeof rescheduleAllUserTasks
}

type ReloadTasksRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
}

type CompleteTaskRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
  updateCalendarEventCompletion: typeof updateCalendarEventCompletion
}

const defaultTaskRouteDeps: TaskRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
  getCalendarClient,
  listCalendarEventsInRange,
  mapCalendarEventToTask,
}

const defaultCreateTaskRouteDeps: CreateTaskRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
  findFreeSlot,
  createCalendarEvent,
  rescheduleAllUserTasks,
  getCalendarEvent,
  mapCalendarEventToTask,
}

const defaultUpdateTaskRouteDeps: UpdateTaskRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
  updateCalendarEventCompletion,
  mapCalendarEventToTask,
}

const defaultRescheduleTaskRouteDeps: RescheduleTaskRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
  getCalendarEvent,
  findFreeSlot,
  updateCalendarEventTime,
}

const defaultReorderTasksRouteDeps: ReorderTasksRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
  getCalendarEventsForTasks,
  updateCalendarEventTime,
}

const defaultBulkCompleteTasksRouteDeps: BulkCompleteTasksRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
  updateCalendarEventCompletion,
}

const defaultRescheduleAllTasksRouteDeps: RescheduleAllTasksRouteDeps = {
  rescheduleAllUserTasks,
}

const defaultReloadTasksRouteDeps: ReloadTasksRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
}

const defaultCompleteTaskRouteDeps: CompleteTaskRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
  updateCalendarEventCompletion,
}

export function createGetTasksHandler(
  deps: TaskRouteDeps = defaultTaskRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const settings = await deps.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.json([])
      }

      const calendar = await deps.getCalendarClient(req.user!.id)
      if (!calendar) {
        return res.status(500).json({ error: "Failed to access calendar" })
      }

      const now = new Date()
      const timeMin = new Date(now)
      timeMin.setDate(timeMin.getDate() - 14)
      const timeMax = new Date(now)
      timeMax.setDate(timeMax.getDate() + 90)

      const events = await deps.listCalendarEventsInRange(
        calendar,
        settings.calendarId,
        timeMin,
        timeMax,
      )
      const tasks = events
        .map(deps.mapCalendarEventToTask)
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
  }
}

export function createPostTasksHandler(
  deps: CreateTaskRouteDeps = defaultCreateTaskRouteDeps,
  baseUrlProvider: () => string = getBaseUrl,
): RequestHandler {
  return async (req, res) => {
    try {
      const data = createTaskSchema.parse(req.body)
      const settings = await deps.getUserSettings(req.user!.id)

      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const taskDuration = data.duration || settings.defaultDuration
      const slot = await deps.findFreeSlot(req.user!.id, settings, taskDuration)

      if (!slot) {
        return res
          .status(409)
          .json({ error: "No free time slots available in the next 90 days." })
      }

      const eventId = await deps.createCalendarEvent(
        req.user!.id,
        {
          title: data.title,
          details: data.details || null,
        },
        settings,
        slot,
        baseUrlProvider(),
      )

      if (!eventId) {
        return res.status(500).json({ error: "Failed to create calendar event" })
      }

      if (data.urgent) {
        await deps.rescheduleAllUserTasks(req.user!.id, [eventId])
      }

      const createdEvent = await deps.getCalendarEvent(
        req.user!.id,
        eventId,
        settings.calendarId,
      )
      if (!createdEvent) {
        return res.status(500).json({ error: "Failed to load created event" })
      }

      const task = deps.mapCalendarEventToTask(createdEvent)
      if (!task) {
        return res.status(500).json({ error: "Failed to map created event" })
      }

      res.json(task)
    } catch (error) {
      console.error("Error creating task:", error)
      res.status(400).json({ error: "Failed to create task" })
    }
  }
}

export function createPatchTaskHandler(
  deps: UpdateTaskRouteDeps = defaultUpdateTaskRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const id = readPathParam(req.params, "id")
      if (!id) {
        return res.status(400).json({ error: "Invalid task id" })
      }

      const data = patchTaskSchema.parse(req.body)
      const settings = await deps.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const updatedEvent = await deps.updateCalendarEventCompletion(
        req.user!.id,
        id,
        settings,
        data.completed,
      )

      if (!updatedEvent) {
        return res.status(404).json({ error: "Task not found" })
      }

      const task = deps.mapCalendarEventToTask(updatedEvent)
      if (!task) {
        return res.status(500).json({ error: "Failed to map updated task" })
      }

      res.json(task)
    } catch (error) {
      console.error("Error updating task:", error)
      res.status(500).json({ error: "Failed to update task" })
    }
  }
}

export function createReorderTasksHandler(
  deps: ReorderTasksRouteDeps = defaultReorderTasksRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const parsed = taskIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid taskIds payload" })
      }
      const { taskIds } = parsed.data

      const settings = await deps.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const calendarEvents = await deps.getCalendarEventsForTasks(
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

        await deps.updateCalendarEventTime(req.user!.id, eventEntry.id, settings, {
          start: slot.start,
          end: adjustedEnd,
        })
      }

      res.json({ success: true })
    } catch (error) {
      console.error("Error reordering tasks:", error)
      res.status(500).json({ error: "Failed to reorder tasks" })
    }
  }
}

export function createBulkCompleteTasksHandler(
  deps: BulkCompleteTasksRouteDeps = defaultBulkCompleteTasksRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const parsed = taskIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid taskIds payload" })
      }
      const { taskIds } = parsed.data

      const settings = await deps.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      for (const taskId of taskIds) {
        await deps.updateCalendarEventCompletion(req.user!.id, taskId, settings, true)
      }

      res.json({ success: true })
    } catch (error) {
      console.error("Error bulk completing tasks:", error)
      res.status(500).json({ error: "Failed to complete tasks" })
    }
  }
}

export function createRescheduleAllTasksHandler(
  deps: RescheduleAllTasksRouteDeps = defaultRescheduleAllTasksRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      await deps.rescheduleAllUserTasks(req.user!.id)
      res.json({ success: true })
    } catch (error) {
      console.error("Error rescheduling all tasks:", error)
      res.status(500).json({ error: "Failed to reschedule tasks" })
    }
  }
}

export function createReloadTasksHandler(
  deps: ReloadTasksRouteDeps = defaultReloadTasksRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const settings = await deps.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      res.json({ success: true })
    } catch (error) {
      console.error("Error reloading calendar data:", error)
      res.status(500).json({ error: "Failed to reload calendar data" })
    }
  }
}

export function createCompleteTaskHandler(
  deps: CompleteTaskRouteDeps = defaultCompleteTaskRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const id = readPathParam(req.params, "id")
      if (!id) {
        return res.status(400).json({ error: "Invalid task id" })
      }

      const settings = await deps.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const updatedEvent = await deps.updateCalendarEventCompletion(
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
  }
}

export function createRescheduleTaskHandler(
  deps: RescheduleTaskRouteDeps = defaultRescheduleTaskRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const id = readPathParam(req.params, "id")
      if (!id) {
        return res.status(400).json({ error: "Invalid task id" })
      }

      const settings = await deps.getUserSettings(req.user!.id)
      if (!settings?.calendarId) {
        return res.status(400).json({ error: "No calendar configured" })
      }

      const event = await deps.getCalendarEvent(req.user!.id, id, settings.calendarId)
      if (!event || !event.start?.dateTime || !event.end?.dateTime) {
        return res.status(404).json({ error: "Task not found" })
      }

      const start = new Date(event.start.dateTime)
      const end = new Date(event.end.dateTime)
      const durationMinutes = Math.max(
        1,
        Math.round((end.getTime() - start.getTime()) / 60000),
      )
      const slot = await deps.findFreeSlot(req.user!.id, settings, durationMinutes)

      if (!slot) {
        return res
          .status(409)
          .json({ error: "No free time slots available in the next 90 days." })
      }

      const updated = await deps.updateCalendarEventTime(req.user!.id, id, settings, slot)
      if (!updated) {
        return res.status(404).json({ error: "Task not found" })
      }

      res.json({ success: true })
    } catch (error) {
      console.error("Error rescheduling task:", error)
      res.status(500).json({ error: "Failed to reschedule task" })
    }
  }
}
