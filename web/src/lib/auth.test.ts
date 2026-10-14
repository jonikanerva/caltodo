import { afterEach, describe, expect, it, vi } from "vitest"

const apiClient = vi.hoisted(() => ({ logout: vi.fn() }))

vi.mock("@caltodo/api-client", async (original) => ({
  ...(await original<typeof import("@caltodo/api-client")>()),
  logout: apiClient.logout,
}))

import { ApiError } from "@caltodo/api-client"
import { loginWithGoogle, logout } from "./auth"

const assign = vi.fn()

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("auth helpers", () => {
  it("starts the Google sign-in on the server", () => {
    vi.stubGlobal("location", { assign })
    loginWithGoogle()
    expect(assign).toHaveBeenCalledWith("/api/auth/google")
  })

  it("goes to the start page after the sign-out", async () => {
    vi.stubGlobal("location", { assign })
    apiClient.logout.mockResolvedValue({ success: true })
    await logout()
    expect(assign).toHaveBeenCalledWith("/")
  })

  it("goes to the start page when the server refuses the sign-out", async () => {
    vi.stubGlobal("location", { assign })
    apiClient.logout.mockRejectedValue(new ApiError(403, "csrf_rejected"))
    await logout()
    expect(assign).toHaveBeenCalledWith("/")
  })

  it("stays on the page when the network fails", async () => {
    vi.stubGlobal("location", { assign })
    apiClient.logout.mockRejectedValue(new TypeError("network down"))
    await expect(logout()).rejects.toThrow("network down")
    expect(assign).not.toHaveBeenCalled()
  })
})
