# Todo

A web-based todo application that uses Google Calendar as its backend storage. Tasks are automatically scheduled to free time slots on your calendar, making it easy to manage what you need to do and when you'll do it.

## Features

- **Google OAuth Authentication** - Sign in with your Google account
- **Automatic Scheduling** - Tasks are scheduled to the first available free slot within your work hours
- **Drag-and-Drop Reordering** - Prioritize tasks by dragging them; the app swaps their calendar time slots
- **Urgent Tasks** - Mark tasks as urgent to push them to the front of the schedule
- **Task Completion + Redo** - Mark tasks complete and undo when needed
- **Calendar Sync + Reschedule All** - Pull latest event times and reschedule all incomplete tasks
- **Calendar Action Links** - Event descriptions include "Mark Complete" and "Reschedule" links
- **Settings** - Configure your preferred calendar, work hours, timezone, default task duration, and event color
- **Theme Toggle** - Switch between light and dark modes
- **Midnight Rescheduling** - A nightly job at 00:00 reschedules incomplete tasks (server time zone `TZ`)
- **Action Token Cleanup** - A daily job at 01:15 removes expired and old used action tokens and expired sessions

## Code Organization

```
├── crates/
│   ├── domain/              # Pure rules: free-slot search, event format, task order, settings
│   └── server/              # The `caltodo` binary: HTTP (Axum), use cases, PostgreSQL (SQLx),
│                            # Google adapters, sessions, jobs, configuration, lifecycle
├── migrations/              # SQLx migrations (0001 is the baseline of the old Drizzle schema)
├── contract/openapi.json    # The API contract, generated from the Rust routes
├── packages/api-client/     # Generated TypeScript SDK and Zod validators + a small facade
├── web/                     # The React app (Vite, TanStack Router and Query, shadcn/ui, Tailwind CSS)
├── e2e/                     # Playwright and axe journeys against a deterministic test server
├── docs/adr/                # Architecture decision records
├── mise.toml                # Tool versions and every project command
└── railpack.json            # The Railway build
```

### Key Technologies

- **Server**: Rust, Axum, Tokio, SQLx, tower-sessions, reqwest, oauth2, Jiff, tracing
- **Web app**: React 19, TypeScript 7, Vite 8, TanStack Router, TanStack Query, shadcn/ui (Radix UI), Tailwind CSS, React Hook Form + Zod
- **Database**: PostgreSQL
- **APIs**: Google Calendar API, Google OAuth 2.0

`STACK.md` describes the stack, the commands, and the quality checks. `VISION.md` describes the product. `docs/adr/` records the main decisions.

### Architecture Notes

- One web process serves the API, the action pages, and the built web app. It also runs the two daily jobs in-process. There is no separate worker.
- Migrations are an explicit start step: `caltodo migrate`, then `caltodo serve`. `serve` refuses a database without the migrations.
- Tasks live in Google Calendar. The server maps app-created events (private extended property `caltodo`) to tasks on read.
- OAuth tokens are encrypted at rest (AES-256-GCM). Action links expire after 7 days and work once.
- Sessions live in the `app_sessions` table. The cookie is `caltodo.sid`.
- Google access: OAuth scopes `profile`, `email`, `calendar`, and `calendar.events`.

### API Overview

`contract/openapi.json` is the complete contract. Every error is RFC 9457 Problem Details (`application/problem+json`) with a stable `code`.

- Auth: `/api/auth/google`, `/api/auth/google/callback`, `/api/auth/logout`, `/api/auth/user`, `/api/account`
- Tasks: `/api/tasks` (list + create), `/api/tasks/{id}` (complete/redo), `/api/tasks/reorder`, `/api/tasks/reschedule-all`, `/api/tasks/reload`, `/api/tasks/{id}/complete`, `/api/tasks/{id}/reschedule`, `/api/tasks/bulk-complete`
- Settings: `/api/settings`, `/api/calendars`
- Action links: `/action/{token}` (HTML page) and `/api/action/{token}`
- Operations: `/healthz`, `/readyz`, `/version`
- CSRF: send `X-CSRF-Token` from `/api/auth/user` on every request that is not GET

