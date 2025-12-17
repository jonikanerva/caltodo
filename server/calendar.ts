import { google, calendar_v3 } from "googleapis";
import { storage } from "./storage";
import type { Task, UserSettings } from "@shared/schema";
import { generateActionToken } from "./tokens";

const APP_SIGNATURE = "Created by CalTodo";
const EVENT_TITLE_PREFIX = "☑️ ";

// Helper to add/strip the emoji prefix from event titles
function formatEventTitle(title: string): string {
  return `${EVENT_TITLE_PREFIX}${title}`;
}

export function stripEventTitlePrefix(summary: string): string {
  if (summary.startsWith(EVENT_TITLE_PREFIX)) {
    return summary.slice(EVENT_TITLE_PREFIX.length);
  }
  return summary;
}

// Helper to build event description: details first (if any), then actions
function buildEventDescription(task: Task, completeLink: string, rescheduleLink: string): string {
  const parts: string[] = [];
  if (task.details) {
    parts.push(task.details);
    parts.push('');
  }
  parts.push(`Actions:\n- Mark Complete: ${completeLink}\n- Reschedule: ${rescheduleLink}`);
  parts.push(`\n---\n${APP_SIGNATURE}`);
  return parts.join('\n');
}

// Helper to get hours and minutes in a specific timezone
function getTimeInTimezone(date: Date, timezone: string): { hours: number; minutes: number; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hours = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minutes = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  const weekdayStr = parts.find(p => p.type === 'weekday')?.value || 'Mon';
  const dayMap: Record<string, number> = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  const dayOfWeek = dayMap[weekdayStr] ?? 1;
  return { hours, minutes, dayOfWeek };
}

// Helper to set time to a specific hour in user's timezone
function setToHourInTimezone(date: Date, hour: number, timezone: string): Date {
  // Get current time in user's timezone
  const { hours: currentHours, minutes: currentMinutes } = getTimeInTimezone(date, timezone);
  const currentTotalMinutes = currentHours * 60 + currentMinutes;
  const targetTotalMinutes = hour * 60;
  const diffMinutes = targetTotalMinutes - currentTotalMinutes;
  
  const result = new Date(date);
  result.setMinutes(result.getMinutes() + diffMinutes);
  result.setSeconds(0);
  result.setMilliseconds(0);
  return result;
}

// Helper to advance to next day at a specific hour in user's timezone
function advanceToNextDayAtHour(date: Date, hour: number, timezone: string): Date {
  // First, go to the target hour today
  let result = setToHourInTimezone(date, hour, timezone);
  // Then add 24 hours
  result.setTime(result.getTime() + 24 * 60 * 60 * 1000);
  // Adjust for DST by ensuring we're exactly at the target hour
  const { hours } = getTimeInTimezone(result, timezone);
  if (hours !== hour) {
    const diff = hour - hours;
    result.setHours(result.getHours() + diff);
  }
  return result;
}

export async function getCalendarClient(userId: string): Promise<calendar_v3.Calendar | null> {
  const user = await storage.getUser(userId);
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
  afterTime?: Date,
  excludeCalTodoEvents: boolean = false
): Promise<{ start: Date; end: Date } | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return null;

  const timezone = settings.timezone || 'UTC';
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

    let events = response.data.items || [];
    
    // When rescheduling, exclude CalTodo-managed events from conflict check
    if (excludeCalTodoEvents) {
      events = events.filter(event => {
        const caltodoTaskId = event.extendedProperties?.private?.caltodoTaskId;
        return !caltodoTaskId;
      });
    }
    
    let currentDate = new Date(now);
    // Round up to next 15-minute interval
    currentDate.setMinutes(Math.ceil(currentDate.getMinutes() / 15) * 15);
    currentDate.setSeconds(0);
    currentDate.setMilliseconds(0);

    while (currentDate < searchEndDate) {
      // Get current time in user's timezone
      const { hours: currentHour, minutes: currentMinute, dayOfWeek } = getTimeInTimezone(currentDate, timezone);
      
      // Skip weekends
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        currentDate = advanceToNextDayAtHour(currentDate, settings.workStartHour, timezone);
        continue;
      }

      const currentTimeMinutes = currentHour * 60 + currentMinute;
      const workStartMinutes = settings.workStartHour * 60;
      const workEndMinutes = settings.workEndHour * 60;

      // If before work hours, jump to work start
      if (currentTimeMinutes < workStartMinutes) {
        currentDate = setToHourInTimezone(currentDate, settings.workStartHour, timezone);
        continue;
      }

      // If task would extend past work hours, go to next day
      if (currentTimeMinutes + durationMinutes > workEndMinutes) {
        currentDate = advanceToNextDayAtHour(currentDate, settings.workStartHour, timezone);
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

  const description = buildEventDescription(task, completeLink, rescheduleLink);

  try {
    const requestBody: calendar_v3.Schema$Event = {
      summary: formatEventTitle(task.title),
      description,
      visibility: "private",
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

  const description = buildEventDescription(task, completeLink, rescheduleLink);

  try {
    const requestBody: calendar_v3.Schema$Event = {
      summary: formatEventTitle(task.title),
      description,
      visibility: "private",
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

  const description = buildEventDescription(task, completeLink, rescheduleLink);

  try {
    await calendar.events.patch({
      calendarId: settings.calendarId,
      eventId,
      requestBody: {
        summary: formatEventTitle(task.title),
        description,
        visibility: "private",
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
    
    // Find the optimal slot, excluding all CalTodo events from conflict check
    const optimalSlot = await findFreeSlot(userId, settings, taskDuration, lastSlotEnd, true);
    if (!optimalSlot) continue;
    
    // Check if current slot matches the optimal slot (within 1 minute tolerance)
    const currentStart = task.scheduledStart ? new Date(task.scheduledStart).getTime() : 0;
    const optimalStart = optimalSlot.start.getTime();
    const slotMatches = task.calendarEventId && Math.abs(currentStart - optimalStart) < 60000;
    
    if (slotMatches) {
      // Current slot is already optimal, keep it
      lastSlotEnd = new Date(task.scheduledEnd!);
      continue;
    }
    
    // Need to update to the optimal slot
    if (task.calendarEventId) {
      await updateCalendarEvent(userId, task.calendarEventId, settings, optimalSlot, task, baseUrl);
    } else {
      const eventId = await createCalendarEvent(userId, task, settings, optimalSlot, baseUrl);
      if (eventId) {
        await storage.updateTask(task.id, { calendarEventId: eventId });
      }
    }

    await storage.updateTask(task.id, {
      scheduledStart: optimalSlot.start,
      scheduledEnd: optimalSlot.end,
    });

    lastSlotEnd = optimalSlot.end;
  }
}
