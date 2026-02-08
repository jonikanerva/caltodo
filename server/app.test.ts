import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runMigrations: vi.fn(),
  registerRoutes: vi.fn(),
  serveStatic: vi.fn(),
}))

vi.mock("./db", () => ({
  runMigrations: mocks.runMigrations,
}))

vi.mock("./routes", () => ({
  registerRoutes: mocks.registerRoutes,
}))

vi.mock("./static", () => ({
  serveStatic: mocks.serveStatic,
}))

import { configureApp, createApp } from "./app"

describe("app bootstrap", () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    process.env.NODE_ENV = "production"
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it("creates app context with server", () => {
    const context = createApp()
    expect(context.app).toBeDefined()
    expect(context.httpServer).toBeDefined()
    expect(context.isProduction).toBe(true)
  })

  it("runs migrations, registers routes, and serves static assets in production", async () => {
    const context = createApp()
    await configureApp(context)

    expect(mocks.runMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.registerRoutes).toHaveBeenCalledTimes(1)
    expect(mocks.registerRoutes).toHaveBeenCalledWith(context.httpServer, context.app)
    expect(mocks.serveStatic).toHaveBeenCalledTimes(1)
    expect(mocks.serveStatic).toHaveBeenCalledWith(context.app)
  })
})
