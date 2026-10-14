// Writes crates/domain/tests/fixtures/find_slot.golden.json: inputs and
// results of the Node `findSlotFromBusyIntervals` (server/scheduler.ts) and
// `getDurationMinutes`.
//
// scheduler.ts uses host-local `Date` setters, so its result depends on the
// process time zone. The generator runs with TZ=UTC and records it.
//
// - 640 random cases. Half of them fall in weeks with a daylight saving
//   time (DST) change in one of the zones.
// - Named regression cases that show known defects of the Node search: a
//   DST change on a weekday morning, and inputs where the search never
//   returns. A watchdog stops such a search and records `no_progress`.
import { mkdirSync, writeFileSync } from "fs"
import path from "path"
import { describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  Object.assign(process.env, {
    TOKEN_ENCRYPTION_KEY: "fixture-token-encryption-key-0123456789abcdef",
    ACTION_TOKEN_SECRET: "fixture-action-token-secret-0123456789abcdef",
    SESSION_SECRET: "fixture-session-secret-0123456789abcdef-xyz",
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  })
})

import { findSlotFromBusyIntervals, getDurationMinutes } from "../../server/scheduler"

const ROOT = path.resolve(import.meta.dirname, "..", "..")

// Deterministic pseudo-random numbers (mulberry32), so a rerun at the same
// commit writes the same cases.
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// findSlotFromBusyIntervals can loop without progress for some inputs. Each
// loop step formats the time with Intl, so a call budget on formatToParts
// stops such a loop. A 90-day search needs far fewer calls than the budget.
const NO_PROGRESS = Symbol("no_progress")
const FORMAT_CALL_BUDGET = 200_000

function withWatchdog<T>(run: () => T): T | typeof NO_PROGRESS {
  const prototype = Intl.DateTimeFormat.prototype
  const original = prototype.formatToParts
  let calls = 0
  prototype.formatToParts = function (this: Intl.DateTimeFormat, date) {
    calls++
    if (calls > FORMAT_CALL_BUDGET) {
      throw NO_PROGRESS
    }
    return original.call(this, date)
  }
  try {
    return run()
  } catch (error) {
    if (error === NO_PROGRESS) return NO_PROGRESS
    throw error
  } finally {
    prototype.formatToParts = original
  }
}

type Input = {
  name?: string
  timezone: string
  workStartHour: number
  workEndHour: number
  durationMinutes: number
  startMs: number
  searchEndMs: number
  busy: Array<[number, number]>
}

function run(id: number, input: Input) {
  const outcome = withWatchdog(() =>
    findSlotFromBusyIntervals(
      input.busy.map(([start, end]) => ({ start, end })),
      input.durationMinutes,
      {
        timezone: input.timezone,
        workStartHour: input.workStartHour,
        workEndHour: input.workEndHour,
      },
      new Date(input.startMs),
      new Date(input.searchEndMs),
    ),
  )
  return {
    id,
    ...input,
    expected:
      outcome === NO_PROGRESS
        ? "no_progress"
        : outcome
          ? [outcome.start.getTime(), outcome.end.getTime()]
          : null,
  }
}

// findFreeSlot: `searchEndDate.setDate(searchEndDate.getDate() + 90)`.
function ninetyDaysAfter(startMs: number): number {
  const end = new Date(startMs)
  end.setDate(end.getDate() + 90)
  return end.getTime()
}

