# CalTodo

A web-based todo application that uses Google Calendar as its backend storage. Tasks are automatically scheduled to free time slots on your calendar, making it easy to manage what you need to do and when you'll do it.

## Features

- **Google OAuth Authentication** - Sign in with your Google account
- **Automatic Scheduling** - Tasks are scheduled to the first available free slot within your work hours
- **Drag-and-Drop Reordering** - Prioritize tasks by dragging them; the app swaps their calendar time slots
- **Task Editing** - Update task titles, descriptions, durations, and reminders
- **Bulk Operations** - Reschedule all tasks to optimize your calendar
- **Notifications** - Set reminders via Google Calendar's built-in notification system
- **Settings** - Configure your preferred calendar, work hours, timezone, and default task duration
- **Midnight Rescheduling** - Automatic cron job reschedules incomplete tasks with calendar events to new time slots

## Code Organization

```
├── client/                  # React frontend
│   ├── src/
│   │   ├── components/      # Reusable UI components (shadcn/ui)
│   │   ├── hooks/           # Custom React hooks
│   │   ├── lib/             # Utilities (API client, query client)
│   │   ├── pages/           # Page components (main, settings, auth, landing)
│   │   └── App.tsx          # Root component with routing
│   └── index.html
│
├── server/                  # Express backend
│   ├── auth.ts              # Passport.js Google OAuth setup
│   ├── calendar.ts          # Google Calendar API integration
│   ├── cron.ts              # Midnight rescheduling cron job (runs at 00:00)
│   ├── db.ts                # Database connection
│   ├── index.ts             # Server entry point
│   ├── routes.ts            # API route handlers
│   ├── static.ts            # Static file serving (production)
│   ├── storage.ts           # Database operations (Drizzle ORM)
│   ├── tokens.ts            # Action tokens for calendar event links
│   └── vite.ts              # Vite dev server integration
│
├── shared/                  # Shared between frontend and backend
│   └── schema.ts            # Drizzle database schema and types
│
├── drizzle.config.ts        # Drizzle ORM configuration
├── vite.config.ts           # Vite bundler configuration
└── package.json             # Dependencies and scripts
```

### Key Technologies

- **Frontend**: React 18, TypeScript, Vite, TanStack Query, Wouter (routing), shadcn/ui, Tailwind CSS
- **Backend**: Node.js, Express, TypeScript, Passport.js
- **Database**: PostgreSQL with Drizzle ORM
- **APIs**: Google Calendar API, Google OAuth 2.0

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
SESSION_SECRET=any-random-string-for-session-encryption
ACTION_TOKEN_SECRET=another-random-string-for-action-links
```

### Installation

```bash
# Install dependencies
npm install

# Push database schema
npm run db:push

# Start development server
npm run dev
```

The app will be available at `http://localhost:5000`.

### Development Scripts

- `npm run dev` - Start development server (frontend + backend)
- `npm run db:push` - Push schema changes to database
- `npm run build` - Build for production
- `npm run start` - Run production build

## Production Deployment

### Requirements

1. **Node.js Runtime** - Node.js 20+ environment
2. **PostgreSQL Database** - Managed PostgreSQL instance (e.g., Neon, Supabase, AWS RDS, or self-hosted)
3. **HTTPS** - Required for OAuth security and session cookies
4. **Persistent Process Manager** - PM2, systemd, or container orchestration

### Environment Variables (Production)

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require
GOOGLE_CLIENT_ID=your-production-client-id
GOOGLE_CLIENT_SECRET=your-production-client-secret
SESSION_SECRET=strong-random-secret-min-32-chars
ACTION_TOKEN_SECRET=another-strong-random-secret-min-32-chars
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

# Push database schema (first deploy or schema changes)
npm run db:push

# Start the server
npm start
```

### Deployment Checklist

- [ ] PostgreSQL database provisioned and accessible
- [ ] Environment variables configured
- [ ] Google OAuth redirect URI updated for production domain
- [ ] HTTPS configured (required for secure cookies)
- [ ] Process manager configured for automatic restarts
- [ ] Cron job runs at midnight in configured timezone for task rescheduling

### Platform-Specific Notes

**Replit**: Use built-in PostgreSQL, Secrets for environment variables, and Deployments for hosting.

**Railway/Render/Fly.io**: Add PostgreSQL addon, configure environment variables, and deploy via Git push.

**VPS/Self-hosted**: Use Nginx as reverse proxy with SSL (Let's Encrypt), PM2 for process management, and systemd for service management.

## License

MIT
