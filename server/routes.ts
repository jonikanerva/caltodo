import type { Express } from "express"
import { type Server } from "http"
import { requireAuth, setupAuth } from "./auth"
import { ensureCsrfToken, requireCsrfToken } from "./csrf"
import { setupCronJobs } from "./cron"
import {
  createAuthGoogleStartHandler,
  createAuthGoogleCallbackAuthHandler,
  createAuthGoogleCallbackSuccessHandler,
  createAuthUserHandler,
  createAuthLogoutHandler,
  createDeleteAccountHandler,
  createGetSettingsHandler,
  createPatchSettingsHandler,
  createGetCalendarsHandler,
} from "./handlers/authRoutes"
import {
  createGetTasksHandler,
  createPostTasksHandler,
  createPatchTaskHandler,
  createReorderTasksHandler,
  createBulkCompleteTasksHandler,
  createRescheduleAllTasksHandler,
  createReloadTasksHandler,
  createCompleteTaskHandler,
  createRescheduleTaskHandler,
} from "./handlers/taskRoutes"
import { createActionPageHandler, createApiActionHandler } from "./handlers/actionRoutes"
import { getBaseUrl } from "./handlers/common"

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  setupAuth(app)
  app.use(ensureCsrfToken)
  app.use(requireCsrfToken)

  const appBaseUrl = getBaseUrl()
  setupCronJobs(appBaseUrl)
  console.log("OAuth callback URL:", `${appBaseUrl}/api/auth/google/callback`)

  app.get("/api/auth/google", createAuthGoogleStartHandler())
  app.get(
    "/api/auth/google/callback",
    createAuthGoogleCallbackAuthHandler(),
    createAuthGoogleCallbackSuccessHandler(),
  )
  app.get("/api/auth/user", createAuthUserHandler())
  app.post("/api/auth/logout", createAuthLogoutHandler())
  app.delete("/api/account", requireAuth, createDeleteAccountHandler())
  app.get("/api/settings", requireAuth, createGetSettingsHandler())
  app.patch("/api/settings", requireAuth, createPatchSettingsHandler())
  app.get("/api/calendars", requireAuth, createGetCalendarsHandler())

  app.get("/api/tasks", requireAuth, createGetTasksHandler())
  app.post("/api/tasks", requireAuth, createPostTasksHandler())
  app.patch("/api/tasks/:id", requireAuth, createPatchTaskHandler())
  app.post("/api/tasks/reorder", requireAuth, createReorderTasksHandler())
  app.post("/api/tasks/bulk-complete", requireAuth, createBulkCompleteTasksHandler())
  app.post("/api/tasks/reschedule-all", requireAuth, createRescheduleAllTasksHandler())
  app.post("/api/tasks/reload", requireAuth, createReloadTasksHandler())
  app.post("/api/tasks/:id/complete", requireAuth, createCompleteTaskHandler())
  app.post("/api/tasks/:id/reschedule", requireAuth, createRescheduleTaskHandler())

  app.get("/action/:token", createActionPageHandler())
  app.post("/api/action/:token", requireAuth, createApiActionHandler())

  return httpServer
}
