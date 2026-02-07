import crypto from "crypto"
import { actionTokenSecret } from "./config"
import { storage } from "./storage"

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const TOKEN_BYTES = 32

export type ActionTokenPayload = {
  id: string
  userId: string
  eventId: string
  calendarId: string
  expiresAt: Date
}

export type CreatedActionToken = {
  id: string
  token: string
  tokenHash: string
}

function hashToken(token: string): string {
  return crypto.createHmac("sha256", actionTokenSecret).update(token).digest("hex")
}

export async function createActionToken(
  userId: string,
  eventId: string,
  calendarId: string,
): Promise<CreatedActionToken> {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url")
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS)

  const record = await storage.createActionToken({
    tokenHash,
    userId,
    eventId,
    calendarId,
    expiresAt,
  })

  return { id: record.id, token: rawToken, tokenHash }
}

export async function getActionToken(token: string): Promise<ActionTokenPayload | null> {
  if (!token) return null
  const tokenHash = hashToken(token)
  const record = await storage.getActionTokenByHash(tokenHash)
  if (!record) return null
  if (record.usedAt) return null
  const expiresAt =
    record.expiresAt instanceof Date ? record.expiresAt : new Date(record.expiresAt)
  if (!Number.isFinite(expiresAt.getTime())) return null
  if (expiresAt.getTime() <= Date.now()) return null

  return {
    id: record.id,
    userId: record.userId,
    eventId: record.eventId,
    calendarId: record.calendarId,
    expiresAt,
  }
}

export async function consumeActionToken(
  token: string,
  expectedUserId?: string,
): Promise<ActionTokenPayload | null> {
  const record = await getActionToken(token)
  if (!record) return null
  if (expectedUserId && record.userId !== expectedUserId) return null
  const updated = await storage.markActionTokenUsed(record.id)
  if (!updated) return null
  return record
}
