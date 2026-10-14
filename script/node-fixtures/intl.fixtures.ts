// Writes crates/domain/tests/fixtures/node_time_zones.json: the time zone
// names that shared/schema.ts `updateSettingsSchema` accepted, that is
// `Intl.supportedValuesOf("timeZone")` of the Node runtime of this commit.
import { mkdirSync, writeFileSync } from "fs"
import path from "path"
import { expect, it } from "vitest"
import { updateSettingsSchema } from "@shared/schema"

it("writes the accepted time zone names", () => {
  const zones = Intl.supportedValuesOf("timeZone")
  const valid = {
    workStartHour: 9,
    workEndHour: 17,
    defaultDuration: 60,
    eventColor: "1",
  }
  for (const timezone of zones) {
    expect(updateSettingsSchema.safeParse({ ...valid, timezone }).success).toBe(true)
  }
  const rejected = [
    "",
    "Mars/Olympus",
    "utc",
    "America/new_york",
    "GMT+2",
    "UTC",
    "US/Eastern",
  ].filter((timezone) => !updateSettingsSchema.safeParse({ ...valid, timezone }).success)
  const file = path.join(
    path.resolve(import.meta.dirname, "..", ".."),
    "crates/domain/tests/fixtures/node_time_zones.json",
  )
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        source: `Intl.supportedValuesOf("timeZone") of Node ${process.version} (ICU ${process.versions.icu}, tz ${process.versions.tz})`,
        accepted: zones,
        rejectedSamples: rejected,
      },
      null,
      2,
    )}\n`,
  )
})
