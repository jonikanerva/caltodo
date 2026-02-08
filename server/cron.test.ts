import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const schedules: { expression: string; task: () => Promise<void> | void }[] = []
  return {
    schedules,
    schedule: vi.fn((expression: string, task: () => Promise<void> | void) => {
      schedules.push({ expression, task })
      return { stop: vi.fn() }
    }),
    getUserSettings: vi.fn(),
    rescheduleAllUserTasks: vi.fn(),
    cleanupActionTokens: vi.fn(),
    selectFromUsers: vi.fn(),
  }
})

vi.mock("node-cron", () => ({
  default: {
    schedule: mocks.schedule,
  },
}))

vi.mock("./storage", () => ({
  storage: {
    getUserSettings: mocks.getUserSettings,
    cleanupActionTokens: mocks.cleanupActionTokens,
  },
}))

vi.mock("./calendar", () => ({
  rescheduleAllUserTasks: mocks.rescheduleAllUserTasks,
}))

vi.mock("./db", () => ({
  db: {
    select: () => ({
      from: mocks.selectFromUsers,
    }),
  },
}))

vi.mock("@shared/schema", () => ({
  users: {},
}))

import { setupCronJobs } from "./cron"

describe("setupCronJobs", () => {
  beforeEach(() => {
    mocks.schedules.length = 0
    vi.clearAllMocks()
  })

  it("registers midnight reschedule and daily token cleanup jobs", () => {
    setupCronJobs("http://localhost:5000")
    const expressions = mocks.schedules.map((entry) => entry.expression)
    expect(expressions).toEqual(["0 0 * * *", "15 1 * * *"])
  })

  it("reschedules tasks only for users with configured calendars", async () => {
    mocks.selectFromUsers.mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }])
    mocks.getUserSettings
      .mockResolvedValueOnce({ calendarId: "primary" })
      .mockResolvedValueOnce({ calendarId: null })

    setupCronJobs("http://localhost:5000")
    await mocks.schedules[0].task()

    expect(mocks.getUserSettings).toHaveBeenCalledTimes(2)
    expect(mocks.rescheduleAllUserTasks).toHaveBeenCalledTimes(1)
    expect(mocks.rescheduleAllUserTasks).toHaveBeenCalledWith("u1")
  })
})
