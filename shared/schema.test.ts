import { describe, expect, it } from "vitest"
import { createTaskSchema, updateSettingsSchema } from "./schema"

describe("createTaskSchema", () => {
  it("accepts valid task payloads", () => {
    const parsed = createTaskSchema.parse({
      title: "Write tests",
      details: "Cover critical routes",
      urgent: true,
      duration: 60,
    })
    expect(parsed.title).toBe("Write tests")
    expect(parsed.urgent).toBe(true)
  })

  it("rejects empty titles", () => {
    const result = createTaskSchema.safeParse({
      title: "",
      urgent: false,
    })
    expect(result.success).toBe(false)
  })
})

describe("updateSettingsSchema", () => {
  it("accepts valid settings payloads", () => {
    const result = updateSettingsSchema.safeParse({
      calendarId: "primary",
      workStartHour: 9,
      workEndHour: 17,
      timezone: "America/New_York",
      defaultDuration: 30,
      eventColor: "1",
    })

    expect(result.success).toBe(true)
  })

  it("rejects invalid timezones", () => {
    const result = updateSettingsSchema.safeParse({
      calendarId: "primary",
      workStartHour: 9,
      workEndHour: 17,
      timezone: "Mars/Olympus",
      defaultDuration: 30,
      eventColor: "1",
    })

    expect(result.success).toBe(false)
  })
})
