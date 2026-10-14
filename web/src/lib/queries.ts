import { queryOptions } from "@tanstack/react-query"
import {
  fetchCalendars,
  fetchCurrentUser,
  fetchSettings,
  fetchTasks,
} from "@caltodo/api-client"

// The query keys are the API paths, as in the original client, so the
// invalidations of the pages stay the same.

export const currentUserQuery = queryOptions({
  queryKey: ["/api/auth/user"],
  queryFn: ({ signal }) => fetchCurrentUser(signal),
})

export const tasksQuery = queryOptions({
  queryKey: ["/api/tasks"],
  queryFn: ({ signal }) => fetchTasks(signal),
})

export const settingsQuery = queryOptions({
  queryKey: ["/api/settings"],
  queryFn: ({ signal }) => fetchSettings(signal),
})

export const calendarsQuery = queryOptions({
  queryKey: ["/api/calendars"],
  queryFn: ({ signal }) => fetchCalendars(signal),
})
