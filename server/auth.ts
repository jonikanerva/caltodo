import passport from "passport"
import { Strategy as GoogleStrategy } from "passport-google-oauth20"
import session from "express-session"
import type { Express, RequestHandler } from "express"
import { storage } from "./storage"
import pgSession from "connect-pg-simple"
import { pool } from "./db"
import { sessionSecret } from "./config"

export const GOOGLE_OAUTH_SCOPES = [
  "profile",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
]

const PgSession = pgSession(session)

declare global {
  namespace Express {
    interface User {
      id: string
      googleId: string
      email: string
      displayName: string
      accessToken?: string | null
      refreshToken?: string | null
    }
  }
}

declare module "express-session" {
  interface SessionData {
    csrfToken?: string
    pendingActionToken?: string
  }
}

export function setupAuth(app: Express): void {
  // Trust proxy for secure cookies behind Replit's load balancer
  app.set("trust proxy", 1)

  const isProduction =
    process.env.NODE_ENV === "production" || !!process.env.PRODUCTION_APP_URL

  const sessionMiddleware = session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  })

  app.use(sessionMiddleware)
  app.use(passport.initialize())
  app.use(passport.session())

  // Priority: PRODUCTION_APP_URL (for deployed app) > REPLIT_DEV_DOMAIN (dev preview) > localhost
  const getAppOrigin = () => {
    if (process.env.PRODUCTION_APP_URL) {
      return process.env.PRODUCTION_APP_URL
    }
    if (process.env.REPLIT_DEV_DOMAIN) {
      return `https://${process.env.REPLIT_DEV_DOMAIN}`
    }
    return "http://localhost:5000"
  }

  const callbackURL = `${getAppOrigin()}/api/auth/google/callback`

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        callbackURL,
        passReqToCallback: true,
        state: true,
        scope: GOOGLE_OAUTH_SCOPES,
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const pendingActionToken = req.session?.pendingActionToken
          await new Promise<void>((resolve, reject) => {
            if (!req.session) {
              return reject(new Error("Session not initialized"))
            }
            req.session.regenerate((err) => (err ? reject(err) : resolve()))
          })
          if (pendingActionToken && req.session) {
            req.session.pendingActionToken = pendingActionToken
          }

          let user = await storage.getUserByGoogleId(profile.id)

          if (user) {
            user = await storage.updateUser(user.id, {
              accessToken,
              refreshToken: refreshToken || user.refreshToken,
            })
          } else {
            user = await storage.createUser({
              googleId: profile.id,
              email: profile.emails?.[0]?.value || "",
              displayName: profile.displayName || profile.emails?.[0]?.value || "User",
              accessToken,
              refreshToken,
            })

            await storage.createUserSettings({
              userId: user!.id,
              workStartHour: 9,
              workEndHour: 17,
              timezone: "America/New_York",
              defaultDuration: 60,
              eventColor: "1",
            })
          }

          done(null, user!)
        } catch (error) {
          done(error as Error)
        }
      },
    ),
  )

  passport.serializeUser((user, done) => {
    done(null, user.id)
  })

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id)
      done(null, user || undefined)
    } catch (error) {
      done(error)
    }
  })
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next()
  }
  res.status(401).json({ error: "Unauthorized" })
}
