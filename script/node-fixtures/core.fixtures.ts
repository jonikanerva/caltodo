// Writes the Node-generated fixtures that need no module mocks:
//
// - crates/server/tests/fixtures/node/token_crypto.vectors.json
// - crates/server/tests/fixtures/node/action_tokens.vectors.json
// - crates/server/tests/fixtures/schema/drizzle_schema.snapshot.json
//
// The values come from the real Node modules (server/crypto.ts,
// server/tokens.ts, and the Drizzle migrator in
// server/db.ts). The keys are synthetic test keys, never production keys.
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => {
  const values = {
    TOKEN_ENCRYPTION_KEY: "fixture-token-encryption-key-0123456789abcdef",
    ACTION_TOKEN_SECRET: "fixture-action-token-secret-0123456789abcdef",
    SESSION_SECRET: "fixture-session-secret-0123456789abcdef-xyz",
    DATABASE_URL:
      process.env.FIXTURE_DATABASE_URL ??
      "postgres://postgres:postgres@127.0.0.1:55439/postgres",
  }
  Object.assign(process.env, values)
  return values
})

import { decryptToken, encryptToken } from "../../server/crypto"
import { createActionToken, getActionToken } from "../../server/tokens"
import { storage } from "../../server/storage"

const ROOT = path.resolve(import.meta.dirname, "..", "..")

function writeJson(relative: string, value: unknown): void {
  const file = path.join(ROOT, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe("node fixtures", () => {
  it("writes the token encryption vectors", () => {
    const plaintexts = [
      "ya29.a0AfH6SMBx-synthetic-access-token",
      "1//0gSynthetic-refresh-token_ABCdef-123",
      "a",
      "unicode: äöå ✅ ☑️",
      "x".repeat(2048),
    ]
    const encrypted = plaintexts.map((plaintext) => {
      const stored = encryptToken(plaintext)
      expect(typeof stored).toBe("string")
      expect(decryptToken(stored)).toBe(plaintext)
      return { plaintext, stored }
    })

    const sample = encrypted[0].stored as string
    const [prefix, version, iv, tag, cipher] = sample.split(":")
    const flip = (value: string) => (value[0] === "A" ? "B" : "A") + value.slice(1)
    const decryptCases = [
      { name: "legacy plaintext passes through", stored: "ya29.legacy-plaintext" },
      { name: "empty string passes through", stored: "" },
      { name: "prefix only", stored: "enc:v1:" },
      { name: "four parts", stored: `${prefix}:${version}:${iv}:${tag}` },
      { name: "six parts", stored: `${sample}:extra` },
      {
        name: "short iv",
        stored: `${prefix}:${version}:${iv.slice(2)}:${tag}:${cipher}`,
      },
      {
        name: "short tag",
        stored: `${prefix}:${version}:${iv}:${tag.slice(2)}:${cipher}`,
      },
      {
        name: "tampered ciphertext",
        stored: `${prefix}:${version}:${iv}:${tag}:${flip(cipher)}`,
      },
      {
        name: "tampered tag",
        stored: `${prefix}:${version}:${iv}:${flip(tag)}:${cipher}`,
      },
      {
        name: "tampered iv",
        stored: `${prefix}:${version}:${flip(iv)}:${tag}:${cipher}`,
      },
      { name: "other version passes through", stored: `enc:v2:${iv}:${tag}:${cipher}` },
      {
        name: "upper-case prefix passes through",
        stored: `ENC:v1:${iv}:${tag}:${cipher}`,
      },
      {
        name: "padded base64 iv",
        stored: `${prefix}:${version}:${iv}==:${tag}:${cipher}`,
      },
      { name: "empty ciphertext", stored: `${prefix}:${version}:${iv}:${tag}:` },
    ].map((entry) => ({ ...entry, decrypted: decryptToken(entry.stored) ?? null }))

    writeJson("crates/server/tests/fixtures/node/token_crypto.vectors.json", {
      source: "server/crypto.ts (Node) at the commit that adds this file",
      key: env.TOKEN_ENCRYPTION_KEY,
      encrypted,
      decrypt: decryptCases,
    })
  })

  it("writes the action token vectors", async () => {
    const created: Array<{ tokenHash: string; expiresAt: Date }> = []
    const lookups: string[] = []
    const mutableStorage = storage as unknown as Record<string, unknown>
    mutableStorage.createActionToken = async (token: {
      tokenHash: string
      expiresAt: Date
    }) => {
      created.push(token)
      return { ...token, id: `id-${created.length}` }
    }
    mutableStorage.getActionTokenByHash = async (hash: string) => {
      lookups.push(hash)
      return undefined
    }

    const generated = []
    for (let index = 0; index < 4; index++) {
      const before = Date.now()
      const result = await createActionToken("user-1", `event-${index}`, "primary")
      const record = created[created.length - 1]
      expect(result.tokenHash).toBe(record.tokenHash)
      expect(Buffer.from(result.token, "base64url")).toHaveLength(32)
      const expiryMs = record.expiresAt.getTime() - before
      expect(expiryMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000)
      expect(expiryMs).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 5000)
      generated.push({ token: result.token, tokenHash: result.tokenHash })
    }

    const fixedTokens = ["", "a", "AAAA", "not base64url ä", "x".repeat(300)]
    const hashed = []
    for (const token of fixedTokens) {
      lookups.length = 0
      await getActionToken(token)
      hashed.push({ token, tokenHash: lookups[0] ?? null })
    }

    writeJson("crates/server/tests/fixtures/node/action_tokens.vectors.json", {
      source: "server/tokens.ts (Node) at the commit that adds this file",
      secret: env.ACTION_TOKEN_SECRET,
      expiryMs: 7 * 24 * 60 * 60 * 1000,
      generated,
      hashed,
    })
  })

  it("writes the Drizzle schema snapshot", async () => {
    const { pool, runMigrations } = await import("../../server/db")
    await runMigrations()
    const query = readFileSync(
      path.join(ROOT, "crates/server/tests/fixtures/schema/schema_snapshot.sql"),
      "utf8",
    )
    const snapshot = await pool.query(query)
    const ledger = await pool.query(
      'SELECT id, hash, created_at::text AS created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id',
    )
    const ledgerColumns = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
        ORDER BY ordinal_position`,
    )
    const version = await pool.query("SHOW server_version")
    await pool.end()
    writeJson("crates/server/tests/fixtures/schema/drizzle_schema.snapshot.json", {
      source:
        "server/db.ts runMigrations (Node, drizzle-orm migrator) on an empty database at the commit that adds this file",
      postgres: version.rows[0].server_version,
      snapshot: JSON.parse(snapshot.rows[0].snapshot),
      drizzleLedger: ledger.rows,
      drizzleLedgerColumns: ledgerColumns.rows,
    })
  })
})
