# Node fixtures

The Rust tests compare the Rust server with the Node server that it replaces (ADR 0001). The files below come from the real Node code. Never edit them by hand.

| File | Content | Generator |
| --- | --- | --- |
| `node/token_crypto.vectors.json` | AES-256-GCM token vectors (`server/crypto.ts`) | `core.fixtures.ts` |
| `node/action_tokens.vectors.json` | Action token and hash vectors (`server/tokens.ts`) | `core.fixtures.ts` |
| `node/naive_timestamps.golden.json` | How `server/storage.ts` (drizzle-orm 0.45.1) writes and reads the naive `action_tokens` timestamps with `TZ=Europe/Helsinki`: UTC wall-clock time | `naive-time.fixtures.ts` |
| `node/action_flow.golden.json` | Action page HTML and the action flow (`server/routes.ts`) | `action-flow.fixtures.ts` |
| `schema/drizzle_schema.snapshot.json` | Catalog snapshot after the Drizzle migrator | `core.fixtures.ts` |
| `schema/schema_snapshot.sql` | The catalog query of the snapshot | hand-written |
| `drizzle/` | The four Drizzle migrations of the Node server | copied from `migrations/` |
| `../../../domain/tests/fixtures/find_slot.golden.json` | Free-slot search cases (`server/calendar.ts`) | `scheduler.fixtures.ts` |
| `../../../domain/tests/fixtures/calendar.golden.json` | Event mapping, request bodies, reschedule and reorder scenarios | `calendar.fixtures.ts` |
| `../../../domain/tests/fixtures/node_time_zones.json` | The time zone names that Node `Intl` accepts | `intl.fixtures.ts` |

All keys and secrets in the fixtures are synthetic test values.

## Regenerate

The generators need the Node server code, which a later commit of the same change removes. Check out the commit that adds this file, then run the generators there:

```bash
git checkout "$(git log --diff-filter=A --format=%H -1 -- crates/server/tests/fixtures/README.md)"
pnpm install --frozen-lockfile
# A PostgreSQL database for the Drizzle snapshot (any empty database).
TZ=UTC FIXTURE_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55473/caltodo_fixtures \
  ./node_modules/.bin/vitest run --config script/node-fixtures/vitest.config.ts
```

`TZ=UTC` is required: the free-slot and the reschedule cases depend on the process time zone of the Node code. This run skips `naive-time.fixtures.ts`, which needs a zone with a UTC offset. Run it alone on an empty database:

```bash
TZ=Europe/Helsinki FIXTURE_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55473/caltodo_fixtures_tz \
  ./node_modules/.bin/vitest run --config script/node-fixtures/vitest.config.ts naive-time
```

The result shows that `TZ` does not change the stored values: drizzle-orm writes `Date.toISOString()` and reads `value + "+0000"` (`pg-core/columns/timestamp.js`), and its node-postgres session turns off the pg TIMESTAMP parser (`node-postgres/session.js`).

The generated free-slot cases differ from the Rust result in six documented cases, where the Node code did not stop or used a wrong weekday in a daylight-saving change (`crates/domain/tests/find_slot_golden.rs`, `DOCUMENTED_DIFFERENCES`).
