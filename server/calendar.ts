import { google, calendar_v3 } from "googleapis";
import { storage } from "./storage";
import type { UserSettings } from "@shared/schema";
import type { CalendarTask } from "@shared/types";
import { generateActionToken } from "./tokens";

const APP_SIGNATURE = "Created by CalTodo";
const EVENT_TITLE_PREFIX_INCOMPLETE = "☑️ ";
const EVENT_TITLE_PREFIX_COMPLETE = "✅ ";
const EVENT_MARKER_KEY = "caltodo";
const EVENT_COMPLETED_KEY = "caltodoCompleted";
const EVENT_ACTIONS_MARKER = "Actions:\n- Mark Complete:";

// Helper to add/strip the emoji prefix from event titles
function formatEventTitle(title: string, completed: boolean): string {
  return `${completed ? EVENT_TITLE_PREFIX_COMPLETE : EVENT_TITLE_PREFIX_INCOMPLETE}${title}`;
}

export function stripEventTitlePrefix(summary: string): string {
  if (summary.startsWith(EVENT_TITLE_PREFIX_INCOMPLETE)) {
    return summary.slice(EVENT_TITLE_PREFIX_INCOMPLETE.length);
  }
  if (summary.startsWith(EVENT_TITLE_PREFIX_COMPLETE)) {
    return summary.slice(EVENT_TITLE_PREFIX_COMPLETE.length);
  }
  return summary;
}

function buildEventPrivateProperties(completed: boolean): Record<string, string> {
  return {
    [EVENT_MARKER_KEY]: "true",
    [EVENT_COMPLETED_KEY]: completed ? "true" : "false",
  };
}

function isCalTodoEvent(event: calendar_v3.Schema$Event): boolean {
  return event.extendedProperties?.private?.[EVENT_MARKER_KEY] === "true";
}

function getEventCompletion(event: calendar_v3.Schema$Event): boolean | undefined {
  const rawValue = event.extendedProperties?.private?.[EVENT_COMPLETED_KEY];
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  return undefined;
}

function isCompletedCalTodoEvent(event: calendar_v3.Schema$Event): boolean {
  if (!isCalTodoEvent(event)) return false;
  return getEventCompletion(event) === true;
}

function extractDetailsFromDescription(description?: string | null): string | null {
  if (!description) return null;
  let content = description;
  const signatureMarker = `---\n${APP_SIGNATURE}`;
  const signatureIndex = content.indexOf(signatureMarker);
  if (signatureIndex !== -1) {
    content = content.slice(0, signatureIndex);
  }
  const actionsIndex = content.indexOf(EVENT_ACTIONS_MARKER);
  if (actionsIndex !== -1) {
    content = content.slice(0, actionsIndex);
  }
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getDurationMinutes(start: Date, end: Date): number | null {
  const diffMs = end.getTime() - start.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null;
  return Math.round(diffMs / 60000);
}

export function mapCalendarEventToTask(event: calendar_v3.Schema$Event): CalendarTask | null {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) return null;
  if (!isCalTodoEvent(event)) return null;

  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const completed = getEventCompletion(event) === true;
  const completedAt = completed
    ? (event.updated ? new Date(event.updated).toISOString() : end.toISOString())
    : null;

  return {
    id: event.id,
    title: stripEventTitlePrefix(event.summary || ""),
    details: extractDetailsFromDescription(event.description),
    duration: getDurationMinutes(start, end),
    scheduledStart: start.toISOString(),
    scheduledEnd: end.toISOString(),
    completed,
    completedAt,
    priority: 0,
  };
}

