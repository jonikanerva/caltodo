import crypto from "crypto"
import type { Request, Response, NextFunction } from "express"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export function ensureCsrfToken(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    return next(
      new Error("Session middleware must be initialized before CSRF protection"),
    )
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex")
  }

  next()
}

export function requireCsrfToken(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    return next()
  }

  const headerToken = req.get("x-csrf-token")
  const bodyToken =
    typeof (req.body as { csrfToken?: unknown } | undefined)?.csrfToken === "string"
      ? (req.body as { csrfToken: string }).csrfToken
      : undefined
  const sessionToken = req.session?.csrfToken

  const tokenToCheck = headerToken || bodyToken

  if (tokenToCheck && sessionToken && tokenToCheck === sessionToken) {
    return next()
  }

  res.status(403).json({ error: "Invalid CSRF token" })
}
