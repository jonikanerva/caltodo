# CalTodo

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
- **Midnight Rescheduling** - Nightly cron job reschedules incomplete tasks (server time)

## Code Organization

```
├── client/                  # React frontend
│   ├── src/
│   │   ├── components/      # Reusable UI components (shadcn/ui)
│   │   ├── hooks/           # Custom React hooks
│   │   ├── lib/             # Utilities (API client, query client)
│   │   ├── pages/           # Page components (auth, main, settings, calendar view, not found)
│   │   └── App.tsx          # Root component with routing
│   └── index.html
│
├── server/                  # Express backend
│   ├── auth.ts              # Passport.js Google OAuth setup
│   ├── calendar.ts          # Google Calendar API integration
│   ├── config.ts            # Environment secret validation
│   ├── cron.ts              # Midnight rescheduling cron job (runs at 00:00)
│   ├── crypto.ts            # Token encryption utilities
│   ├── csrf.ts              # CSRF token middleware
│   ├── db.ts                # Database connection
│   ├── index.ts             # Server entry point
│   ├── routes.ts            # API route handlers
│   ├── static.ts            # Static file serving (production)
│   ├── storage.ts           # Database operations (Drizzle ORM)
│   ├── tokens.ts            # Action tokens for calendar event links
│   └── vite.ts              # Vite dev server integration
│
├── shared/                  # Shared between frontend and backend
│   ├── schema.ts            # Drizzle database schema and types
│   └── types.ts             # Shared API types
│
├── drizzle.config.ts        # Drizzle ORM configuration
├── vite.config.ts           # Vite bundler configuration
└── package.json             # Dependencies and scripts
```

### Key Technologies

- **Frontend**: React 19, TypeScript, Vite, TanStack Query, Wouter (routing), shadcn/ui, Tailwind CSS
- **Backend**: Node.js, Express, TypeScript, Passport.js
- **Database**: PostgreSQL with Drizzle ORM
- **APIs**: Google Calendar API, Google OAuth 2.0

### Architecture Notes

- **Frontend**: Wouter for routing, TanStack React Query for server state, shadcn/ui (Radix UI), Tailwind CSS with theme variables, @hello-pangea/dnd for reordering, React Hook Form + Zod for validation.
- **Backend**: TypeScript (ESM), tsx in development, esbuild for production bundling, express-session with PostgreSQL store (connect-pg-simple), node-cron for midnight rescheduling.
- **Data**: Drizzle ORM with schema in `shared/schema.ts`; shared types in `shared/` are used by both frontend and backend; tasks live in Google Calendar and are mapped to `CalendarTask` on read; tables include `users`, `user_settings`, `user_sessions`.
- **Security**: OAuth tokens are encrypted at rest; action tokens expire after 7 days.
- **Event handling**: App-created calendar events are marked with `[CalTodo]` to avoid touching unrelated events.
- **Google access**: OAuth scopes include `profile`, `email`, `calendar`, and `calendar.events`.

### API Overview

- Auth: `/api/auth/google`, `/api/auth/google/callback`, `/api/auth/logout`, `/api/auth/user`
- Tasks: `/api/tasks` (list + create), `/api/tasks/:id` (complete/redo), `/api/tasks/reorder`, `/api/tasks/reschedule-all`, `/api/tasks/reload`, `/api/tasks/:id/complete`, `/api/tasks/:id/reschedule`, `/api/tasks/bulk-complete`
- Settings: `/api/settings`, `/api/calendars`
- Action links: `/api/action/:token` (complete/reschedule)
- CSRF: send `X-CSRF-Token` from `/api/auth/user` on non-GET requests

## Local Development Setup (macOS)

### Prerequisites

1. **Node.js** (v20 or later)

   ```bash
   # Using Homebrew
   brew install node

   # Or using nvm
   nvm install 20
   nvm use 20
   ```

2. **PostgreSQL**

   ```bash
   brew install postgresql@15
   brew services start postgresql@15

   # Create a database
   createdb caltodo
   ```

3. **Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project
   - Enable the **Google Calendar API**
   - Go to **APIs & Services > Credentials**
   - Create an **OAuth 2.0 Client ID** (Web application type)
   - Add authorized redirect URI: `http://localhost:5000/api/auth/google/callback`
   - Note your Client ID and Client Secret

### Environment Variables

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://localhost:5432/caltodo
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
SESSION_SECRET=32+_char_random_session_secret
ACTION_TOKEN_SECRET=32+_char_random_action_secret
TOKEN_ENCRYPTION_KEY=32+_char_random_key_for_token_encryption
```

Notes:

- `SESSION_SECRET` and `ACTION_TOKEN_SECRET` must be different values and at least 32 characters long.

### Installation

```bash
# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Start development server
npm run dev
```

The app will be available at `http://localhost:5000`.

### Development Scripts

- `npm run dev` - Start development server (frontend + backend)
- `npm run db:generate` - Create a new migration from schema changes
- `npm run db:migrate` - Run pending migrations (also runs automatically on server start)
- `npm run build` - Build for production
- `npm run start` - Run production build

## Production Deployment

### Requirements

1. **Node.js Runtime** - Node.js 20+ environment
2. **PostgreSQL Database** - Managed instance or self-hosted
3. **HTTPS** - Required for OAuth security and session cookies
4. **Persistent Process Manager** - configured for automatic restarts

### Environment Variables (Production)

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require
GOOGLE_CLIENT_ID=your-production-client-id
GOOGLE_CLIENT_SECRET=your-production-client-secret
SESSION_SECRET=strong-random-secret-min-32-chars
ACTION_TOKEN_SECRET=another-strong-random-secret-min-32-chars
TOKEN_ENCRYPTION_KEY=strong-32-char-key-for-encryption
NODE_ENV=production
PRODUCTION_APP_URL=https://your-domain.com
```

### Google OAuth Setup for Production

1. In Google Cloud Console, add your production domain to authorized redirect URIs:
   - `https://your-domain.com/api/auth/google/callback`
2. If your app is public, you may need to complete Google's OAuth verification process

### Build and Deploy

```bash
# Install dependencies (includes dev dependencies needed for build)
npm ci

# Build the application
npm run build

# Run database migrations (also runs automatically on server start)
npm run db:migrate

# Start the server
npm start
```

### Deployment Checklist

- [ ] PostgreSQL database provisioned and accessible
- [ ] Environment variables configured
- [ ] Google OAuth redirect URI updated for production domain
- [ ] HTTPS configured (required for secure cookies)
- [ ] Process manager configured for automatic restarts
- [ ] Cron job runs at midnight server time for task rescheduling (set TZ if needed)

## Contributing

See `CONTRIBUTING.md` for development workflow and design guidelines.

## Legal

Privacy Policy and Terms of Service are available on the deployed site at `/privacy` and `/tos`.

## License

MIT