// Helper to build event description: details first (if any), then actions
function buildEventDescription(details: string | null, completeLink: string, rescheduleLink: string): string {
  const parts: string[] = [];
  if (details) {
    parts.push(details);
    parts.push("");
  }
  parts.push(`Actions:\n- Mark Complete: ${completeLink}\n- Reschedule: ${rescheduleLink}`);
  parts.push(`\n---\n${APP_SIGNATURE}`);
  return parts.join("\n");
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

export async function listCalendarEventsInRange(
  calendar: calendar_v3.Calendar,
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<calendar_v3.Schema$Event[]> {
  try {
    const response = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    return response.data.items || [];
  } catch (error: any) {
    console.error("Error listing calendar events:", error?.message || error);
    return [];
  }
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
  excludeCalTodoEvents: boolean = false,
  prefetchedEvents?: {
    events: calendar_v3.Schema$Event[];
    timeMin: Date;
    timeMax: Date;
  }
): Promise<{ start: Date; end: Date } | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return null;

  const timezone = settings.timezone || 'UTC';
  const now = afterTime || new Date();
  const searchEndDate = new Date(now);
  searchEndDate.setDate(searchEndDate.getDate() + 90);

  try {
    const shouldUsePrefetched =
      prefetchedEvents &&
      now >= prefetchedEvents.timeMin &&
      searchEndDate <= prefetchedEvents.timeMax;

    let events =
      shouldUsePrefetched && prefetchedEvents?.events
        ? prefetchedEvents.events
        : await listCalendarEventsInRange(calendar, settings.calendarId, now, searchEndDate);
    
    // When rescheduling, exclude all CalTodo-managed events. Otherwise ignore completed CalTodo events.
    if (excludeCalTodoEvents) {
      events = events.filter(event => !isCalTodoEvent(event));
    } else {
      events = events.filter(event => !isCompletedCalTodoEvent(event));
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

interface CalendarEventInput {
  title: string;
  details: string | null;
}

function buildBaseDescription(details: string | null): string {
  if (details) {
    return `${details}\n\n---\n${APP_SIGNATURE}`;
  }
  return `---\n${APP_SIGNATURE}`;
}

async function updateCalendarEventActions(
  userId: string,
  calendarId: string,
  eventId: string,
  details: string | null,
  baseUrl: string
): Promise<void> {
  const calendar = await getCalendarClient(userId);
  if (!calendar) return;

  const completeToken = generateActionToken(userId, eventId, "complete");
  const rescheduleToken = generateActionToken(userId, eventId, "reschedule");

  const completeLink = `${baseUrl}/api/action/${completeToken}`;
  const rescheduleLink = `${baseUrl}/api/action/${rescheduleToken}`;

  const description = buildEventDescription(details, completeLink, rescheduleLink);

  try {
    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        description,
      },
    });
  } catch (error) {
    console.error("Error updating calendar event actions:", error);
  }
}

export async function createCalendarEvent(
  userId: string,
  input: CalendarEventInput,
  settings: UserSettings,
  slot: { start: Date; end: Date },
  baseUrl: string
): Promise<string | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return null;

  try {
    const requestBody: calendar_v3.Schema$Event = {
      summary: formatEventTitle(input.title, false),
      description: buildBaseDescription(input.details),
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
        private: buildEventPrivateProperties(false),
      },
    };

    const response = await calendar.events.insert({
      calendarId: settings.calendarId,
      requestBody,
    });

    const eventId = response.data.id || null;
    if (eventId) {
      await updateCalendarEventActions(
        userId,
        settings.calendarId,
        eventId,
        input.details,
        baseUrl
      );
    }

    return eventId;
  } catch (error) {
    console.error("Error creating calendar event:", error);
    return null;
  }
}

