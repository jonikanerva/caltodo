import { afterEach, describe, expect, it, vi } from "vitest"

const ORIGINAL_ENV = { ...process.env }

async function loadConfigModule() {
  vi.resetModules()
  return import("./config")
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("config secrets", () => {
  it("throws when required secrets are missing", async () => {
    delete process.env.SESSION_SECRET
    delete process.env.ACTION_TOKEN_SECRET
    delete process.env.TOKEN_ENCRYPTION_KEY

    await expect(loadConfigModule()).rejects.toThrow(/SESSION_SECRET must be set/)
  })

  it("throws when session and action token secrets are equal", async () => {
    process.env.SESSION_SECRET = "a".repeat(32)
    process.env.ACTION_TOKEN_SECRET = "a".repeat(32)
    process.env.TOKEN_ENCRYPTION_KEY = "b".repeat(32)

    await expect(loadConfigModule()).rejects.toThrow(
      /SESSION_SECRET and ACTION_TOKEN_SECRET must be different/,
    )
  })

  it("exports secrets when values are valid", async () => {
    process.env.SESSION_SECRET = "a".repeat(32)
    process.env.ACTION_TOKEN_SECRET = "b".repeat(32)
    process.env.TOKEN_ENCRYPTION_KEY = "c".repeat(32)

    const config = await loadConfigModule()
    expect(config.sessionSecret).toHaveLength(32)
    expect(config.actionTokenSecret).toHaveLength(32)
    expect(config.tokenEncryptionKey).toHaveLength(32)
  })
})
