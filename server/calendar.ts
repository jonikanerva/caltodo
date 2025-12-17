import { google, calendar_v3 } from "googleapis";
import { storage } from "./storage";
import type { Task, UserSettings } from "@shared/schema";
import { generateActionToken } from "./tokens";

const APP_SIGNATURE = "Created by CalTodo";

export async function getCalendarClient(userId: string): Promise<calendar_v3.Calendar | null> {
  const user = await storage.getUser(userId);
  console.log("getCalendarClient - user found:", !!user, "hasAccessToken:", !!user?.accessToken, "hasRefreshToken:", !!user?.refreshToken);
  if (!user?.accessToken) return null;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
  });

  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await storage.updateUser(userId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || user.refreshToken,
      });
    }
  });

  return google.calendar({ version: "v3", auth: oauth2Client });
}

export async function listCalendars(userId: string): Promise<{ id: string; summary: string; primary?: boolean }[]> {
  const calendar = await getCalendarClient(userId);
  if (!calendar) {
    console.error("No calendar client available for user:", userId);
    return [];
  }

  try {
    const response = await calendar.calendarList.list();
    console.log("Calendar API response items:", response.data.items?.length || 0);
    return (response.data.items || []).map((cal) => ({
      id: cal.id || "",
      summary: cal.summary || "",
      primary: cal.primary || false,
    }));
  } catch (error: any) {
    console.error("Error listing calendars:", error?.message || error);
    if (error?.response?.data) {
      console.error("API error details:", JSON.stringify(error.response.data));
    }
    return [];
  }
}

export async function findFreeSlot(
  userId: string,
  settings: UserSettings,
  durationMinutes: number,
  afterTime?: Date
): Promise<{ start: Date; end: Date } | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return null;

  const now = afterTime || new Date();
  const searchEndDate = new Date(now);
  searchEndDate.setDate(searchEndDate.getDate() + 14);

  try {
    const response = await calendar.events.list({
      calendarId: settings.calendarId,
      timeMin: now.toISOString(),
      timeMax: searchEndDate.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];
    
    let currentDate = new Date(now);
    currentDate.setMinutes(Math.ceil(currentDate.getMinutes() / 15) * 15);
    currentDate.setSeconds(0);
    currentDate.setMilliseconds(0);

    while (currentDate < searchEndDate) {
      const dayOfWeek = currentDate.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        currentDate.setDate(currentDate.getDate() + 1);
        currentDate.setHours(settings.workStartHour, 0, 0, 0);
        continue;
      }

      const currentHour = currentDate.getHours();
      const currentMinute = currentDate.getMinutes();
      const currentTimeMinutes = currentHour * 60 + currentMinute;
      const workStartMinutes = settings.workStartHour * 60;
      const workEndMinutes = settings.workEndHour * 60;

      if (currentTimeMinutes < workStartMinutes) {
        currentDate.setHours(settings.workStartHour, 0, 0, 0);
        continue;
      }

      if (currentTimeMinutes + durationMinutes > workEndMinutes) {
        currentDate.setDate(currentDate.getDate() + 1);
        currentDate.setHours(settings.workStartHour, 0, 0, 0);
        continue;
      }

      const slotStart = new Date(currentDate);
      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + durationMinutes);

      const hasConflict = events.some((event) => {
        if (!event.start?.dateTime || !event.end?.dateTime) return false;
        const eventStart = new Date(event.start.dateTime);
        const eventEnd = new Date(event.end.dateTime);
        return slotStart < eventEnd && slotEnd > eventStart;
      });

      if (!hasConflict) {
        return { start: slotStart, end: slotEnd };
      }

      currentDate.setMinutes(currentDate.getMinutes() + 15);
    }

    return null;
  } catch (error) {
    console.error("Error finding free slot:", error);
    return null;
  }
}