export async function updateCalendarEventTime(
  userId: string,
  eventId: string,
  settings: UserSettings,
  slot: { start: Date; end: Date }
): Promise<boolean> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return false;

  try {
    await calendar.events.patch({
      calendarId: settings.calendarId,
      eventId,
      requestBody: {
        start: {
          dateTime: slot.start.toISOString(),
          timeZone: settings.timezone,
        },
        end: {
          dateTime: slot.end.toISOString(),
          timeZone: settings.timezone,
        },
      },
    });
    return true;
  } catch (error) {
    console.error("Error updating calendar event time:", error);
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

export async function updateCalendarEventCompletion(
  userId: string,
  eventId: string,
  settings: UserSettings,
  completed: boolean
): Promise<calendar_v3.Schema$Event | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar || !settings.calendarId) return null;

  try {
    const current = await calendar.events.get({
      calendarId: settings.calendarId,
      eventId,
    });

    const currentEvent = current.data;
    if (currentEvent.status === "cancelled") {
      return null;
    }

    const title = stripEventTitlePrefix(currentEvent.summary || "");
    const existingPrivate = currentEvent.extendedProperties?.private || {};

    const response = await calendar.events.patch({
      calendarId: settings.calendarId,
      eventId,
      requestBody: {
        summary: formatEventTitle(title, completed),
        extendedProperties: {
          private: {
            ...existingPrivate,
            ...buildEventPrivateProperties(completed),
          },
        },
      },
    });

    return response.data;
  } catch (error: any) {
    const statusCode = error?.code || error?.response?.status || error?.status;
    if (statusCode === 404 || statusCode === 410) {
      return null;
    }
    console.error("Error updating calendar event completion:", error?.message || error);
    return null;
  }
}

export async function getCalendarEvent(
  userId: string,
  eventId: string,
  calendarId: string
): Promise<calendar_v3.Schema$Event | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar) return null;

  try {
    const response = await calendar.events.get({
      calendarId,
      eventId,
    });

    const event = response.data;
    if (event.status === "cancelled") {
      return null;
    }
    return event;
  } catch (error: any) {
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
  details?: string | null;
  durationMinutes?: number | null;
  completed?: boolean;
  updated?: Date;
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
        const start = new Date(event.start.dateTime);
        const end = new Date(event.end.dateTime);
        return {
          eventId,
          data: {
            eventId,
            start,
            end,
            summary: event.summary || undefined,
            details: extractDetailsFromDescription(event.description),
            durationMinutes: getDurationMinutes(start, end),
            completed: getEventCompletion(event),
            updated: event.updated ? new Date(event.updated) : undefined,
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

export async function rescheduleAllUserTasks(
  userId: string,
  priorityEventIds?: string[]
): Promise<void> {
  const settings = await storage.getUserSettings(userId);
  if (!settings?.calendarId) return;

  const calendar = await getCalendarClient(userId);
  if (!calendar) return;

  const windowStart = new Date();
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 90);

  const windowEvents = await listCalendarEventsInRange(calendar, settings.calendarId, windowStart, windowEnd);

  const caltodoEvents = windowEvents
    .filter(isCalTodoEvent)
    .filter((event) => getEventCompletion(event) !== true)
    .filter((event) => event.id && event.start?.dateTime && event.end?.dateTime);

  const prioritySet = new Set(priorityEventIds || []);
  const prioritizedEvents = (priorityEventIds || [])
    .map((id) => caltodoEvents.find((event) => event.id === id))
    .filter((event): event is calendar_v3.Schema$Event => Boolean(event));

  const remainingEvents = caltodoEvents
    .filter((event) => !prioritySet.has(event.id!))
    .sort(
      (a, b) =>
        new Date(a.start!.dateTime!).getTime() - new Date(b.start!.dateTime!).getTime()
    );

  const orderedEvents = [...prioritizedEvents, ...remainingEvents];
  let lastSlotEnd: Date | undefined;

  for (const event of orderedEvents) {
    const start = new Date(event.start!.dateTime!);
    const end = new Date(event.end!.dateTime!);
    const durationMinutes = getDurationMinutes(start, end) || settings.defaultDuration;

    const optimalSlot = await findFreeSlot(
      userId,
      settings,
      durationMinutes,
      lastSlotEnd,
      true,
      { events: windowEvents, timeMin: windowStart, timeMax: windowEnd }
    );
    if (!optimalSlot) continue;

    const slotMatches = Math.abs(start.getTime() - optimalSlot.start.getTime()) < 60000;
    if (slotMatches) {
      lastSlotEnd = new Date(event.end!.dateTime!);
      continue;
    }

    await updateCalendarEventTime(userId, event.id!, settings, optimalSlot);
    lastSlotEnd = optimalSlot.end;
  }
}
