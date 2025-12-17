import crypto from "crypto";
import { tokenEncryptionKey } from "./config";

const KEY = crypto.createHash("sha256").update(tokenEncryptionKey).digest();

export function encryptToken(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return value;
  if (value.startsWith("enc:v1:")) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptToken(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "" || !value.startsWith("enc:v1:")) {
    return value;
  }

  const parts = value.split(":");
  if (parts.length !== 5) {
    return null;
  }

  const [, , ivB64, tagB64, cipherB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const encrypted = Buffer.from(cipherB64, "base64url");

  // Enforce expected lengths: 12-byte IV, 16-byte tag
  if (iv.length !== 12 || tag.length !== 16) {
    return null;
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}
