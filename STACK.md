# STACK.md — Rust / Axum backend + TypeScript / React / Vite frontend profile

> A Rust service and a strict TypeScript SPA in one repository, served from one origin. Axum, Tokio, and Tower provide HTTP and concurrency. Utoipa exports OpenAPI 3.1; Hey API generates a TypeScript client with Zod validators. React, Vite, TanStack Router, and TanStack Query provide the browser application. Jiff represents time. PostgreSQL with SQLx keeps the durable data. One image contains the server binary and the built SPA files. **Normative** — MUST, MUST NOT, SHOULD, and MAY have the meanings in `DOCTRINE.md`; surface conflicts before deviating.
>
> This file adopts the agent-setup profile `stacks/STACK-RUST.md` (agent-setup commit `bebaca6`, 14 October 2026) with the project facts and the differences that §13 lists. The dependency freshness check (§3) and the infrastructure record (§15) come from the profile at agent-setup commit `74f4b3f` (15 October 2026), the version of `DOCTRINE.md` and `CLAUDE.md`. `DOCTRINE.md` defines P1–P9. `CLAUDE.md` defines agent operation and authority. This file gives their concrete application for this project.

---

## 0. Project shape

- **Project risk rationale:** real users sign in with Google and give the service write access to their Google Calendar. The server keeps their Google OAuth tokens (encrypted), their settings, action link tokens, and sessions in PostgreSQL. Railway deploys each merge to `main` (§15). The highest-risk surfaces are the OAuth tokens (a leak gives calendar access), the calendar writes (a defect can move or change many events of a user, and the nightly job does it for every user), and the schema (production data cannot be restored by a revert). Google API behaviour is the main external uncertainty.
- **Change risk:** assess the surfaces that each task affects against this rationale. A change to sign-in, sessions, token storage, the free-slot search, the reschedule job, the event format, or a migration is high risk. A risk label does not waive a required check or review.
- **Shape:** one Rust service and one browser SPA in a monorepo, served from one origin. The service also serves the server-rendered action pages (`/action/{token}`).
- **Critical execution paths:** server request decode, use case, the Google adapters, the free-slot search, and the response; the action link flow; the two daily jobs; browser route, API client facade, view, and render.
- **Applicable UI states:** loading (skeletons), success, empty list, no calendar selected, no free slot, Google unavailable (an error toast after an action; an alert in place of the task list when the list does not load), signed out (the sign-in page), and the action page states (confirm, done, invalid link, sign-in needed).
- **Product reason for Rust:** ADR 0001 (memory use and the owner's default stack).

### Repository layout and boundaries

```text
repo/
  crates/
    domain/src/          # caltodo-domain: event format, task order, free-slot search, settings rules
    domain/tests/        # golden tests against the Node fixtures
    server/src/          # caltodo: HTTP, application services, Google adapters, db, sessions, jobs, config, lifecycle
    server/tests/        # integration (router + PostgreSQL), lifecycle, fixtures/
    server/examples/     # e2e_server: the test server of the browser journeys
  migrations/            # SQLx migrations (0001 is the baseline of the Drizzle schema, ADR 0003)
  .sqlx/                 # committed SQLx query metadata
  packages/api-client/   # generated SDK, types, and Zod validators + a handwritten facade
  web/src/               # routes, pages, components, hooks, lib
  contract/openapi.json  # generated from the Rust routes and committed
  e2e/                   # Playwright and axe journeys (tests/); visual comparison tool (visual-compare/)
  docs/adr/              # architecture decisions
  Cargo.toml  Cargo.lock  rust-toolchain.toml  clippy.toml  deny.toml  mise.toml
  pnpm-workspace.yaml  pnpm-lock.yaml  railpack.json  .config/nextest.toml  .cargo/config.toml
  STACK.md  VISION.md  DOCTRINE.md  CLAUDE.md  AGENTS.md
```

- `domain` MUST NOT depend on Axum, Tokio, SQLx, reqwest, the server, or any I/O crate. It receives time and identifiers explicitly. Its own `crates/domain/clippy.toml` bans the ambient clock (`SystemTime`, `Instant`, `jiff::Timestamp::now`, `jiff::Zoned::now`, the system time zone), environment reads, file system access, and random sources.
- `server` owns effects, HTTP DTOs, the application services, the adapters, the public error mapping, configuration, and process wiring. Handlers decode input, call one service, and return its mapped result. `wiring.rs` is the composition root. The ports (`application/ports.rs`: `CalendarApi`, `OAuthApi`, `Clock`) are the replaceable boundaries; `fakes.rs` implements them for tests and the e2e server.
- `packages/api-client` owns the generated API artifacts and the facade. Generated files MUST NOT be edited by hand.
- `web` reaches the API only through `@caltodo/api-client`. In `web/src`, an Oxlint `no-restricted-globals` rule bans `fetch`, and a `no-restricted-imports` rule bans a deep import of the API client and a path import into `packages/`, `e2e/`, or `crates/`.
- Review-only gaps: `std::fs` functions and `std::io` streams that `clippy.toml` does not list, `env!` and `option_env!` (build time), and dependency internals. A dynamic `import()` with a computed path escapes the import rule. Other request forms (`window.fetch`, `XMLHttpRequest`, `navigator.sendBeacon`) need review.

---

## 1. Language & Runtime

### Backend

- **Language:** Rust 1.99.1, edition 2024, pinned in `rust-toolchain.toml` with rustfmt and Clippy. `[workspace.package]` declares `rust-version = "1.99"`; `crates/domain` inherits it, and `crates/server` repeats it (§13).
- **Runtime:** a native Linux binary in the Railway image (§15). The server uses a current-thread Tokio runtime. A local macOS build does not validate the Linux artifact.
- **Package manager:** Cargo with workspace dependency inheritance (`[workspace.dependencies]`, exact `=x.y.z` pins). `Cargo.lock` is committed; every Cargo command that supports it uses `--locked`. `.cargo/config.toml` sets `SQLX_OFFLINE=true`.
- **Strictness:** every crate has `[lints] workspace = true` with the lint set of the profile (`unsafe_code = "forbid"`, pedantic Clippy, `unwrap_used`, `expect_used`, `panic`, `print_*`, `allow_attributes` denied). Clippy runs with `-D warnings`. `clippy.toml` allows `unwrap`, `expect`, `panic`, and printing in tests. A justified lint limitation uses a narrow `#[expect(…, reason = "…")]`.

### Frontend

- **Language:** TypeScript 7.0.2 (catalog). The API-client generator keeps a scoped TypeScript 6.0.3 dependency (§13).
- **`tsconfig.base.json`:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `moduleDetection: "force"`. The generated client directory has one scoped exception (§13).
- **Lint:** Oxlint 1.88.0 `--type-aware --deny-warnings` with `oxlint-tsgolint` 7.0.2004 and `.oxlintrc.json`: the strict type-aware TypeScript rules, the React hook rules, and the import restrictions of §0.
- **Build-time runtime:** Node.js 24.22.0. Node runs the web build, the TypeScript tests, and the generator. The production image contains no Node.
- **Package manager:** pnpm 12.14.0 workspaces (`web`, `packages/*`, `e2e`), committed `pnpm-lock.yaml`, frozen-lockfile installs. `pmOnFail: error`, `minimumReleaseAge: 1440` (one day), and `minimumReleaseAgeStrict: true`.

### Provisioning

A fresh macOS machine needs mise, rustup, Docker (for the local PostgreSQL container), and the Xcode Command Line Tools, then `mise trust` and `mise run setup` in the repository root. `rust-toolchain.toml` owns the Rust version. `mise.toml` owns Node, pnpm, Gitleaks, cargo-deny, cargo-nextest, cargo-shear, and sqlx-cli. Mirrors change in the same commit: `.nvmrc`, `engines.node`, and `packageManager` in the root `package.json`, and the `packages` of `railpack.json`. `mise run setup` installs the pinned tools, the locked dependencies, and the Playwright Chromium build. `mise run db:start` starts the PostgreSQL 18 container `caltodo-pg` (volume `caltodo-pg-18`) on `127.0.0.1:55473`; the test tasks start it themselves. A container of another image is replaced; its volume and data stay.

---

## 2. Frameworks

| Concern                  | Technology                                           | Role                                                                   |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| HTTP                     | Axum, Tower, tower-http                              | Routing, extraction, middleware, and the static SPA files (`ServeDir`) |
| Concurrency              | Tokio (current-thread runtime)                       | Async I/O, the job runner, the shutdown deadline (§9)                  |
| Domain errors            | `Result`, enums, thiserror                           | Expected failures with fixed texts                                     |
| Wire representation      | Serde and serde_json                                 | The API JSON and the decoding of Google answers (§2.3)                 |
| HTTP contract            | utoipa and utoipa-axum                               | OpenAPI 3.1 tied to the registered `/api` routes                       |
| Client generation        | Hey API with Zod                                     | SDK, wire types, and executed runtime validators                       |
| Time                     | Jiff with the bundled time zone database             | Instants, zoned arithmetic, and the UTC naive database values (§10)    |
| Persistence              | PostgreSQL, SQLx, jiff-sqlx                          | Checked queries, migrations, and time adapters                         |
| Sessions                 | tower-sessions with a first-party SQLx store         | Cookie sessions in `app_sessions` (ADR 0002)                           |
| Google sign-in           | oauth2                                               | Authorization code flow with PKCE and state (ADR 0002)                 |
| Outbound HTTP            | reqwest with Rustls                                  | Google Calendar, OAuth token, and userinfo calls (§2.3)                |
| Token crypto             | aes-gcm, hmac, sha2, subtle, getrandom               | Encrypted OAuth tokens and action link tokens                          |
| Logging                  | tracing and tracing-subscriber                       | The allowlist layer: JSON lines, or readable text for development (§8) |
| UI and build             | React 19, React DOM, Vite 8                          | The SPA                                                                |
| Routing and server state | TanStack Router and TanStack Query                   | URL routes and the query cache                                         |
| Styling                  | Tailwind CSS 4, shadcn/ui on Radix UI                | The existing design (CONTRIBUTING.md)                                  |
| Tests                    | nextest, doctests, Vitest, Playwright with axe       | Behaviour, contracts, and critical journeys                            |
| Formatting and lint      | rustfmt, Clippy, Prettier, Oxlint with tsgolint, tsc | Named checks through mise                                              |

### 2.1 API contract and generation

1. `crates/server/src/http/openapi.rs` registers the 16 documented `/api` operations through utoipa-axum. Each operation documents every status that it can answer, including its Problem Details errors. The sign-in redirects (`/api/auth/google`, `/api/auth/google/callback`), the action pages (`/action/{token}`), and the operational routes (`/healthz`, `/readyz`, `/version`) are outside the contract.
2. `cargo run --locked -p caltodo --bin openapi -- <path>` exports the document without environment, database, or SPA assets. `contract/openapi.json` is committed.
3. `packages/api-client` generates the SDK, the wire types, and the Zod validators from the committed document (`@hey-api/openapi-ts` 0.99.0) into `src/generated/`. The generated files and the document are committed and excluded from Prettier.
4. `mise run contract:check` exports the document and regenerates the client in a scratch directory and compares the complete trees, including added and deleted files. It never changes the working tree.
5. The facade (`packages/api-client/src/index.ts`) validates every success body and every error body in the call path. A 2xx body that breaks the contract, an empty 2xx body, an unknown error code, an invalid error body, and a non-JSON intermediary answer become typed errors (`invalid_response`, `unrecognized_error`). A known error code counts only when it matches its status. `src/__tests__/facade.test.ts` tests each case.
6. `crates/server/tests/integration/contract.rs` checks real router answers of each operation (status, content type, and body) against the committed document with a strict schema checker.
7. Null and optional fields: an always-present field that can be `null` is `required` and nullable (for example `CalendarTask.details`, `UserSettings.calendarId`). Exception: a field that the server adds to an existing answer is optional in the schema, and the facade gives its old meaning to a missing value. A rollback to the previous server then does not break the new bundle. The current case is `CreatedTask.urgentMoveFailed` (missing means `false`). An added field also keeps the answer a plain object, so the previous bundle still validates it.
8. Compatibility: the server and the SPA deploy together. An old tab keeps its bundle until it reloads; `index.html` is `no-cache`.

The build order is: export the document, generate the client, build the SPA, build the release server. The export does not depend on the SPA.

### 2.2 Errors and failure containment

Every `/api` failure answers RFC 9457 Problem Details with `content-type: application/problem+json`: `type: "about:blank"`, `title` (the status phrase), `status`, a fixed `detail`, and a stable `code`. `crates/server/src/http/errors.rs` maps every error in one place. The `detail` keeps the error text of the Node server where one existed (ADR 0004).

| `code`                            | Status | Cause                                                              |
| --------------------------------- | ------ | ------------------------------------------------------------------ |
| `invalid_request`                 | 400    | An invalid body or path value                                      |
| `invalid_task_ids`                | 400    | An invalid `taskIds` list                                          |
| `invalid_settings`                | 400    | Invalid settings                                                   |
| `invalid_action`                  | 400    | An unknown action of an action link                                |
| `no_calendar`                     | 400    | The user has no calendar selected                                  |
| `no_settings`                     | 400    | The user has no settings                                           |
| `invalid_link`                    | 400    | An unknown, used, or expired action link                           |
| `invalid_event_time`              | 400    | An event without a valid time range                                |
| `unauthenticated`                 | 401    | No signed-in session                                               |
| `csrf_rejected`                   | 403    | A missing or wrong CSRF token                                      |
| `forbidden`                       | 403    | An action link of another user                                     |
| `not_found`                       | 404    | An unknown `/api` path or method                                   |
| `task_not_found`                  | 404    | The event is not a task of the user                                |
| `no_free_slot`                    | 409    | No free slot in the next 90 days                                   |
| `payload_too_large`               | 413    | A body over the limit (§15)                                        |
| `rate_limited`                    | 429    | A rate limit (§15)                                                 |
| `internal_error`                  | 500    | A contained panic or a store failure                               |
| `calendar_unavailable`            | 500    | The calendar access failed (Node text "Failed to access calendar") |
| `event_not_created`               | 500    | Google did not create the event                                    |
| `google_unavailable`              | 502    | A Google call failed (P3 fix: no longer an empty success)          |
| `google_reauthorization_required` | 502    | Google refused the refresh token; the user must sign in again      |
| `sign_in_failed`                  | 502    | The Google sign-in failed after the redirect                       |

No SQL error, Google error text, token, or user input reaches a response or a log. An unknown `/api` path is a Problem Details 404; it never falls back to `index.html`. The 401 `detail` is "Not authenticated" on `/api/auth/user` and "Unauthorized" on the other routes, like the Node server. Failure containment: "reorder" and "bulk complete" read every requested task before they change one. A missing task, a cancelled event, or an event that is not a task gives `task_not_found`; a task without a time range gives `invalid_event_time` (reorder); a failed read gives `google_unavailable`. In each case no task changes. A failed change stops the request with an error. The changes before it stay, because Google Calendar has no transaction; the client then reloads the task list. "Reschedule all" reports per-task counts (`moved`, `unchanged`, `skippedNoSlot`, `skippedInvalid`, `failed`). The create answer (the task fields and `urgentMoveFailed`) of an urgent task has `urgentMoveFailed: true` when "reschedule all" fails or reports `failed > 0`; the task exists, so the status stays 200.

### 2.3 Outbound sources

`crates/server/src/google/` holds the adapters. Each decodes Google answers at the boundary.

- **Transport:** one shared reqwest client with `User-Agent: caltodo/<version>`, a 5-second connect timeout, a 10-second total deadline per request that includes the body, an 8 MiB body limit, and no redirects. A transport failure maps to a fixed error; the reqwest error text never reaches a message, a log, or a response.
- **Calendar API:** `https://www.googleapis.com/calendar/v3`. `events.list` follows `nextPageToken` up to 40 pages (P3 fix). `calendarList` requests 250 calendars per page and follows `nextPageToken` up to 10 pages. A longer list fails with `google_unavailable`; it is not cut silently.
- **OAuth:** the authorization endpoint `https://accounts.google.com/o/oauth2/v2/auth`, the token endpoint `https://www.googleapis.com/oauth2/v4/token`, and the userinfo endpoint `https://www.googleapis.com/oauth2/v3/userinfo` (the Passport endpoints). A 401 from the Calendar API refreshes the access token once and stores the new token (`application/calendar_access.rs`). `invalid_grant` maps to `google_reauthorization_required`.
- `crates/server/tests/integration/google_http.rs` runs the adapters against a local fake Google HTTP server.

### 2.4 Frontend state

| State                        | Owner                                                  |
| ---------------------------- | ------------------------------------------------------ |
| Server data and client cache | TanStack Query (`web/src/lib/queries.ts`)              |
| The page                     | TanStack Router (`/`, `/settings`, `/privacy`, `/tos`) |
| Local interaction state      | React                                                  |
| Form input                   | React Hook Form with Zod                               |
| Durable business data        | Google Calendar (tasks) and PostgreSQL (account data)  |

The query keys and the cache settings are the same as in the old client. Sign-out loads the start page again, which drops the in-memory cache.

### 2.5 Authentication and sessions

ADR 0002 records the decisions and the threat model.

- **Sign-in:** Google OAuth 2.0 authorization code flow with `state` and PKCE (S256), scopes `profile`, `email`, `calendar`, and `calendar.events`, `access_type=offline`, and `prompt=consent`. The callback path is `/api/auth/google/callback`. The user id is the OpenID `sub` (`users.google_id`).
- **Session:** tower-sessions 0.15 with the first-party `PgSessionStore` (`crates/server/src/db/sessions.rs`) on the table `app_sessions`. The cookie `caltodo.sid` holds the signed session id: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production, and an expiry 7 days after the last change. The sign-in clears the session and changes its id. Only a new session inserts a row; the save of a loaded session updates its row and never inserts one. So a request that ends after a sign-out, a sign-in id change, or an account deletion does not bring the deleted session back.
- **CSRF:** each session has a random token. Every request that is not GET, HEAD, or OPTIONS must send it in `X-CSRF-Token` or, for a form, in the field `csrfToken`.
- **Tokens at rest:** the OAuth tokens are AES-256-GCM encrypted with a key derived from `TOKEN_ENCRYPTION_KEY`, in the `enc:v1:` format of the Node server. `crates/server/tests/integration/vectors.rs` proves byte compatibility with the Node vectors.
- **Action links:** a 32-byte random token; the database keeps only its HMAC-SHA256 (`ACTION_TOKEN_SECRET`). A token works once, for 7 days, and a new token for the same event retires the older ones.

---

## 3. Build & verify commands

Mise tasks in `mise.toml` are the single source of truth. The root `package.json` keeps the aliases `pnpm dev` and `pnpm verify`, which only call the mise tasks (§13).

| Variable      | Command           |
| ------------- | ----------------- |
| `$FORMAT_CMD` | `mise run format` |
| `$LINT_CMD`   | `mise run lint`   |
| `$BUILD_CMD`  | `mise run build`  |
| `$TEST_CMD`   | `mise run test`   |
| `$VERIFY_CMD` | `mise run verify` |

- **format:** rustfmt and Prettier in write mode. `format-check` is the same in check mode.
- **lint:** `cargo clippy --workspace --all-targets --locked -- -D warnings`, Oxlint on `web/src`, `packages/api-client`, and `e2e`, the TypeScript 7 type check of every TypeScript package, and the check that rustls has one crypto provider (§7).
- **sqlx:check:** creates the isolated database `caltodo_sqlx_check` on the local container, applies the migrations, runs `cargo sqlx prepare --workspace --check -- --all-targets --locked`, and drops the database.
- **build:** `contract:export`, `contract:generate`, the web build, and `cargo build --release --locked -p caltodo`.
- **test:** `cargo nextest run --workspace --locked` with `DATABASE_URL` on the local container (each `#[sqlx::test]` creates and drops its own database), `cargo test --doc --workspace --locked`, Vitest in every TypeScript package, and `test:e2e` (the web build, the release build of the `e2e_server` example, a new empty `caltodo_e2e` database, and Playwright).
- **verify:** `format-check` → `lint` → `sqlx:check` → `contract:check` → `scan:secrets` → `scan:deps` → `build` → `test`. It stops at the first failed step and changes no tracked file. Docker must run; a missing database is a failure, not a pass.
- **Other tasks:** `setup`, `dev` (the server on port 5001 with the text log, Vite on port 5000, `.env` read), `start`, `db:start`, `db:stop`, `db:migrate`, `db:reset`, `sqlx:prepare`, `contract:export`, `contract:generate`, `contract:check`, `scan:secrets`, `scan:deps`, and `test:e2e`.

**Dependency freshness check** (`DOCTRINE.md` P7; agent-setup `74f4b3f` profile `stacks/STACK-RUST.md` §3): run `cargo update --dry-run --verbose --locked`, `mise exec -- pnpm outdated --recursive`, and `mise outdated --bump`. The workspace crates have exact `=x.y.z` pins, which `cargo update` does not move, so also compare each `[workspace.dependencies]` entry with its latest stable crates.io release. Compare `rust-toolchain.toml` with the latest stable Rust release. Compare each infrastructure version in §15 with its latest stable release. Railpack is the exception: Railway uses its default Railpack version, which can be older than the latest Railpack release (§13), so the check records the Railpack version of the last build instead. A candidate version must be at least one day old (`minimumReleaseAge`); a security fix may skip the age. Node stays on the newest Active LTS major. The check changes no file. The deps PR records the result, the updates, and each retained version with a reason and a reassessment condition.

---

## 4. Performance budgets

The owner's reason for the port is memory (ADR 0001). The Node baseline from Railway's metric over 7 days: 222 MB average and 242 MB maximum resident memory, with a 500 MB service limit.

| Budget                                             | Adoption value and measurement conditions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Memory                                             | **≤ 64 MB resident** for the server process. The budget is indicative. No release check measures the resident memory. Laboratory measurement on 2026-10-14 (§14 → Memory measurement): the Linux (aarch64, glibc) release binary in a Debian container used 8.5 MB idle, 21.5 MB after 84 000 mixed requests, and 27.2 MB at the highest (`VmHWM`); the macOS release binary used 11 MB idle and 33 MB at the highest. The budget is about twice the measured peak, for the real Google calls and the nightly job, which the measurement does not include. The lead set the value from this measurement (proposed; the reviewer confirms). |
| Database pool                                      | 5 connections, 5-second acquire timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Request bodies                                     | JSON 100 KiB, form 50 KiB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Rate-limit state                                   | At most 10 000 client entries per limiter. When a limiter is full, a new client first removes the expired entries, else the live entry with the lowest count (§15). One scan of the entries, only when the limiter is full.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Outbound calls                                     | 10 seconds per Google request; at most 40 pages per event list; at most 10 pages per calendar list; 120 seconds per user in the nightly job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| API latency, startup, release size, web experience | Not set. The owner set no budget; the port keeps the existing UI and bundle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 5. Persistence shape

- **Storage:** PostgreSQL through SQLx. Tables: `users`, `user_settings`, `action_tokens`, and `user_sessions` (from the Drizzle schema; `user_sessions` is unused by the Rust server and kept for a revert), and `app_sessions` (ADR 0002).
- **Queries:** every query is a checked SQLx macro with committed `.sqlx` metadata. `mise run sqlx:check` verifies the metadata against a freshly migrated database.
- **Naive timestamps:** `action_tokens` has `timestamp` columns without a time zone. They hold UTC wall-clock time, as drizzle-orm wrote them for the Node server. The conversion (`naive_utc`) has no zone setting; `TZ` does not change it (ADR 0003).
- **Atomicity:** the sign-in creates the user and the default settings in one transaction. The settings save is one upsert. An action token is consumed with one conditional update.
- **Migrations:** numbered files in `migrations/`, applied by `caltodo migrate` as a separate start step (§15). `0001_baseline.sql` is idempotent and changes nothing on the production database (ADR 0003). Never edit a released migration. Schema changes are additive while a revert to an older release must stay possible.
- **Recovery:** Railway's PostgreSQL backups are the restore path. A revert of the application does not restore data.

---

## 6. Approved dependencies

Default answer to "should we add a library?" is **no**. Pin exact resolved versions: crates with `=x.y.z` in `[workspace.dependencies]` and `Cargo.lock`; packages exactly in each manifest or in the `catalog:` of `pnpm-workspace.yaml`. Enable only the features that the code uses. A new entry needs a `STACK.md` change with necessity, provenance, maintenance, licence, transitive cost, and replacement cost. "Lead (port)" means the lead of the Rust port within the owner's decisions P1–P3.

**Crates** (`[workspace.dependencies]`; `Cargo.toml` comments give the feature reasons):

| Crate                                                      | Version                                                  | Why it earns its place                                                                     | Approver    | Date       |
| ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------- | ---------- |
| `axum`, `tower`, `tower-http`                              | `0.8.9`, `0.5.3`, `0.6.11`                               | HTTP routing, middleware, `ServeDir`. tower-http 0.6 because reqwest 0.13.5 depends on it. | Lead (port) | 2026-10-14 |
| `tokio`                                                    | `1.53.3`                                                 | Async runtime, timers, signals; `test-util` in tests                                       | Lead (port) | 2026-10-14 |
| `sqlx`, `jiff-sqlx`                                        | `0.9.0`, `0.2.0`                                         | PostgreSQL, checked queries, migrations, Jiff values; TLS: `tls-rustls-aws-lc-rs` (§7)     | Lead (port) | 2026-10-14 |
| `tower-sessions`, `async-trait`                            | `0.15.0`, `0.1.92`                                       | Cookie sessions; the store trait is an `async_trait` (ADR 0002)                            | Owner (P2)  | 2026-10-14 |
| `time`                                                     | `0.3.55`                                                 | The expiry type of the tower-sessions API only                                             | Lead (port) | 2026-10-14 |
| `oauth2`                                                   | `5.0.0`                                                  | The Google authorization code flow with PKCE (ADR 0002)                                    | Lead (port) | 2026-10-14 |
| `reqwest`                                                  | `0.13.5`                                                 | Outbound HTTPS with Rustls, form, JSON, and query support                                  | Lead (port) | 2026-10-14 |
| `aes-gcm`, `hmac`, `sha2`, `subtle`, `getrandom`, `base64` | `0.11.1`, `0.13.0`, `0.11.1`, `2.6.1`, `0.4.3`, `0.23.1` | The token formats of the Node server (§2.5) and constant-time comparison                   | Lead (port) | 2026-10-14 |
| `serde`, `serde_json`, `thiserror`                         | `1.0.229`, `1.0.154`, `2.0.21`                           | Wire types and typed errors                                                                | Lead (port) | 2026-10-14 |
| `jiff`                                                     | `0.2.38`                                                 | Time with the bundled time zone database (`tzdb-bundle-always`)                            | Lead (port) | 2026-10-14 |
| `utoipa`, `utoipa-axum`                                    | `6.0.0`, `0.3.0`                                         | The OpenAPI document from the registered routes                                            | Lead (port) | 2026-10-14 |
| `tracing`, `tracing-subscriber`                            | `0.1.44`, `0.3.23`                                       | Structured events; the allowlist layer (§8)                                                | Lead (port) | 2026-10-14 |
| `uuid`                                                     | `1.28.0`                                                 | The request id (v4)                                                                        | Lead (port) | 2026-10-14 |
| `futures-util`, `http`, `form_urlencoded`                  | `0.3.34`, `1.5.0`, `1.2.2`                               | Bounded concurrency, panic containment, header types, form decoding; already in the graph  | Lead (port) | 2026-10-14 |

**Packages:**

| Package                                                                                                                                                                  | Version                          | Why it earns its place                                                                                                                                                                                                                                                                               | Approver         | Date       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------- |
| `@hey-api/openapi-ts`                                                                                                                                                    | `0.99.0` (api-client dev)        | Local generation of the SDK, types, and Zod validators                                                                                                                                                                                                                                               | Owner (P1)       | 2026-10-14 |
| `typescript`                                                                                                                                                             | `6.0.3` (api-client dev only)    | The generator's compiler API (§13)                                                                                                                                                                                                                                                                   | Owner (P1)       | 2026-10-14 |
| `typescript`                                                                                                                                                             | `7.0.2` (catalog)                | The language and the type check                                                                                                                                                                                                                                                                      | Owner (P1)       | 2026-10-14 |
| `zod`                                                                                                                                                                    | `4.6.7` (catalog)                | Executed validation of API answers and of the settings form                                                                                                                                                                                                                                          | Owner (existing) | 2026-10-14 |
| `react`, `react-dom`                                                                                                                                                     | `19.3.1`                         | The SPA                                                                                                                                                                                                                                                                                              | Owner (existing) | (existing) |
| `vite`, `vitest`                                                                                                                                                         | `8.3.4`, `5.0.5` (catalog)       | Build and tests                                                                                                                                                                                                                                                                                      | Owner (P1)       | 2026-10-14 |
| `@tanstack/react-router`, `@tanstack/react-query`                                                                                                                        | `1.170.45`, `5.104.3`            | Routes and the query cache                                                                                                                                                                                                                                                                           | Owner (P1)       | 2026-10-14 |
| `oxlint`, `oxlint-tsgolint`                                                                                                                                              | `1.88.0`, `7.0.2004`             | Type-aware lint for TypeScript 7                                                                                                                                                                                                                                                                     | Owner (P1)       | 2026-10-14 |
| `prettier`                                                                                                                                                               | `3.9.10`                         | Format                                                                                                                                                                                                                                                                                               | Owner (existing) | (existing) |
| `@playwright/test`, `@axe-core/playwright`                                                                                                                               | `1.64.1`, `4.14.0` (e2e)         | Browser journeys and accessibility checks                                                                                                                                                                                                                                                            | Lead (port)      | 2026-10-14 |
| Radix UI, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `react-icons`, `@hello-pangea/dnd`, `react-hook-form`, `@hookform/resolvers`, `date-fns` | exact pins in `web/package.json` | The existing UI                                                                                                                                                                                                                                                                                      | Owner (existing) | (existing) |
| `tailwindcss`, `@tailwindcss/postcss`, `postcss`, `autoprefixer`, `tailwindcss-animate`                                                                                  | exact pins in `web/package.json` | The existing styles. Tailwind 4.3.3 gives the same computed styles as the old build in Chromium (deps PR, 2026-10-15)                                                                                                                                                                                | Owner (existing) | (existing) |
| `@fontsource-variable/inter`                                                                                                                                             | `5.3.0` (web)                    | The Inter font files (weight and optical size axes) in the build, so the browser loads the app font from the app origin. Google Fonts would add a browser data transfer to Google and a CSP exception. OFL-1.1, no dependencies, published by Fontsource; replacement: other font files in `web/src` | Lead             | 2026-10-18 |

**Tools** (`mise.toml`): Gitleaks `8.30.1`, cargo-deny `0.20.2`, cargo-nextest `0.9.148`, cargo-shear `1.14.0`, and sqlx-cli `0.9.0` (built from crates.io with `--locked`, features `postgres,rustls`). Approver: Lead (port), 2026-10-14.

**External services:** Google OAuth 2.0 and the Google Calendar API (existing).

---

## 7. Stack-specific reject-list additions

- First-party unsafe code.
- Production `unwrap`, `expect`, `panic!`, `todo!`, or `unimplemented!` for ordinary failures; `dbg!` anywhere; `println!` or `eprintln!` in shipped server paths.
- Lint suppression without a narrow reason (`#[allow]` is denied).
- A bare `String` id across the crate boundary where a newtype exists (`UserId`, `EventId`, `CalendarId`).
- A change to the Google Calendar event format (title prefixes, extended properties, description layout) without a migration plan for existing events.
- A Google error text, a SQL error text, a token, or task text in a log or a response.
- An outbound call without a deadline; unbounded concurrency, retries, or bodies.
- Ambient time, environment, file system, or random access in `crates/domain`.
- Two rustls crypto providers in one binary (for example `ring` and `aws-lc-rs`). rustls then has no process-default provider and panics when SQLx builds a certificate verifier (`sslmode=verify-ca`). reqwest and SQLx both use the aws-lc-rs provider; `mise run lint` checks the rustls features.
- Host-local time zone arithmetic; a naive database value converted with any zone other than UTC (§10).
- A raw `fetch` or a handwritten wire contract outside `@caltodo/api-client`; a manual edit of generated artifacts.
- `useEffect` for server-data fetching.

---

## 8. Logging & privacy

- **Logger:** `tracing` events through the allowlist layer (`crates/server/src/observability.rs`). One line per event on standard output: JSON (`CALTODO_LOG_FORMAT=json`, the default) or readable text (`CALTODO_LOG_FORMAT=text`, set by `mise run dev`). Only the fields in `ALLOWED_FIELDS` are written, from the event and from its spans. The layer ignores events from other crates.
- **Request correlation:** each request runs in a span with a random `request_id`, the route pattern, and the method. Each request writes one line with the route pattern, the method, the status, and the elapsed time — never the path, the query, a header, or a body, because a path can contain an action token.
- **No PII, no telemetry.** No email, name, Google id, task text, token, or event id in a log. Jobs log counts only. No browser diagnostics.
- **Secrets:** `Secret` hides its value in `Debug`. Configuration errors name the variable, never the value.

---

## 9. Background & lifecycle

- **Jobs** (`crates/server/src/application/jobs.rs`): one runner task inside `caltodo serve`. 00:00 in the `TZ` zone: "reschedule all" for each user with a calendar, one user at a time, at most 120 seconds per user. 01:15: delete expired action tokens, used tokens older than 30 days, and expired sessions. The runner sleeps at most 15 minutes at a time and recomputes the next run, so a daylight-saving change or a clock jump does not skip a run. A missed run (the process was down) does not run later, like node-cron.
- **Shutdown** (`crates/server/src/lifecycle.rs`): on SIGTERM or SIGINT the server stops accepting connections, stops the job runner, and gives active requests 25 seconds. After the deadline the process ends the runtime with `shutdown_background` and exits. `crates/server/tests/lifecycle.rs` tests the idle stop, a request within the deadline, a request past the deadline, and the binary on SIGTERM and SIGINT.
- **Bounded work:** reorder and bulk complete read at most 8 events at a time and change one event at a time. Every Google call has a deadline (§2.3).

---

## 10. Time & timezones

- **Instant:** a Jiff `Timestamp`. On the wire, an RFC 3339 UTC string in the JavaScript `toISOString()` form.
- **Free-slot search** (`crates/domain/src/schedule.rs`): Jiff zoned arithmetic in the user's time zone (P3 fix). Work hours are local wall-clock hours. A day with a daylight-saving gap or overlap uses the real local times. `crates/domain/tests/find_slot_golden.rs` compares 648 cases with a brute-force oracle and with the Node results; six documented cases differ, where the Node code did not stop or used a wrong weekday.
- **User time zone:** an IANA name that Jiff's bundled database knows (exact case). The settings page lists the Node `Intl` names; the server accepts them (`crates/domain/tests/time_zones.rs`).
- **Process time zone:** `TZ` (UTC when unset) sets only the job times. Naive database values are always UTC (ADR 0003, `naive_timestamps.golden.json` from the Node code with `TZ=Europe/Helsinki`).
- **Tests:** `FixedClock` and paused Tokio time. The goldens use `TZ=UTC` for the Node side, except the naive timestamp golden, which uses `TZ=Europe/Helsinki`.

---

## 11. Design guidelines & UX thresholds

- **Design authority:** WCAG 2.2 AA and native HTML semantics; `CONTRIBUTING.md` has the visual design.
- **Thresholds:** text contrast ≥ 4.5:1 (body) and ≥ 3:1 (large text); pointer targets ≥ 24×24 CSS px; a visible focus indicator on every interactive element. The existing UI has known defects (§13).
- **Browser evidence:** `mise run test:e2e` runs Playwright journeys with axe (`e2e/tests/`) against `crates/server/examples/e2e_server.rs`: the real router, middleware, sessions, PostgreSQL, and SPA build over the fake Google ports (`FakeCalendar`, `FakeOAuth`). Projects: Chromium desktop (`Desktop Chrome`) and one narrow viewport (`Pixel 7`).
- **Checks of each journey:** axe (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) after a content assertion; a violation outside the known defects fails. The browser reaches no network. Any external request, a CSP violation, a CSP console error, or a page error fails the test. Each test sends its own `X-Forwarded-For` address, so the real rate limits stay on.
- **Visual parity:** `e2e/visual-compare/` compares full-page screenshots of the old and the new build. It is a one-off tool of the port, not part of `verify`.

---

## 12. Best practices source

Never write or change code that uses a package or crate in §6 from memory. Retrieve version-pinned documentation first (Context7, docs.rs for the pinned version, or the crate source in `~/.cargo/registry/src/`). For browser semantics and accessibility, use MDN and the W3C WCAG 2.2 pages.

References: the [Rust edition guide](https://doc.rust-lang.org/edition-guide/rust-2024/index.html), [Clippy](https://rust-lang.github.io/rust-clippy/master/index.html), [Axum](https://docs.rs/axum/), [Tower HTTP](https://docs.rs/tower-http/), [Tokio shutdown](https://tokio.rs/tokio/topics/shutdown), [SQLx](https://docs.rs/sqlx/), [Jiff](https://docs.rs/jiff/), [tower-sessions](https://docs.rs/tower-sessions/), [oauth2](https://docs.rs/oauth2/), [utoipa](https://docs.rs/utoipa/), [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457), [Hey API](https://heyapi.dev/), [Google Calendar API](https://developers.google.com/calendar/api), [nextest](https://nexte.st/), [Playwright accessibility](https://playwright.dev/docs/accessibility-testing), [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), and [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

---

## 13. Scoped exceptions and intentional divergences

Do not weaken a rule or a check to make a change pass. The responsible lead resolves an exception within project authority, with an independent reviewer. The change author must not approve their own weaker acceptance or checks. "Proposed" rows wait for that approval.

### Scoped exceptions

| Rule / scope                                                                                                                                                                                                                                                                                                                                                                                                      | Reason and consequences                                                                                                                              | Compensating evidence                                                                                                                                                                                                                                                                                               | Responsible lead / reviewer / approval                                                   | Expiry or reassessment                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| §1 `exactOptionalPropertyTypes`, only for `packages/api-client/src/generated/` (`tsconfig.generated.json`)                                                                                                                                                                                                                                                                                                        | The client runtime that Hey API 0.99.0 copies into the output fails the flag. Generated files must not be edited.                                    | Every other strict flag stays on; the facade and `web/` keep the full set; `contract:check` keeps the tree identical to the generator output.                                                                                                                                                                       | Lead (port) / independent reviewer: TBD / proposed                                       | At the next generator upgrade                 |
| §1 one TypeScript 6 line: `typescript@6.0.3` in `packages/api-client` devDependencies only                                                                                                                                                                                                                                                                                                                        | Hey API 0.99.0 uses the compiler API, which TypeScript 7 does not export.                                                                            | Every type check runs TypeScript 7.                                                                                                                                                                                                                                                                                 | Lead (port) / TBD / proposed                                                             | When Hey API supports TypeScript 7            |
| §14 dependency triage: the override `'@hey-api/json-schema-ref-parser@1.4.4>js-yaml': '4.3.2'`                                                                                                                                                                                                                                                                                                                    | The generator's dependency pins js-yaml 4.2.0 (GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh). js-yaml runs only at generation time. | `pnpm audit` passes; `contract:check` proves byte-identical output.                                                                                                                                                                                                                                                 | Lead (port) / TBD / proposed                                                             | When the generator depends on a fixed js-yaml |
| §11 axe: the known defects of `e2e/tests/support.ts` (`KNOWN_DEFECTS`, `KNOWN_DEFECT_MARKUP`): `maximum-scale=1`, footer links by color only, unnamed drag handles, task checkboxes, duration select, toast close button, the Google icon, and `lang` on the action pages. The color contrast defects and the unnamed header navigation on a narrow screen are fixed (issue #5, item 14) and are not on the list. | The defects exist in the old UI and action pages. The port kept them (P1). Issue #5 item 14 fixed the contrast and header defects.                   | Each entry names the rule and the elements; a violation on any other element fails. Entries match the markup when the axe selector changes with the number of tasks; axe runs after the CSS transitions end (`known-defects.spec.ts`). The owner accepted the new font (PR #21) and new colors (issue #5, item 14). | Lead (port) / TBD / proposed; owner decides the follow-up fix                            | Follow-up issue for the accessibility fixes   |
| §14 secret scan: `.gitleaksignore` lists two findings in `.replit` of commit `1dc22ed` (December 2025): values for `TOKEN_ENCRYPTION_KEY` and `ACTION_TOKEN_SECRET` in the public history                                                                                                                                                                                                                         | The values cannot be removed from the public history by this change. If production uses them, they are leaked secrets.                               | The scan covers every other commit and file; the other ignored findings are synthetic test values. The values belong to the old Replit deployment. The owner no longer uses Replit and states that the values give no access (issue #5, 2026-10-19).                                                                | **Closed: owner decision 2026-10-19** (issue #5); the values give no access, no rotation | When a `.replit` value is used again          |
| Profile §2.5 (a first-party session system needs an independent security review)                                                                                                                                                                                                                                                                                                                                  | The maintained SQLx store needs SQLx 0.8 (ADR 0002). Owner decision P2.                                                                              | Store tests (`storage.rs`), session journeys (`api_auth.rs`), fixation and expiry tests, ADR 0002 threat model.                                                                                                                                                                                                     | Owner (P2) / independent security review: TBD                                            | At each tower-sessions upgrade                |

### Intentional divergences

| Date       | Rule                                              | Divergence                                                                                                                                                                                | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Approval      |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 2026-10-14 | Profile §1 (inherit `rust-version` in each crate) | `crates/server` repeats `edition`, `rust-version`, and `publish`.                                                                                                                         | Railpack 0.40.1 cannot decode inherited package fields in the binary crate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Lead (port)   |
| 2026-10-14 | Profile §3 (mise tasks only)                      | The root `package.json` aliases `pnpm dev` and `pnpm verify`.                                                                                                                             | Habit; each alias only calls its mise task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Lead (port)   |
| 2026-10-14 | Profile §5 (`timestamptz` for instants)           | `action_tokens` keeps naive `timestamp` columns.                                                                                                                                          | Additive schema only (owner); ADR 0003 defines the meaning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Owner (P2/P3) |
| 2026-10-15 | `DOCTRINE.md` P7 (pin toolchains)                 | The Railway build does not pin Railpack: no `RAILPACK_VERSION` variable or other pin. Each build uses the Railpack version that Railway selects, with its own builder and runtime images. | The owner wants the Railway default. A new Railpack release can change or break a build without a repository change. Then the previous deployment stays live (§15 Recover), and the fix updates the repository (`railpack.json` or the build steps) for the new Railpack, never a pin. The release checks record the Railpack version of each build in the PR of the merge. Railway can roll out a Railpack release before the one-day minimum release age of §3; the owner accepts this. A Railway rollback reuses the old image, but a revert rebuilds with the current Railpack. Reassess when a Railpack release breaks a production build, or when Railway changes its default. | Owner         |

---

## 14. Applicability and evidence

Run the required tests and the full `$VERIFY_CMD` locally on the exact version to merge, integrated with the current `main`. A failed or missing required local check blocks merge. The repository has no CI pipeline. For a material change, the independent reviewer runs `mise run verify` on the PR head integrated with the current base in an isolated checkout.

| Doctrine / applicability               | Required evidence                                                                                                                                                                      | Environment / gap                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P1, P6: each task                      | Criteria, failure cases, assumptions, and their check mapping in the PR                                                                                                                | The lead prepares them; a material change gets an independent review.                         |
| P2–P4: types, dependencies, boundaries | `mise run verify`; a §6 entry for each new dependency                                                                                                                                  | Manifest edits and ambient effects need review (§0 gaps).                                     |
| P3, P5: the HTTP contract              | `contract:check`; `contract.rs`; the facade tests                                                                                                                                      | Annotations do not prove handler behaviour; `contract.rs` does.                               |
| P5–P6: parity with the Node server     | The Node goldens and vectors (`crates/server/tests/fixtures/README.md`)                                                                                                                | The generators run only at the commit that adds them.                                         |
| P5–P7: storage                         | `sqlx:check`; `schema.rs` (baseline against the Drizzle snapshot, data kept); `storage.rs`                                                                                             | PostgreSQL 18: test `postgres:18`, production `postgres-ssl:18` (§15).                        |
| P3, P7: security                       | Gitleaks, `pnpm audit`, `cargo deny check`, `cargo shear`; CSRF, rate limit, header, body, session, and OAuth tests                                                                    | Scanners do not prove authorization; the reviewer checks the diff for secrets.                |
| P5–P7: browser                         | Playwright journeys with axe (§11), desktop and narrow viewport                                                                                                                        | Chromium only.                                                                                |
| P7: dependency freshness               | The §3 check result in the deps PR, or in the task PR with the deps PR links: updates, retained versions with reasons and reassessment conditions, and the §15 infrastructure versions | Needs registry access; an unavailable check is a recorded gap, not a pass.                    |
| P7: release                            | Before merge: the Railpack plan (`railpack info .` with the latest Railpack release), the schema comparison, the recovery path (ADR 0005); after release: §15 checks                   | The Linux build on Railway happens at the merge, with the Railpack release of that day (§13). |
| P8–P9: material changes                | Current docs, ADRs, independent integrated verification                                                                                                                                | Separate reviewer context; exact tested revisions.                                            |

### Check configuration

| Check             | Tool                                                                           | Acceptance condition                       |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| Format            | rustfmt and Prettier, check mode                                               | No formatting difference                   |
| Types and lint    | Clippy (`-D warnings`), tsc 7, Oxlint (`--type-aware --deny-warnings`)         | No errors, no warnings                     |
| Dead dependencies | `cargo shear --locked --deny-warnings`; rustc unused checks                    | No finding                                 |
| SQL metadata      | `mise run sqlx:check`                                                          | Matches the migrated isolated schema       |
| Contracts         | `contract:check`, `contract.rs`, the facade tests                              | No drift; no invalid data accepted         |
| Secrets           | Gitleaks `--redact --config .gitleaks.toml` on the history that `HEAD` reaches | No finding outside `.gitleaksignore` (§13) |
| Rust dependencies | `cargo deny --locked check`                                                    | No finding                                 |
| JS dependencies   | `pnpm audit --audit-level low`                                                 | No advisory of any severity                |
| Behaviour         | nextest, doctests, Vitest, Playwright with axe                                 | All required cases pass                    |

**Secret scan triage.** A real secret is rotated first, then removed; never put a real secret on an ignore list. A false positive in a new commit gets a narrow allowlist entry in `.gitleaks.toml` (path or synthetic-value pattern); a finding in a commit on `main` gets its fingerprint in `.gitleaksignore` with a comment. A change to the rules or the scope of a check needs independent review.

**Dependency scan.** `pnpm audit` sends the resolved package names and versions to `registry.npmjs.org`; `cargo deny` fetches the RustSec advisory database. A fetch error fails the scan. Record the time of the run in the PR evidence.

### Memory measurement

The procedure behind §4: build the release binary for the target (`cargo build --release --locked -p caltodo`; for Linux, inside `rust:1.99.0-bookworm`), start it with `/bin/bash -c "./bin/caltodo migrate && exec ./bin/caltodo serve"` (for Linux, in `debian:bookworm-slim` with `ca-certificates`) on an empty database with synthetic secrets and `PRODUCTION_APP_URL` set, wait 5 seconds, and read the resident memory (`VmRSS` of the process; `ps -o rss` on macOS). Then run three rounds of `ab -n 5000 -c 50` on `/`, the main JavaScript bundle, `/readyz`, `/api/auth/user`, and `/action/invalid-token`, plus 3 000 requests from distinct `X-Forwarded-For` addresses, and read the resident memory after each round and 5 seconds after the load. The load has no signed-in user and no Google call.

---

## 15. Release, recovery, and maintenance

- **Release:** the Railway service deploys each merge to `main`. Railpack builds the image from `railpack.json`: the Rust provider; Node 24.22.0 and pnpm 12.14.0 for the web build; `pnpm install --frozen-lockfile --filter @caltodo/web...`; the web build; `SQLX_OFFLINE=true cargo build --release --locked --package caltodo --bin caltodo`; and a final image with only `bin/caltodo` and `web/build`. The generated contract artifacts are committed, so the image build does not run the export or the generator. The start command is `./bin/caltodo migrate && exec ./bin/caltodo serve`; Railpack runs it with `/bin/bash -c`. The server binds `0.0.0.0:$PORT`.
- **Railway settings at the first release** (not in the repository; ADR 0005): remove the build command override `pnpm run build:production`; remove a start command override if one exists; set the health check path to `/healthz`. Record each change in the PR. Do not set `RAILPACK_VERSION` or another Railpack pin (§13).
- **Runtime variables:** `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ACTION_TOKEN_SECRET`, `TOKEN_ENCRYPTION_KEY`, `PRODUCTION_APP_URL` (required on Railway), `TZ`, `PORT` (Railway), `RAILWAY_GIT_COMMIT_SHA` (Railway; `/version` reports it), and the optional `CALTODO_LOG_FORMAT`. `NODE_ENV` has no effect.
- **Build-time variables:** Railway gives every service variable to every build command, and `"secrets": []` in `railpack.json` limits only the cache scope. A dependency's build script can read the secrets during the build. Compensating controls: the lockfiles with `--locked` and `--frozen-lockfile`, `cargo deny`, `pnpm audit`, `cargo shear`, and the `allowBuilds` list in `pnpm-workspace.yaml`. Known gap.
- **Asset routing and headers:** `/assets/…` serves the hashed bundles (a missing file is 404); `index.html` is `no-cache`; a deep link gets `index.html`; every unknown `/api` path is a Problem Details 404. Every response carries the CSP of the Node server (`crates/server/src/http/mod.rs`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and, in production, `Strict-Transport-Security`. No `X-Powered-By`.
- **Limits:** JSON bodies 100 KiB, form bodies 50 KiB. Rate limits per client address (the last `X-Forwarded-For` hop, IPv6 per /56): 120 per minute on `/api`; 25 per 15 minutes on the sign-in routes; 40 per 15 minutes on the action routes. A request counts once in each limit of its path, also the sign-in callback. The rate limit runs before the session and the body are read, so a limited request gets 429 and reads no body. A full limiter (§4) never refuses a new client. It removes the expired counters; if none has expired, it removes the live counter with the lowest count (on a tie, the oldest window start), and then counts the new client. So a flood of new addresses cannot block real users: the flood addresses have count 1 and remove each other, and a counter close to its limit stays. To remove a counter with count `c`, a client must first raise every other counter to at least `c`, so it gains at most the request budget of the addresses that it spends. The removal of a low counter gives that client a new window; a real user loses no access by it.
- **Observe:** `/healthz` (liveness), `/readyz` (a database ping with a deadline), and `/version` (`{"version", "commit"}`). The structured log in Railway (§8) and Railway's metrics.
- **Before the merge:** run `crates/server/tests/fixtures/schema/schema_snapshot.sql` read-only on the production database and compare the result with `drizzle_schema.snapshot.json`. Record the production `TZ` (it sets only the job times). Resolve the open secret exception (§13).
- **Release checks:** after a merge, confirm that the deployment of the merge commit succeeded and that `/version` reports it. Read the Railpack version and the runtime image from the build log (`Railpack x.y.z`, `railpack-runtime:…`) and record them in the PR of the merge; update the §15 table when they change. Then check `/healthz`, `/readyz`, the security headers, one SPA route, one sign-in, the task list, one task creation, and one action link. Check the log of the next 00:00 and 01:15 job runs.
- **Recover:** a failed build, a failed migration, or a failed health check keeps the previous deployment live. For a defect after a successful deployment, roll back to the previous deployment in Railway, then revert the merge commit on a feature branch and merge the revert. The schema changes are additive, so the Node server works on the same database; its users sign in again. Restore the Railway build command override for a Node build (ADR 0005).
- **Compatibility:** an open tab keeps its bundle until it reloads; its API calls then get 401, and it shows the sign-in page. Action links of the Node server stay valid.
- **Maintenance:** review toolchain and dependency upgrades with the same evidence rules. A utoipa or Hey API upgrade needs `contract:check` and `contract.rs`. A tower-sessions or SQLx upgrade needs the session store tests. Jiff's bundled time zone database updates with the `jiff` crate. Production runs PostgreSQL 18 (Railway image `ghcr.io/railwayapp-templates/postgres-ssl:18`, patch-only automatic updates; upgraded from 17 on 2026-10-15). Keep test and production on the same major version (`DOCTRINE.md` P7): after a PostgreSQL platform upgrade, read the production version from the database deploy log or with `SHOW server_version` (read-only), then set `CALTODO_PG_IMAGE` and `CALTODO_PG_VOLUME` in `mise.toml` to the same major version. A PostgreSQL major upgrade stops the database, so the owner decides it. Use Railway's major version upgrade (Database → Config → Major Version Upgrade): it runs `pg_upgrade` in place, takes a backup before and after, and offers a revert for a limited time. Before the upgrade, check that the volume has at least 512 MiB free; the upgrade job stops in its preflight with less, and the database then stays offline until a redeploy of the previous deployment. Never change the image tag by hand to change the major version.
- **Infrastructure versions** (PostgreSQL read on 2026-10-15 after its upgrade, Railpack read on 2026-10-19; the dependency freshness check compares them, except Railpack, which follows Railway's default, §3 and §13). Railway's default Railpack can be older than the latest Railpack release: the builds of 2026-10-18 and 2026-10-19 used 0.41.0, and 0.42.0 was released on 2026-10-15.

  | Component          | Production                                                                                                        | Test and development                               |
  | ------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
  | PostgreSQL         | 18.6, Railway image `ghcr.io/railwayapp-templates/postgres-ssl:18` (patch-only automatic updates); volume 1000 MB | 18, Docker image `postgres:18` (`mise.toml`)       |
  | Build platform     | Railway default Railpack, not pinned (§13); Railpack 0.41.0 in the build of `ff0e582` (2026-10-19)                | `railpack info .` with the latest Railpack release |
  | Runtime base image | `ghcr.io/railwayapp/railpack-runtime:mise-2026.10.8`, which follows the Railpack version (build of `ff0e582`)     | (not used)                                         |

- **Data:** PostgreSQL holds the account data (§5, `VISION.md`). Railway's database backups are the restore path. A revert does not restore data.
