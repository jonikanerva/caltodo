# ADR 0003: An SQLx baseline of the Drizzle schema, and naive timestamps

- Status: accepted; the revert to the Node server is superseded (update of 2026-10-19)
- Date: 2026-10-14

## Context

The production database has the schema of four Drizzle migrations. The Drizzle migrator keeps its ledger in `drizzle.__drizzle_migrations`. The Rust server uses SQLx 0.9 and its migrator, which keeps its ledger in `_sqlx_migrations`.

The table `action_tokens` has `timestamp` columns without a time zone (`expires_at`, `used_at`, `created_at`). The Node server wrote and read them through drizzle-orm 0.45.1, not through the `Date` conversion of node-postgres. drizzle-orm writes `Date.toISOString()` and reads `value + "+0000"` (`pg-core/columns/timestamp.js`), and its node-postgres session turns off the pg TIMESTAMP parser (`node-postgres/session.js`). PostgreSQL ignores the `Z` of the ISO literal for a `timestamp` column. So the stored value is UTC wall-clock time, and `TZ` has no effect on it. `created_at` comes from the column default `now()`. The Rust server does not read the `timestamp` column of `user_sessions` (connect-pg-simple owns it).

The first version of this ADR said that the values were wall-clock time in `TZ`. The independent review of PR #4 proved this wrong against the drizzle-orm source and a probe, and `crates/server/tests/fixtures/node/naive_timestamps.golden.json` now records the real Node behaviour with `TZ=Europe/Helsinki`.

The owner requires an additive schema change only, and a baseline that is idempotent and proven against Drizzle.

## Decision

1. `migrations/0001_baseline.sql` creates the Drizzle schema with idempotent statements (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and a guarded `ALTER TABLE` for the one named foreign key). On the production database it changes nothing. On an empty database it creates the same schema as the four Drizzle migrations.
2. `migrations/0002_app_sessions.sql` adds `app_sessions` (ADR 0002). No migration drops, renames, or changes a Drizzle object. The Drizzle ledger stays.
3. The proof is `crates/server/tests/integration/schema.rs`. It compares the catalog of an empty database after the SQLx migrations with a snapshot that the real Drizzle migrator of the Node code made (`crates/server/tests/fixtures/schema/`). It also runs the Drizzle files on a database with rows, then the SQLx migrations, and checks that every table, row, and ledger row stays the same.
4. Naive timestamps keep the Node meaning: UTC wall-clock time, always. The conversion (`naive_utc` in `crates/server/src/db/mod.rs`) has no zone setting, so no configuration can change it. `TZ` sets only the job times (00:00 and 01:15). Values have millisecond precision, like a `Date`. The test `naive_timestamps_are_utc_like_the_node_server_in_any_zone` (`storage.rs`) runs the services with the process zone `Europe/Helsinki` and compares the writes, the used mark, the reads, and the cleanup with the Node golden.
5. `caltodo migrate` applies the migrations. `caltodo serve` refuses a database without them. The release runs `migrate` first (ADR 0005).

## Alternatives

- **Convert the columns to `timestamptz`.** Rejected: not additive, and a revert to the Node server would read the values differently.
- **Mark the baseline as applied without running it.** Rejected: an empty database (tests, development, a restore into a new instance) would then have no schema.

## Consequences

- Before the release, compare the production schema with the snapshot (`STACK.md` §15). The baseline assumes that production has exactly the Drizzle schema.
- A change of `TZ` on Railway changes only the job times. It does not change the meaning of stored values.
- A revert to the Node server works on the existing database. It does not work on a new empty database that only SQLx set up: the Drizzle migration `0003` has no `IF NOT EXISTS`. ADR 0005 records this limit.
- Never edit a released migration. SQLx checks the checksum of each applied file.

## Update 2026-10-19: no revert to the Node server

The owner ended the Node rollback path on 2026-10-19 (issue #5, item 17). Migration `0003_drop_user_sessions.sql` drops the Node session table `user_sessions` (ADR 0005). The rejected alternative and the consequence about a revert to the Node server no longer apply. The naive timestamps keep their meaning (decision 4). The comparison of the production schema with the Drizzle snapshot was a check of the first release; after migration `0003`, the production schema is the Drizzle schema without `user_sessions`.