describe("find-slot fixtures", () => {
  it("runs with the UTC process time zone", () => {
    expect(process.env.TZ).toBe("UTC")
    expect(new Date(0).getTimezoneOffset()).toBe(0)
  })

  it("writes the find-slot golden cases", () => {
    const zones = [
      "UTC",
      "Europe/Helsinki",
      "America/New_York",
      "America/Los_Angeles",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Australia/Lord_Howe",
      "Africa/Cairo",
    ]
    // Weeks that contain a DST transition in one of the zones above.
    const dstWeeks = [
      "2026-03-05T00:00:00Z", // America/* starts DST on Sunday 8 March
      "2026-03-26T00:00:00Z", // Europe/* starts DST on Sunday 29 March
      "2026-04-02T00:00:00Z", // Australia/Lord_Howe ends DST on Sunday 5 April
      "2026-04-21T00:00:00Z", // Africa/Cairo starts DST on Friday 24 April
      "2026-10-01T00:00:00Z", // Australia/Lord_Howe starts DST on Sunday 4 October
      "2026-10-22T00:00:00Z", // Europe/* ends DST on Sunday 25 October
      "2026-10-27T00:00:00Z", // Africa/Cairo ends DST on Thursday 29 October
      "2026-10-29T00:00:00Z", // America/* ends DST on Sunday 1 November
    ].map((iso) => Date.parse(iso))
    const durations = [1, 7, 15, 30, 45, 50, 60, 90, 120, 180, 240, 479, 480]
    const next = random(20261014)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
    const minute = 60 * 1000
    const day = 24 * 60 * minute

    const cases = []
    for (let id = 0; id < 640; id++) {
      const dstFocused = id % 2 === 1
      const timezone = dstFocused
        ? pick([
            "Europe/Helsinki",
            "America/New_York",
            "Australia/Lord_Howe",
            "Africa/Cairo",
          ])
        : pick(zones)
      const base = dstFocused
        ? pick(dstWeeks) + Math.floor(next() * 6 * day)
        : Date.parse("2026-01-01T00:00:00Z") + Math.floor(next() * 364 * day)
      // Random seconds and milliseconds exercise the quarter-hour rounding.
      const startMs = base + Math.floor(next() * 60) * 1000 + Math.floor(next() * 1000)
      const edgeHours = next() < 0.2
      const workStartHour = edgeHours
        ? pick([0, 1, 2, 3, 22, 23])
        : pick([6, 7, 8, 9, 10])
      const workEndHour = edgeHours
        ? pick([0, 1, 4, 12, 23])
        : pick([15, 16, 17, 18, 20, 23])
      const durationMinutes = pick(durations)
      const shortSearch = next() < 0.15
      const searchEndMs = shortSearch
        ? startMs + Math.floor(next() * 3 * day)
        : ninetyDaysAfter(startMs)
      const busyCount = Math.floor(next() * 14)
      const busy: Array<[number, number]> = []
      for (let index = 0; index < busyCount; index++) {
        const aligned = next() < 0.6
        const offset = Math.floor(next() * 12 * day) - day
        const busyStart = aligned
          ? Math.floor((startMs + offset) / (15 * minute)) * 15 * minute
          : startMs + offset
        const length =
          next() < 0.1
            ? -Math.floor(next() * 60) * minute
            : (15 + Math.floor(next() * 600)) * minute
        busy.push([busyStart, busyStart + length])
      }
      cases.push(
        run(id, {
          timezone,
          workStartHour,
          workEndHour,
          durationMinutes,
          startMs,
          searchEndMs,
          busy,
        }),
      )
    }

    const at = (iso: string) => Date.parse(iso)
    const regressions: Input[] = [
      {
        // Israel starts DST on Friday 27 March 2026 at 02:00 (to 03:00).
        // At 01:00 local the search moves 8 hours ahead and lands on 10:00.
        name: "DST starts on a weekday before the work day (Asia/Jerusalem)",
        timezone: "Asia/Jerusalem",
        workStartHour: 9,
        workEndHour: 17,
        durationMinutes: 60,
        startMs: at("2026-03-26T23:00:00.000Z"),
        searchEndMs: ninetyDaysAfter(at("2026-03-26T23:00:00.000Z")),
        busy: [],
      },
      {
        name: "DST starts on a weekday just before the work day (Asia/Jerusalem, start 03:00)",
        timezone: "Asia/Jerusalem",
        workStartHour: 3,
        workEndHour: 17,
        durationMinutes: 30,
        startMs: at("2026-03-26T23:30:00.000Z"),
        searchEndMs: ninetyDaysAfter(at("2026-03-26T23:30:00.000Z")),
        busy: [],
      },
      {
        name: "Work start hour inside the DST gap (Asia/Jerusalem, start 02:00)",
        timezone: "Asia/Jerusalem",
        workStartHour: 2,
        workEndHour: 17,
        durationMinutes: 30,
        startMs: at("2026-03-26T23:30:00.000Z"),
        searchEndMs: ninetyDaysAfter(at("2026-03-26T23:30:00.000Z")),
        busy: [],
      },
      {
        name: "Busy event ends 20 seconds into a quarter hour",
        timezone: "UTC",
        workStartHour: 9,
        workEndHour: 17,
        durationMinutes: 15,
        startMs: at("2026-03-02T09:00:00.000Z"),
        searchEndMs: ninetyDaysAfter(at("2026-03-02T09:00:00.000Z")),
        busy: [[at("2026-03-02T09:00:00.000Z"), at("2026-03-02T09:30:20.000Z")]],
      },
      {
        name: "Busy event ends 20 seconds after a whole minute",
        timezone: "UTC",
        workStartHour: 9,
        workEndHour: 17,
        durationMinutes: 15,
        startMs: at("2026-03-02T09:00:00.000Z"),
        searchEndMs: ninetyDaysAfter(at("2026-03-02T09:00:00.000Z")),
        busy: [[at("2026-03-02T09:00:00.000Z"), at("2026-03-02T09:31:20.000Z")]],
      },
      {
        name: "Start in the first minute of a quarter hour rounds down",
        timezone: "UTC",
        workStartHour: 9,
        workEndHour: 17,
        durationMinutes: 30,
        startMs: at("2026-03-02T10:00:30.500Z"),
        searchEndMs: ninetyDaysAfter(at("2026-03-02T10:00:30.500Z")),
        busy: [],
      },
      {
        name: "Work hours that end before they start never fit",
        timezone: "Europe/Helsinki",
        workStartHour: 17,
        workEndHour: 9,
        durationMinutes: 30,
        startMs: at("2026-03-02T10:00:00.000Z"),
        searchEndMs: ninetyDaysAfter(at("2026-03-02T10:00:00.000Z")),
        busy: [],
      },
      {
        name: "Duration longer than the work day (Africa/Cairo, 00-00)",
        timezone: "Africa/Cairo",
        workStartHour: 0,
        workEndHour: 0,
        durationMinutes: 180,
        startMs: at("2026-04-20T10:00:00.000Z"),
        searchEndMs: ninetyDaysAfter(at("2026-04-20T10:00:00.000Z")),
        busy: [],
      },
    ]
    regressions.forEach((input, index) => cases.push(run(1000 + index, input)))

    const durationCases = [
      ["2026-03-02T10:00:00.000Z", "2026-03-02T10:45:00.000Z"],
      ["2026-03-02T10:00:00.000Z", "2026-03-02T10:00:29.999Z"],
      ["2026-03-02T10:00:00.000Z", "2026-03-02T10:00:30.000Z"],
      ["2026-03-02T10:00:00.000Z", "2026-03-02T10:00:00.000Z"],
      ["2026-03-02T10:00:00.000Z", "2026-03-02T09:00:00.000Z"],
      ["2026-03-02T10:00:00.000Z", "2026-03-03T10:00:00.000Z"],
    ].map(([start, end]) => ({
      startMs: Date.parse(start),
      endMs: Date.parse(end),
      minutes: getDurationMinutes(new Date(start), new Date(end)),
    }))

    const file = path.join(ROOT, "crates/domain/tests/fixtures/find_slot.golden.json")
    mkdirSync(path.dirname(file), { recursive: true })
    // One case per line keeps the file reviewable and small.
    const lines = cases.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")
    writeFileSync(
      file,
      [
        "{",
        `  "source": ${JSON.stringify(
          "server/scheduler.ts findSlotFromBusyIntervals (Node, TZ=UTC) at the commit that adds this file",
        )},`,
        `  "processTimeZone": "UTC",`,
        `  "durations": ${JSON.stringify(durationCases)},`,
        `  "cases": [\n${lines}\n  ]`,
        "}",
        "",
      ].join("\n"),
    )
  })
})
