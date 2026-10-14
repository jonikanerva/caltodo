// Writes crates/server/tests/fixtures/node/naive_timestamps.golden.json: how
// the Node server (server/storage.ts through drizzle-orm and node-postgres)
// writes and reads the naive `timestamp` columns of `action_tokens` when the
// process time zone is not UTC.
//
// Run it alone with a non-UTC zone and an empty database:
//
//   TZ=Europe/Helsinki FIXTURE_DATABASE_URL=postgres://... pnpm exec vitest run \
//     --config script/node-fixtures/vitest.config.ts naive-time
//
// drizzle-orm 0.45.1 writes a `timestamp` column with `toISOString()` and
// reads it as `value + "+0000"` (pg-core/columns/timestamp.js), and its
// node-postgres session turns off the pg TIMESTAMP parser
// (node-postgres/session.js). So the stored wall-clock time is UTC whatever
// `TZ` is. This file records that behaviour from the real code.
import { mkdirSync, writeFileSync } from "fs"
import path from "path"
import { afterAll, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  Object.assign(process.env, {
    TOKEN_ENCRYPTION_KEY: "fixture-token-encryption-key-0123456789abcdef",
    ACTION_TOKEN_SECRET: "fixture-action-token-secret-0123456789abcdef",
    SESSION_SECRET: "fixture-session-secret-0123456789abcdef-xyz",
    DATABASE_URL:
      process.env.FIXTURE_DATABASE_URL ??
      "postgres://postgres:postgres@127.0.0.1:55473/caltodo_fixtures_tz",
  })
})

import { pool, runMigrations } from "../../server/db"
import { storage } from "../../server/storage"

const ROOT = path.resolve(import.meta.dirname, "..", "..")
const OUTPUT = "crates/server/tests/fixtures/node/naive_timestamps.golden.json"

afterAll(async () => {
  vi.useRealTimers()
  await pool.end()
})

describe("naive timestamps", () => {
  // The fixture is only meaningful in a zone with a UTC offset, so the run
  // of the other generators (TZ=UTC) skips it.
  it.skipIf(process.env.TZ !== "Europe/Helsinki")(
    "writes the naive timestamp fixture",
    async () => {
      expect(new Date("2026-02-02T10:00:00Z").getTimezoneOffset()).toBe(-120)

      await runMigrations()
      await pool.query("DELETE FROM action_tokens")
      await pool.query("DELETE FROM users WHERE id = 'naive-user'")
      await pool.query(
        "INSERT INTO users (id, google_id, email, display_name) VALUES ('naive-user', 'naive-sub', '', 'N')",
      )

      const text = async (hash: string) => {
        const result = await pool.query(
          "SELECT expires_at::text AS expires_at, used_at::text AS used_at FROM action_tokens WHERE token_hash = $1",
          [hash],
        )
        return result.rows[0] as { expires_at: string; used_at: string | null }
      }

      // Write: storage.createActionToken, then storage.markActionTokenUsed
      // with a fixed `new Date()`.
      const writes = []
      for (const [hash, instant] of [
        ["winter", "2026-02-02T10:00:00.123Z"],
        ["summer", "2026-07-02T10:00:00.000Z"],
      ] as const) {
        await storage.createActionToken({
          tokenHash: hash,
          userId: "naive-user",
          eventId: "event",
          calendarId: "primary",
          expiresAt: new Date(instant),
        })
        writes.push({ hash, expiresAt: instant, stored: (await text(hash)).expires_at })
      }
      const usedAt = "2026-02-03T08:15:00.456Z"
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date(usedAt))
      const winter = await storage.getActionTokenByHash("winter")
      await storage.markActionTokenUsed(winter!.id)
      vi.useRealTimers()
      const used = { hash: "winter", usedAt, stored: (await text("winter")).used_at }

      // Read: values stored as text, read through storage.getActionTokenByHash.
      const reads = []
      for (const [hash, literal] of [
        ["read-winter", "2026-02-02 10:00:00.123"],
        ["read-gap", "2026-03-29 03:30:00"],
        ["read-overlap", "2026-10-25 03:30:00"],
      ] as const) {
        await pool.query(
          "INSERT INTO action_tokens (token_hash, user_id, event_id, calendar_id, expires_at) VALUES ($1, 'naive-user', 'event', 'primary', $2::timestamp)",
          [hash, literal],
        )
        const record = await storage.getActionTokenByHash(hash)
        reads.push({ hash, stored: literal, expiresAt: record!.expiresAt.toISOString() })
      }

      // Cleanup: storage.cleanupActionTokens compares with UTC values.
      const cleanupNow = "2026-07-02T09:30:00.000Z"
      const usedBefore = "2026-02-03T07:00:00.000Z"
      await storage.cleanupActionTokens(new Date(cleanupNow), new Date(usedBefore))
      const left = await pool.query(
        "SELECT token_hash FROM action_tokens WHERE token_hash IN ('winter', 'summer') ORDER BY token_hash",
      )

      const file = path.join(ROOT, OUTPUT)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            source:
              "server/storage.ts (Node, drizzle-orm 0.45.1, pg) with TZ=Europe/Helsinki at the commit that adds this file",
            tz: process.env.TZ,
            writes,
            used,
            reads,
            cleanup: {
              now: cleanupNow,
              usedBefore,
              left: left.rows.map((row: { token_hash: string }) => row.token_hash),
            },
          },
          null,
          2,
        )}\n`,
      )
    },
  )
})