## Local Development Setup (macOS)

### Prerequisites

1. **mise**: `brew install mise`, then activate it in your shell (see the mise documentation).
2. **rustup**: `brew install rustup`, then `rustup-init`. `rust-toolchain.toml` selects the Rust version.
3. **Docker** (for example OrbStack or Docker Desktop) for the local PostgreSQL container.
4. **Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project
   - Enable the **Google Calendar API**
   - Go to **APIs & Services > Credentials**
   - Create an **OAuth 2.0 Client ID** (Web application type)
   - Add authorized redirect URI: `http://localhost:5000/api/auth/google/callback`
   - Note your Client ID and Client Secret

### Environment Variables

Create a `.env` file in the project root. `mise run dev` reads it.

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
SESSION_SECRET=32+_char_random_session_secret
ACTION_TOKEN_SECRET=32+_char_random_action_secret
TOKEN_ENCRYPTION_KEY=32+_char_random_key_for_token_encryption
```

Notes:

- `SESSION_SECRET` and `ACTION_TOKEN_SECRET` must be different values and at least 32 characters long.
- `mise run dev` uses the local container database (`postgres://postgres:postgres@127.0.0.1:55473/caltodo`) when `.env` has no `DATABASE_URL`.
- `TZ` sets the time zone of the jobs (00:00 and 01:15). The default is UTC. Stored timestamps are always UTC.

### Installation

```bash
mise trust
mise run setup     # tools, dependencies, and the Playwright browser
mise run dev       # PostgreSQL container, migrations, the server on 5001, and Vite on 5000
```

The app will be available at `http://localhost:5000`. Vite sends `/api` and `/action` to the server.

### Commands

- `mise run dev` - Start the server and the Vite dev server
- `mise run format` - Format the Rust and TypeScript sources
- `mise run lint` - Clippy, Oxlint, and the TypeScript type checks
- `mise run build` - Export the API contract, generate the client, build the web app and the release server
- `mise run test` - Rust tests, Vitest, and the Playwright journeys
- `mise run verify` - The full quality gate; run it before each commit
- `mise run db:start`, `db:stop`, `db:migrate`, `db:reset` - The local PostgreSQL container
- `mise run contract:export`, `contract:generate`, `contract:check` - The API contract and the generated client
- `mise run start` - Run the release server from `mise run build`

## Production Deployment

Railway builds the service with Railpack from `railpack.json` and starts it with `./bin/caltodo migrate && exec ./bin/caltodo serve`. `STACK.md` §15 describes the release, the checks, and the rollback.

### Environment Variables (Production)

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require
GOOGLE_CLIENT_ID=your-production-client-id
GOOGLE_CLIENT_SECRET=your-production-client-secret
SESSION_SECRET=strong-random-secret-min-32-chars
ACTION_TOKEN_SECRET=another-strong-random-secret-min-32-chars
TOKEN_ENCRYPTION_KEY=strong-32-char-key-for-encryption
PRODUCTION_APP_URL=https://your-domain.com
TZ=Europe/Helsinki
```

`PRODUCTION_APP_URL` turns on production mode: secure cookies, HSTS, and the production origin of the OAuth callback. On Railway, the server refuses to start without it. `NODE_ENV` has no effect.

### Google OAuth Setup for Production

1. In Google Cloud Console, add your production domain to authorized redirect URIs:
   - `https://your-domain.com/api/auth/google/callback`
2. If your app is public, you may need to complete Google's OAuth verification process

## Contributing

See `CONTRIBUTING.md` for development workflow and design guidelines.

## Legal

Privacy Policy and Terms of Service are available on the deployed site at `/privacy` and `/tos`.

## License

MIT
