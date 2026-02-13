import express from "express"
import session from "express-session"
import { createServer, type Server } from "http"
import { ensureCsrfToken, requireCsrfToken } from "../csrf"
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
} from "../handlers/taskRoutes"
import { createActionPageHandler, createApiActionHandler } from "../handlers/actionRoutes"
import type { createIntegrationFixtures } from "./fixtures"

type Fixtures = ReturnType<typeof createIntegrationFixtures>

declare module "express-session" {
  interface SessionData {
    userId?: string
  }
}

export function createIntegrationApp(fixtures: Fixtures) {
  const app = express()
  const requireAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.isAuthenticated()) return next()
    return res.status(401).json({ error: "Unauthorized" })
  }

  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.use(
    session({
      secret: "integration-test-session-secret-32-chars-minimum",
      resave: false,
      saveUninitialized: false,
    }),
  )

  app.post("/__test/login", (req, res) => {
    const userId = typeof req.body?.userId === "string" ? req.body.userId : ""
    const user = fixtures.usersById.get(userId)
    if (!user) {
      return res.status(400).json({ error: "Unknown test user" })
    }

    req.session.userId = user.id
    return res.json({ success: true })
  })

  app.post("/__test/logout", (req, res) => {
    delete req.session.userId
    return res.json({ success: true })
  })

  app.use((req, _res, next) => {
    const userId = req.session.userId
    const user = typeof userId === "string" ? fixtures.usersById.get(userId) : undefined

    req.user = user
    req.isAuthenticated = (() => Boolean(user)) as typeof req.isAuthenticated
    req.logout = (done) => {
      delete req.session.userId
      req.user = undefined
      if (typeof done === "function") {
        done(undefined)
      }
    }
    next()
  })

  app.use(ensureCsrfToken)
  app.use(requireCsrfToken)

  app.get("/api/auth/user", (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" })
    }
    return res.json({ ...req.user, csrfToken: req.session.csrfToken })
  })

  app.post("/api/auth/logout", (req, res) => {
    req.logout(() => {
      req.session.destroy(() => {
        res.clearCookie("connect.sid", {
          path: "/",
          sameSite: "lax",
          httpOnly: true,
          secure: false,
        })
        res.json({ success: true })
      })
    })
  })

  app.get("/api/settings", requireAuth, async (req, res) => {
    const settings = await fixtures.mocks.auth.getUserSettings(req.user!.id)
    return res.json(settings || null)
  })

  app.patch("/api/settings", requireAuth, async (req, res) => {
    const existing = await fixtures.mocks.auth.getUserSettings(req.user!.id)
    if (existing) {
      const updated = await fixtures.mocks.auth.updateUserSettings(req.user!.id, req.body)
      return res.json(updated)
    }
    const created = await fixtures.mocks.auth.createUserSettings({
      userId: req.user!.id,
      ...req.body,
    })
    return res.json(created)
  })

  app.get("/api/calendars", requireAuth, async (req, res) => {
    const calendars = await fixtures.mocks.auth.listCalendars(req.user!.id)
    return res.json(calendars)
  })

  app.get("/api/tasks", requireAuth, createGetTasksHandler(fixtures.mocks.task as never))
  app.post(
    "/api/tasks",
    requireAuth,
    createPostTasksHandler(fixtures.mocks.task as never, () => "http://localhost:5000"),
  )
  app.patch(
    "/api/tasks/:id",
    requireAuth,
    createPatchTaskHandler(fixtures.mocks.task as never),
  )
  app.post(
    "/api/tasks/reorder",
    requireAuth,
    createReorderTasksHandler(fixtures.mocks.task as never),
  )
  app.post(
    "/api/tasks/bulk-complete",
    requireAuth,
    createBulkCompleteTasksHandler(fixtures.mocks.task as never),
  )
  app.post(
    "/api/tasks/reschedule-all",
    requireAuth,
    createRescheduleAllTasksHandler(fixtures.mocks.task as never),
  )
  app.post(
    "/api/tasks/reload",
    requireAuth,
    createReloadTasksHandler(fixtures.mocks.task as never),
  )
  app.post(
    "/api/tasks/:id/complete",
    requireAuth,
    createCompleteTaskHandler(fixtures.mocks.task as never),
  )
  app.post(
    "/api/tasks/:id/reschedule",
    requireAuth,
    createRescheduleTaskHandler(fixtures.mocks.task as never),
  )

  app.get("/action/:token", createActionPageHandler(fixtures.mocks.action as never))
  app.post(
    "/api/action/:token",
    requireAuth,
    createApiActionHandler(fixtures.mocks.action as never, () => "http://localhost:5000"),
  )

  return app
}

export async function createIntegrationHttpServer(fixtures: Fixtures): Promise<Server> {
  const app = createIntegrationApp(fixtures)
  const server = createServer(app)

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  return server
}
