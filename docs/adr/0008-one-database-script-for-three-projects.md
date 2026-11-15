# ADR 0008: One database script for three projects, with automatic clean-up

- Status: accepted
- Date: 2026-11-15
- Extends: ADR 0006

## Context

ADR 0006 moved the local PostgreSQL servers into Apple `container` with `scripts/caltodo-pg`. mastofeed and spot-price made the same move at the same time, each with its own script. The three scripts differed in names, task names, passwords, version pins, signal handling, and clean-up. The owner wants one behaviour in the three repositories. The owner also wants the database to be invisible: `dev` and the test tasks start what they need, and old containers go away without a manual step.

## Decision

1. `scripts/db.sh` is byte-identical in caltodo, mastofeed, and spot-price. It replaces `scripts/caltodo-pg` and `scripts/sqlx-metadata`. `scripts/db-project.sh` holds the differences of each project: names, database names, the port range, TLS, and the project commands.
2. The commands that need the development container start it; the last one stops it at exit. `db:start` keeps it running until `db:stop`.
3. Every command that starts a container first removes the test containers of ended runs, and the development container and volume of removed checkouts. A checkout counts as removed only when git no longer lists it, its directory is gone, and its parent directory exists.
4. `CALTODO_PG_IMAGE` pins the tag and the digest (`postgres:18.7@sha256:…`), like the other two projects. The volume name keeps the major version.
5. Every container has a random password. The test containers get 2 CPUs and 1 GiB, like the other two projects.
6. `db:restore`, `db:clone`, and `db:reset` replace the development database and first write a non-empty database to `.tmp/db/backups/`. The next `dev` or `db:migrate` applies the migrations.
7. The environment variables follow the shared scheme: `CALTODO_DB_KEEP=failed|always`, `CALTODO_DB_MAX_TEST`, `CALTODO_DB_CPUS`, `CALTODO_DB_MEMORY`, and `CALTODO_DATABASE_URL` (`dev` with another database).
8. `.claude/settings.json` lists the database tasks in `sandbox.excludedCommands`, because the `container` tool needs XPC.

## Alternatives

- Keep three scripts and align only their interfaces: less work now, but the scripts drift again with each fix.
- A shared script in the agent-setup repository: one source, but the owner keeps agent-setup free of project test tooling.
- Keep the development data of removed checkouts until a manual clean-up: no data loss after a moved checkout, but the volumes pile up. Agent worktrees hold disposable data.
- A limit of test containers over all repositories of the Mac: the owner decided against it (2026-11-15). Each repository keeps its own limit of 4.

## Consequences

- A developer or an agent runs only `dev`, `db:migrate`, `test`, `test:e2e`, `sqlx:*`, or `verify`. The other `db:` tasks are optional tools.
- `db:recreate` and `db:reap` go away. The clean-up and the restart of a container whose port does not answer replace them.
- A moved checkout loses its development data. Use `db:dump` before the move.
- An older branch with `scripts/caltodo-pg` still works, but in a checkout that already has a password file it cannot connect with its fixed password; use `db:dump` and `db:restore`, or run that branch in another checkout. Its `db:reap -- --all` can delete a test container of a running new-script test, because the new containers have no `caltodo.pid` label.
- The old state directories `target/caltodo-pg/` and `~/.local/state/caltodo-pg/` are no longer used.

## Cost of reversal

Low. Restore `scripts/caltodo-pg` and the former tasks from git. No production data depends on this decision.

## Reassessment

When the container tool changes its CLI or networking in a way that breaks `scripts/db.sh`, or when the owner leaves the Apple silicon Mac.
