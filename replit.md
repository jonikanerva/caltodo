# CalTodo - Google Calendar Task Manager

## Overview

CalTodo is a web-based todo application that uses Google Calendar as its backend storage. Users authenticate with Google OAuth, and the app automatically schedules tasks into free time slots on their calendar. The system handles task prioritization through drag-and-drop reordering, supports urgent tasks that jump to the front of the queue, and includes automatic midnight rescheduling via cron jobs.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 19 with TypeScript
- **Build Tool**: Vite with custom configuration for Replit environment
- **Routing**: Wouter (lightweight React router)
- **State Management**: TanStack React Query for server state
- **UI Components**: shadcn/ui component library built on Radix UI primitives
- **Styling**: Tailwind CSS with CSS custom properties for theming (light/dark mode support)
- **Drag and Drop**: @hello-pangea/dnd for task reordering
- **Form Handling**: React Hook Form with Zod validation

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript (ESM modules)
- **Build**: esbuild for production bundling, tsx for development
- **Authentication**: Passport.js with Google OAuth 2.0 strategy
- **Session Management**: express-session with PostgreSQL session store (connect-pg-simple)
- **Scheduled Jobs**: node-cron for midnight task rescheduling (server time)

### Data Storage
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM with drizzle-zod for schema validation
- **Schema Location**: `shared/schema.ts` contains all table definitions
- **Task Storage**: Tasks live in Google Calendar events and are mapped to `CalendarTask` on read
- **Tables**:
  - `users`: Google OAuth credentials and tokens (encrypted at rest)
  - `user_settings`: Calendar preferences (calendar ID, work hours, timezone, default duration, event color)
  - `user_sessions`: express-session store (connect-pg-simple)

### API Structure
- RESTful API endpoints under `/api/` prefix
- Authentication endpoints: `/api/auth/google`, `/api/auth/google/callback`, `/api/auth/logout`, `/api/auth/user`
- Task endpoints: `/api/tasks` (list + create), `/api/tasks/:id` (complete/redo), `/api/tasks/reorder`, `/api/tasks/reschedule-all`, `/api/tasks/reload`, `/api/tasks/:id/complete`, `/api/tasks/:id/reschedule`, `/api/tasks/bulk-complete`
- Settings endpoints: `/api/settings`, `/api/calendars`
- Action tokens for calendar event links (complete/reschedule tasks via URL)
- Non-GET requests require `X-CSRF-Token` from `/api/auth/user`

### Key Design Patterns
- **Shared Types**: Schema definitions in `shared/` directory used by both frontend and backend
- **Token-based Actions**: Secure tokens for calendar event action links that expire after 7 days
- **Automatic Scheduling**: Tasks are scheduled to first available free slot within user's work hours
- **Event Identification**: App-created calendar events marked with `[CalTodo]` identifier to avoid touching other events

## External Dependencies

### Google APIs
- **Google Calendar API**: Read/write access for event creation, modification, and deletion
- **Google OAuth 2.0**: User authentication with offline access for token refresh
- **Required Scopes**: `profile`, `email`, `calendar`, `calendar.events`

### Environment Variables Required
- `DATABASE_URL`: PostgreSQL connection string
- `GOOGLE_CLIENT_ID`: Google OAuth client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `SESSION_SECRET`: Secret for session encryption (min 32 chars)
- `ACTION_TOKEN_SECRET`: Secret for action links (min 32 chars, must differ from SESSION_SECRET)
- `TOKEN_ENCRYPTION_KEY`: Secret for encrypting OAuth tokens (min 32 chars)
- `PRODUCTION_APP_URL`: Required in production for action links and secure cookies

### Database
- PostgreSQL with session table auto-creation
- Drizzle Kit migrations (`npm run db:generate` + `npm run db:migrate`; also runs on server start)

### Third-Party UI Libraries
- Full shadcn/ui component set (40+ Radix-based components)
- Lucide React for icons
- react-icons for Google branding
- date-fns for date formatting
