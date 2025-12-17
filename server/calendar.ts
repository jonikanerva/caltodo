import { google, calendar_v3 } from "googleapis";
import { storage } from "./storage";
import type { Task, UserSettings } from "@shared/schema";
import { generateActionToken } from "./tokens";

const APP_IDENTIFIER = "[CalTodo]";

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

  const description = `${task.details || ""}\n\n---\n${APP_IDENTIFIER}\n\nActions:\n- Mark Complete: ${completeLink}\n- Reschedule: ${rescheduleLink}`;

  try {
    const requestBody: calendar_v3.Schema$Event = {
      summary: `${APP_IDENTIFIER} ${task.title}`,
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

  const description = `${task.details || ""}\n\n---\n${APP_IDENTIFIER}\n\nActions:\n- Mark Complete: ${completeLink}\n- Reschedule: ${rescheduleLink}`;

  try {
    const requestBody: calendar_v3.Schema$Event = {
      summary: `${APP_IDENTIFIER} ${task.title}`,
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

  const description = `${task.details || ""}\n\n---\n${APP_IDENTIFIER}\n\nActions:\n- Mark Complete: ${completeLink}\n- Reschedule: ${rescheduleLink}`;

  try {
    await calendar.events.patch({
      calendarId: settings.calendarId,
      eventId,
      requestBody: {
        summary: `${APP_IDENTIFIER} ${task.title}`,
        description,
      },
    });
    return true;
  } catch (error) {
    console.error("Error updating calendar event content:", error);
    return false;
  }
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