export async function createCalendarEvent(
  userId: string,
  task: Task,
  settings: UserSettings,
  slot: { start: Date; end: Date },
  baseUrl: string
): Promise<string | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return null;

  const completeToken = generateActionToken(task.id, "complete");
  const rescheduleToken = generateActionToken(task.id, "reschedule");
  
  const completeLink = `${baseUrl}/api/action/${completeToken}`;
  const rescheduleLink = `${baseUrl}/api/action/${rescheduleToken}`;

  const description = `${task.details || ""}\n\nActions:\n- Mark Complete: ${completeLink}\n- Reschedule: ${rescheduleLink}\n\n---\n${APP_SIGNATURE}`;

  try {
    const requestBody: calendar_v3.Schema$Event = {
      summary: task.title,
      description,
      start: {
        dateTime: slot.start.toISOString(),
        timeZone: settings.timezone,
      },
      end: {
        dateTime: slot.end.toISOString(),
        timeZone: settings.timezone,
      },
      colorId: settings.eventColor,
      extendedProperties: {
        private: {
          caltodoTaskId: task.id,
        },
      },
    };

    if (task.reminderMinutes !== null && task.reminderMinutes !== undefined) {
      requestBody.reminders = {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: task.reminderMinutes },
        ],
      };
    } else {
      requestBody.reminders = {
        useDefault: false,
        overrides: [],
      };
    }

    const response = await calendar.events.insert({
      calendarId: settings.calendarId,
      requestBody,
    });

    return response.data.id || null;
  } catch (error) {
    console.error("Error creating calendar event:", error);
    return null;
  }
}

export async function updateCalendarEvent(
  userId: string,
  eventId: string,
  settings: UserSettings,
  slot: { start: Date; end: Date },
  task: Task,
  baseUrl: string
): Promise<boolean> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return false;

  const completeToken = generateActionToken(task.id, "complete");
  const rescheduleToken = generateActionToken(task.id, "reschedule");
  
  const completeLink = `${baseUrl}/api/action/${completeToken}`;
  const rescheduleLink = `${baseUrl}/api/action/${rescheduleToken}`;

  const description = `${task.details || ""}\n\nActions:\n- Mark Complete: ${completeLink}\n- Reschedule: ${rescheduleLink}\n\n---\n${APP_SIGNATURE}`;

  try {
    const requestBody: calendar_v3.Schema$Event = {
      summary: task.title,
      description,
      start: {
        dateTime: slot.start.toISOString(),
        timeZone: settings.timezone,
      },
      end: {
        dateTime: slot.end.toISOString(),
        timeZone: settings.timezone,
      },
      colorId: settings.eventColor,
      extendedProperties: {
        private: {
          caltodoTaskId: task.id,
        },
      },
    };

    if (task.reminderMinutes !== null && task.reminderMinutes !== undefined) {
      requestBody.reminders = {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: task.reminderMinutes },
        ],
      };
    } else {
      requestBody.reminders = {
        useDefault: false,
        overrides: [],
      };
    }

    await calendar.events.update({
      calendarId: settings.calendarId,
      eventId,
      requestBody,
    });
    return true;
  } catch (error) {
    console.error("Error updating calendar event:", error);
    return false;
  }
}

export async function deleteCalendarEvent(
  userId: string,
  eventId: string,
  calendarId: string
): Promise<boolean> {
  const calendar = await getCalendarClient(userId);
  if (!calendar) return false;

  try {
    await calendar.events.delete({
      calendarId,
      eventId,
    });
    return true;
  } catch (error) {
    console.error("Error deleting calendar event:", error);
    return false;
  }
}

export async function updateCalendarEventContent(
  userId: string,
  eventId: string,
  settings: UserSettings,
  task: Task,
  baseUrl: string
): Promise<boolean> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return false;

  const completeToken = generateActionToken(task.id, "complete");
  const rescheduleToken = generateActionToken(task.id, "reschedule");
  
  const completeLink = `${baseUrl}/api/action/${completeToken}`;
  const rescheduleLink = `${baseUrl}/api/action/${rescheduleToken}`;

  const description = `${task.details || ""}\n\nActions:\n- Mark Complete: ${completeLink}\n- Reschedule: ${rescheduleLink}\n\n---\n${APP_SIGNATURE}`;

  try {
    await calendar.events.patch({
      calendarId: settings.calendarId,
      eventId,
      requestBody: {
        summary: task.title,
        description,
        extendedProperties: {
          private: {
            caltodoTaskId: task.id,
          },
        },
      },
    });
    return true;
  } catch (error) {
    console.error("Error updating calendar event content:", error);
    return false;
  }
}

