import type { Response } from "express"
import { normalizeError } from "../errors"

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export function renderActionShell(title: string, body: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${escapeHtml(title)}</title>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 32px; }
        .card { max-width: 520px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08); }
        h1 { font-size: 20px; margin: 0 0 12px; }
        p { margin: 0 0 16px; color: #334155; }
        .actions { display: flex; gap: 12px; flex-wrap: wrap; }
        .actions form { margin: 0; }
        button, .button-link { background: #2563eb; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-size: 14px; cursor: pointer; text-decoration: none; display: inline-block; }
        button.secondary { background: #0f172a; }
        button:disabled { background: #94a3b8; cursor: not-allowed; }
        .status { margin-top: 16px; font-size: 14px; color: #475569; }
        .muted { color: #64748b; font-size: 13px; }
      </style>
    </head>
    <body>
      <div class="card">
        ${body}
      </div>
    </body>
    </html>
  `
}

export function getBaseUrl(): string {
  const normalize = (url: string | undefined): string | null => {
    if (!url) return null
    try {
      return new URL(url).origin
    } catch {
      return null
    }
  }

  const configuredOrigin =
    normalize(process.env.PRODUCTION_APP_URL) ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
  if (configuredOrigin) {
    return configuredOrigin
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PRODUCTION_APP_URL must be set in production to build trusted action links",
    )
  }

  return "http://localhost:5000"
}

export function readPathParam(params: unknown, key: string): string | null {
  if (!params || typeof params !== "object") {
    return null
  }

  const value = (params as Record<string, unknown>)[key]
  if (typeof value === "string") {
    return value
  }

  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0]
  }

  return null
}

const isProduction =
  process.env.NODE_ENV === "production" || !!process.env.PRODUCTION_APP_URL

export function clearSessionCookie(res: Response): void {
  res.clearCookie("connect.sid", {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: isProduction,
  })
}

export function sendApiError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
): Response {
  const normalized = normalizeError(error, fallbackMessage)
  return res.status(normalized.status).json({ error: normalized.message })
}
