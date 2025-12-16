import crypto from "crypto";

const SECRET = process.env.SESSION_SECRET || "caltodo-action-token-secret";
const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000;

export function generateActionToken(taskId: string, action: "complete" | "reschedule"): string {
  const payload = {
    taskId,
    action,
    exp: Date.now() + TOKEN_EXPIRY,
  };
  
  const data = JSON.stringify(payload);
  const encoded = Buffer.from(data).toString("base64url");
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");
  
  return `${encoded}.${signature}`;
}

export function verifyActionToken(token: string): { taskId: string; action: "complete" | "reschedule" } | null {
  try {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return null;
    
    const expectedSignature = crypto
      .createHmac("sha256", SECRET)
      .update(encoded)
      .digest("base64url");
    
    if (signature !== expectedSignature) return null;
    
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString());
    
    if (data.exp < Date.now()) return null;
    
    return { taskId: data.taskId, action: data.action };
  } catch {
    return null;
  }
}
