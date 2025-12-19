import crypto from "crypto";
import { actionTokenSecret } from "./config";
const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000;

export function generateActionToken(
  userId: string,
  eventId: string,
  action: "complete" | "reschedule"
): string {
  const payload = {
    userId,
    eventId,
    action,
    exp: Date.now() + TOKEN_EXPIRY,
  };
  
  const data = JSON.stringify(payload);
  const encoded = Buffer.from(data).toString("base64url");
  const signature = crypto
    .createHmac("sha256", actionTokenSecret)
    .update(encoded)
    .digest("base64url");
  
  return `${encoded}.${signature}`;
}

export function verifyActionToken(
  token: string
): { userId: string; eventId: string; action: "complete" | "reschedule" } | null {
  try {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return null;
    
    const expectedSignature = crypto
      .createHmac("sha256", actionTokenSecret)
      .update(encoded)
      .digest("base64url");
    
    if (signature !== expectedSignature) return null;
    
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString());
    
    if (data.exp < Date.now()) return null;
    
    return { userId: data.userId, eventId: data.eventId, action: data.action };
  } catch {
    return null;
  }
}
