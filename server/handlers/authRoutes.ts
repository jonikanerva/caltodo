import type { RequestHandler } from "express"
import passport from "passport"
import { GOOGLE_OAUTH_SCOPES } from "../auth"
import { listCalendars } from "../calendar"
import { storage } from "../storage"
import { updateSettingsSchema } from "@shared/schema"
import { clearSessionCookie } from "./common"

type DeleteAccountRouteDeps = {
  deleteUserData: typeof storage.deleteUserData
}

type SettingsRouteDeps = {
  getUserSettings: typeof storage.getUserSettings
  updateUserSettings: typeof storage.updateUserSettings
  createUserSettings: typeof storage.createUserSettings
}

type CalendarsRouteDeps = {
  listCalendars: typeof listCalendars
}

const defaultDeleteAccountRouteDeps: DeleteAccountRouteDeps = {
  deleteUserData: storage.deleteUserData.bind(storage),
}

const defaultSettingsRouteDeps: SettingsRouteDeps = {
  getUserSettings: storage.getUserSettings.bind(storage),
  updateUserSettings: storage.updateUserSettings.bind(storage),
  createUserSettings: storage.createUserSettings.bind(storage),
}

const defaultCalendarsRouteDeps: CalendarsRouteDeps = {
  listCalendars,
}

export function createAuthGoogleStartHandler(
  authenticate: typeof passport.authenticate = passport.authenticate.bind(passport),
  scopes: string[] = GOOGLE_OAUTH_SCOPES,
): RequestHandler {
  return (req, res, next) => {
    const actionToken =
      typeof req.query.actionToken === "string" ? req.query.actionToken : null
    if (actionToken && req.session) {
      req.session.pendingActionToken = actionToken
    }

    return authenticate("google", {
      scope: scopes,
      accessType: "offline",
      prompt: "consent",
    })(req, res, next)
  }
}

export function createAuthGoogleCallbackAuthHandler(
  authenticate: typeof passport.authenticate = passport.authenticate.bind(passport),
): RequestHandler {
  return authenticate("google", { failureRedirect: "/" })
}

export function createAuthGoogleCallbackSuccessHandler(): RequestHandler {
  return (req, res) => {
    const pendingActionToken = req.session?.pendingActionToken
    if (pendingActionToken) {
      delete req.session.pendingActionToken
      return res.redirect(`/action/${encodeURIComponent(pendingActionToken)}`)
    }
    res.redirect("/")
  }
}

export function createAuthUserHandler(): RequestHandler {
  return (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" })
    }
    const { id, googleId, email, displayName } = req.user
    res.json({ id, googleId, email, displayName, csrfToken: req.session?.csrfToken })
  }
}

export function createAuthLogoutHandler(): RequestHandler {
  return (req, res) => {
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
  }
}

export function createDeleteAccountHandler(
  deps: DeleteAccountRouteDeps = defaultDeleteAccountRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      await deps.deleteUserData(req.user!.id)
    } catch (error) {
      console.error("Error deleting user data:", error)
      return res.status(500).json({ error: "Failed to delete user data" })
    }

    req.logout((err) => {
      if (err) {
        console.error("Logout error after deletion:", err)
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
  }
}

export function createGetSettingsHandler(
  deps: SettingsRouteDeps = defaultSettingsRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const settings = await deps.getUserSettings(req.user!.id)
      res.json(settings || null)
    } catch {
      res.status(500).json({ error: "Failed to get settings" })
    }
  }
}

export function createPatchSettingsHandler(
  deps: SettingsRouteDeps = defaultSettingsRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      const data = updateSettingsSchema.parse(req.body)
      let settings = await deps.getUserSettings(req.user!.id)

      if (settings) {
        settings = await deps.updateUserSettings(req.user!.id, data)
      } else {
        settings = await deps.createUserSettings({
          userId: req.user!.id,
          ...data,
        })
      }

      res.json(settings)
    } catch (error) {
      console.error("Error updating settings:", error)
      res.status(400).json({ error: "Invalid settings data" })
    }
  }
}

export function createGetCalendarsHandler(
  deps: CalendarsRouteDeps = defaultCalendarsRouteDeps,
): RequestHandler {
  return async (req, res) => {
    try {
      console.log("Fetching calendars for user:", req.user!.id)
      const calendars = await deps.listCalendars(req.user!.id)
      console.log("Calendars found:", calendars.length)
      res.json(calendars)
    } catch (error) {
      console.error("Error fetching calendars:", error)
      res.status(500).json({ error: "Failed to list calendars" })
    }
  }
}
