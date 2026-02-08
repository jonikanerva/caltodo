import express from "express"
import fs from "fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { serveStatic } from "./static"

describe("serveStatic", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("throws when dist directory does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false)
    const app = { use: vi.fn() } as unknown as express.Express

    expect(() => serveStatic(app)).toThrow(/Could not find the build directory/)
  })

  it("registers static and fallback middleware when dist exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true)
    const staticMiddleware = vi.fn()
    vi.spyOn(express, "static").mockReturnValue(staticMiddleware as never)
    const app = { use: vi.fn() } as unknown as express.Express

    serveStatic(app)

    expect(app.use).toHaveBeenCalledTimes(2)
    expect(app.use).toHaveBeenNthCalledWith(1, staticMiddleware)
    expect(app.use).toHaveBeenNthCalledWith(2, "/{*path}", expect.any(Function))
  })
})
