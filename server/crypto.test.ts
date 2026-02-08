import { describe, expect, it, vi } from "vitest"

// Mock the config module before importing crypto
vi.mock("./config", () => ({
  tokenEncryptionKey: "test-encryption-key-at-least-32-chars-long",
}))

import { encryptToken, decryptToken } from "./crypto"

describe("encryptToken", () => {
  it("returns undefined for undefined input", () => {
    expect(encryptToken(undefined)).toBeUndefined()
  })

  it("returns null for null input", () => {
    expect(encryptToken(null)).toBeNull()
  })

  it("returns empty string for empty string input", () => {
    expect(encryptToken("")).toBe("")
  })

  it("returns already encrypted values unchanged", () => {
    const alreadyEncrypted = "enc:v1:abc:def:ghi"
    expect(encryptToken(alreadyEncrypted)).toBe(alreadyEncrypted)
  })

  it("encrypts a plain token with correct format", () => {
    const plainToken = "my-secret-access-token"
    const encrypted = encryptToken(plainToken)

    expect(encrypted).toBeDefined()
    expect(encrypted).not.toBe(plainToken)
    expect(encrypted).toMatch(/^enc:v1:[^:]+:[^:]+:[^:]+$/)
  })

  it("produces unique ciphertext for same input (random IV)", () => {
    const plainToken = "same-token"
    const encrypted1 = encryptToken(plainToken)
    const encrypted2 = encryptToken(plainToken)

    expect(encrypted1).not.toBe(encrypted2)
  })
})

describe("decryptToken", () => {
  it("returns undefined for undefined input", () => {
    expect(decryptToken(undefined)).toBeUndefined()
  })

  it("returns null for null input", () => {
    expect(decryptToken(null)).toBeNull()
  })

  it("returns empty string for empty string input", () => {
    expect(decryptToken("")).toBe("")
  })

  it("returns non-encrypted values as-is", () => {
    const plainValue = "plain-token-without-prefix"
    expect(decryptToken(plainValue)).toBe(plainValue)
  })

  it("returns null for malformed encrypted string (wrong part count)", () => {
    expect(decryptToken("enc:v1:only:two")).toBeNull()
    expect(decryptToken("enc:v1:too:many:parts:here")).toBeNull()
  })

  it("returns null for invalid IV length", () => {
    const badIv = Buffer.from("short").toString("base64url")
    const validTag = Buffer.alloc(16).toString("base64url")
    const validCipher = Buffer.from("ciphertext").toString("base64url")
    expect(decryptToken(`enc:v1:${badIv}:${validTag}:${validCipher}`)).toBeNull()
  })

  it("returns null for invalid auth tag length", () => {
    const validIv = Buffer.alloc(12).toString("base64url")
    const badTag = Buffer.from("short").toString("base64url")
    const validCipher = Buffer.from("ciphertext").toString("base64url")
    expect(decryptToken(`enc:v1:${validIv}:${badTag}:${validCipher}`)).toBeNull()
  })

  it("returns null for tampered ciphertext", () => {
    const plainToken = "my-secret-token"
    const encrypted = encryptToken(plainToken)!
    const parts = encrypted.split(":")
    parts[4] = "tamperedciphertext"
    const tampered = parts.join(":")

    expect(decryptToken(tampered)).toBeNull()
  })

  it("returns null for tampered auth tag", () => {
    const plainToken = "my-secret-token"
    const encrypted = encryptToken(plainToken)!
    const parts = encrypted.split(":")
    parts[3] = Buffer.alloc(16).fill(0).toString("base64url")
    const tampered = parts.join(":")

    expect(decryptToken(tampered)).toBeNull()
  })
})

describe("encrypt/decrypt roundtrip", () => {
  const testCases = [
    "simple-token",
    "token-with-special-chars-!@#$%^&*()",
    "unicode-token-🔐🔑",
    "a".repeat(1000),
    "short",
    "ya29.a0AfH6SMBx...",
  ]

  it.each(testCases)("roundtrips: %s", (token) => {
    const encrypted = encryptToken(token)
    const decrypted = decryptToken(encrypted)
    expect(decrypted).toBe(token)
  })

  it("handles OAuth-like tokens", () => {
    const accessToken = "ya29.a0AfH6SMBxDHzYkLkVwNqTkX9GjD5j2kR1234567890abcdefghij"
    const refreshToken = "1//0gX9P8NqYzABCDEFghijKLMNopqrstuvwxyz1234567890"

    expect(decryptToken(encryptToken(accessToken))).toBe(accessToken)
    expect(decryptToken(encryptToken(refreshToken))).toBe(refreshToken)
  })
})
