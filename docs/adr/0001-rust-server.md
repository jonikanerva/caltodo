# ADR 0001: The server is a Rust program

- Status: accepted; the revert to the Node server is superseded (update of 2026-10-19)
- Date: 2026-10-14

## Context

The server was a Node program: Express, Passport, Drizzle, and node-cron in TypeScript. It runs as one Railway service with a 500 MB memory limit.

- Railway's memory metric of the Node service over 7 days: 222 MB on average and 242 MB at the highest (resident memory).
- The owner selected the agent-setup profile `STACK-RUST.md` as the default stack for new work and for this port.
- The product (`VISION.md`) does not change. The users, the data, the API, and the screens stay the same.

## Decision

1. The server is a Rust workspace: `crates/domain` (pure scheduling, event, and task rules) and `crates/server` (Axum on a current-thread Tokio runtime, SQLx, reqwest, tower-sessions, Jiff, and tracing). `STACK.md` §2 and §6 list the crates and their reasons.
2. The port keeps the observable behaviour of the Node server: the routes, the success bodies, the action pages, the cookies, the stored data, the Google Calendar event format, and the job times. The exceptions are the decisions of ADR 0002 to ADR 0005 and the three owner-approved fixes (P3): an explicit error when a Google call fails in a task list, a calendar list, or a reschedule; `events.list` follows `nextPageToken` up to a fixed number of pages; and the free-slot search uses Jiff zoned arithmetic.
3. One binary has two subcommands. `caltodo migrate` applies the SQLx migrations. `caltodo serve` starts the web process with the in-process jobs. The release runs `migrate` before `serve` (ADR 0005).
4. Golden fixtures from the Node code prove the parity. The Node code generated them at the commit that adds `crates/*/tests/fixtures/`, before the removal of the Node server (`crates/server/tests/fixtures/README.md`).

## Alternatives

- **Keep the Node server and reduce its memory.** Rejected by the owner: the stack decision applies to the whole service.
- **A gradual port behind a proxy.** Rejected. Two servers would share the session and the database during the transition, and the service is small enough for one change.

## Consequences

- Memory: the local measurement of the release binary is in `STACK.md` §4. It is a laboratory value. Railway's metric after the release is the field value.
- The repository has two toolchains: Rust for the server, and Node for the web build and the tools. The production image contains no Node.
- Each user signs in again once, because the session store changes (ADR 0002).
- A revert to the Node server stays possible (ADR 0005).

## Cost of reversal

Medium. A revert of the merge commit restores the Node server and its build. The schema changes are additive, so the Node server can use the database after a revert (ADR 0003). The users sign in again once more.

## Reassessment

Reassess when the Rust server fails to build or to start on Railway, when Railway's memory metric is above the `STACK.md` §4 budget, or when a dependency in `STACK.md` §6 loses maintenance.

## Update 2026-10-19: no revert to the Node server

The owner ended the Node rollback path on 2026-10-19 (issue #5, item 17). Migration `0003_drop_user_sessions.sql` drops the Node session table `user_sessions` (ADR 0005). The consequence "A revert to the Node server stays possible" and the cost of reversal above no longer apply. A defective release is fixed with a new PR or a revert PR of the Rust change (`STACK.md` §15).