export async function getCalendarEvent(
  userId: string,
  eventId: string,
  calendarId: string
): Promise<{ start: Date; end: Date } | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar) return null;

  try {
    const response = await calendar.events.get({
      calendarId,
      eventId,
    });

    const event = response.data;
    
    // Check if event is cancelled/deleted
    if (event.status === "cancelled") {
      console.log(`Event ${eventId} has status: cancelled (deleted)`);
      return null;
    }
    
    if (!event.start?.dateTime || !event.end?.dateTime) {
      return null;
    }

    return {
      start: new Date(event.start.dateTime),
      end: new Date(event.end.dateTime),
    };
  } catch (error: any) {
    // Event might have been deleted from calendar
    const statusCode = error?.code || error?.response?.status || error?.status;
    if (statusCode === 404 || statusCode === 410) {
      return null;
    }
    console.error("Error fetching calendar event:", error?.message || error);
    return null;
  }
}

export interface CalendarEventData {
  eventId: string;
  start: Date;
  end: Date;
  summary?: string;
}

// Special marker for deleted events (404/410 errors)
export const EVENT_DELETED = "__EVENT_DELETED__" as const;

export type CalendarEventResult = CalendarEventData | typeof EVENT_DELETED | undefined;

export async function getCalendarEventsForTasks(
  userId: string,
  calendarId: string,
  eventIds: string[]
): Promise<Map<string, CalendarEventResult>> {
  const calendar = await getCalendarClient(userId);
  const results = new Map<string, CalendarEventResult>();
  
  if (!calendar || eventIds.length === 0) {
    return results;
  }

  // Fetch events in parallel for better performance
  const promises = eventIds.map(async (eventId) => {
    try {
      const response = await calendar.events.get({
        calendarId,
        eventId,
      });

      const event = response.data;
      
      // Check if event is cancelled/deleted (Google Calendar returns status: "cancelled" for deleted events)
      if (event.status === "cancelled") {
        console.log(`Event ${eventId} has status: cancelled (deleted)`);
        return { eventId, data: EVENT_DELETED };
      }
      
      if (event.start?.dateTime && event.end?.dateTime) {
        return {
          eventId,
          data: {
            eventId,
            start: new Date(event.start.dateTime),
            end: new Date(event.end.dateTime),
            summary: event.summary || undefined,
          } as CalendarEventData,
        };
      }
      return { eventId, data: undefined };
    } catch (error: any) {
      // Check for deleted events - Google API may return code in different places
      const statusCode = error?.code || error?.response?.status || error?.status;
      console.log(`Event ${eventId} fetch error - code: ${statusCode}, message: ${error?.message}`);
      
      // Only mark as deleted for 404 (not found) or 410 (gone) errors
      if (statusCode === 404 || statusCode === 410) {
        return { eventId, data: EVENT_DELETED };
      }
      // For other errors (auth, rate limit, network), leave undefined (no change)
      console.error(`Error fetching event ${eventId}:`, error?.message || error);
      return { eventId, data: undefined };
    }
  });

  const eventResults = await Promise.all(promises);
  for (const result of eventResults) {
    results.set(result.eventId, result.data);
  }

  return results;
}

export async function rescheduleAllUserTasks(userId: string, baseUrl: string): Promise<void> {
  const settings = await storage.getUserSettings(userId);
  if (!settings?.calendarId) return;

  const tasks = await storage.getUncompletedTasksByUser(userId);
  const sortedTasks = tasks.sort((a, b) => a.priority - b.priority);

  let lastSlotEnd: Date | undefined;

  for (const task of sortedTasks) {
    const taskDuration = task.duration || settings.defaultDuration;
    const slot = await findFreeSlot(userId, settings, taskDuration, lastSlotEnd);
    if (!slot) continue;

    if (task.calendarEventId) {
      await updateCalendarEvent(userId, task.calendarEventId, settings, slot, task, baseUrl);
    } else {
      const eventId = await createCalendarEvent(userId, task, settings, slot, baseUrl);
      if (eventId) {
        await storage.updateTask(task.id, { calendarEventId: eventId });
      }
    }

    await storage.updateTask(task.id, {
      scheduledStart: slot.start,
      scheduledEnd: slot.end,
    });

    lastSlotEnd = slot.end;
  }
}
