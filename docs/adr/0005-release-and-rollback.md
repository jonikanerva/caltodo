# ADR 0005: Release and rollback of the Rust server

- Status: accepted; the Node rollback path is superseded (update of 2026-10-19)
- Date: 2026-10-14

## Context

Railway deploys the service from `main`. The Node service ran `pnpm run build:production` as a build command override in the Railway dashboard and started with `pnpm start`. The Node process applied the Drizzle migrations at startup.

The Rust server needs an explicit migration step (`STACK-RUST.md` §5), a new build (Rust and the web app), and a health check.

## Decision

1. `railpack.json` declares the build: the Rust provider, Node 24.21.0 and pnpm 12.8.1 for the web build, `pnpm install --frozen-lockfile --filter @caltodo/web...`, the web build, and `cargo build --release --locked --package caltodo` with `SQLX_OFFLINE=true`. The image contains only `bin/caltodo` and `web/build`.
2. The start command is `./bin/caltodo migrate && exec ./bin/caltodo serve`. Railpack runs it with `/bin/bash -c`, so `&&` and `exec` work, and `serve` gets the stop signal of Railway directly. A failed migration stops the start, and the previous deployment stays live.
3. The lead or the owner changes the Railway service settings at the release (they are not in the repository): remove the build command override `pnpm run build:production`, remove a start command override if one exists, and set the health check path to `/healthz`.
4. The environment variables stay the same. No new variable is required. `CALTODO_LOG_FORMAT` is optional.

## Release procedure

`STACK.md` §15 has the full list. In short:

1. Before the merge, run `crates/server/tests/fixtures/schema/schema_snapshot.sql` read-only on the production database. Compare the result with `crates/server/tests/fixtures/schema/drizzle_schema.snapshot.json`. Stop on a difference.
2. Record the production value of `TZ`. It sets only the job times (ADR 0003).
3. Change the Railway settings (decision 3), then merge.
4. After the deployment, check `/version`, `/healthz`, `/readyz`, one sign-in, one task list, and the security headers. Read Railway's memory metric.

## Rollback

- **Fast path:** roll back to the previous (Node) deployment in Railway. The schema changes are additive, so the Node server works on the same database. Its Drizzle migrator finds its ledger complete and does nothing. Users sign in again, because the Node server does not read `app_sessions`. Restore the build command override before the next Node build.
- **Revert:** revert the merge commit on a feature branch and merge it. Restore the Railway build command override `pnpm run build:production` first.
- **Limit:** the Node server cannot start on a new empty database that only the SQLx migrations set up (ADR 0003). A rollback on the existing production database is not affected.
- **Data:** the release deletes no data. Action links that the Node server wrote stay valid: the token format and the secret do not change.

## Consequences

- Each intermediate commit of the change is not a deployable state. Only the merge result is.
- Railpack gives every service variable to every build command, including the build scripts of dependencies (`STACK.md` §15 lists the compensating controls).

## Update 2026-10-19: the Node rollback path ends

The owner ended the Node rollback path (issue #5, item 17). Migration `0003_drop_user_sessions.sql` drops the Node session table `user_sessions`. The rollback section above no longer applies: the fast path to the Node deployment and the revert to the Node build are not recovery paths, and the limit on a new empty database has no effect.

- Recovery is a new PR or a revert PR on a feature branch (owner decision 2026-10-19). The Railway rollback button is not used after a release with a migration. The database has no backup: the owner uses the Railway Hobby plan, which has no database backups, and accepts the risk of data loss (`STACK.md` §5, §15).
- A Railway rollback works only to a deployment that knows every applied migration. `caltodo migrate` of an older release stops on a newer migration, and Railway keeps the current deployment live. After migration `0003`, a rollback to a deployment before it does not start.
- The release check of the production schema against the Drizzle snapshot does not apply after migration `0003`.
