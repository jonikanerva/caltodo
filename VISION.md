# Product Vision

> Draft from `README.md` and the behaviour of the Node server (2026-10-14).
> The owner must confirm each section marked **(owner to confirm)**. Until
> then, the current behaviour of the app is the product direction.

## Vision

A person writes down a task and the task gets a time in their own calendar. They do not plan the time themselves, and they do not keep a separate todo list.

## Goal

Each task is an event in the user's Google Calendar, in the first free slot within the user's work hours. Incomplete tasks move forward automatically.

## Audience and environment

- **(owner to confirm)** People with a Google account who plan their work day in Google Calendar. The service runs at one public address on Railway.
- The user works in a desktop or a mobile browser. The calendar app (Google Calendar) is the second place where the user sees and acts on tasks, through the action links in the event description.
- Constraints: Google OAuth with calendar scopes; Google's API limits; the user's time zone and work hours.

## Core Principles

- **The calendar is the source of truth.** Tasks are Google Calendar events. The app stores no task copy. The app changes only the events that it created (the private extended property `caltodo`).
- **Automatic scheduling.** The user never picks a time. The app picks the first free slot within the work hours, and moves incomplete tasks forward.
- **Small and quick.** One list, one form, one settings page. No projects, labels, or sharing.
- **Minimum data.** The server keeps only what sign-in, settings, and action links need (see below).

## Product Shape

- Sign in with Google. A new user gets default settings (9 to 17, America/New_York, 60 minutes, color 1) and selects a calendar.
- Create a task: title, optional details, optional urgent flag, and a duration. The app finds a slot and creates the event. An urgent task moves to the first slot, and the other tasks move after it.
- The task list shows incomplete tasks in time order and completed tasks in a collapsible section. The user can complete, reopen, and reorder tasks (reorder swaps the time slots).
- "Reload" reads the event times from Google Calendar. "Reschedule all" moves each incomplete task to the next free slot. A job does the same each night at 00:00 in the server time zone.
- Each event description has a "Manage" link. The link opens an action page that completes or reschedules the task without the app. A link works once and for 7 days.
- Failure states: no calendar selected (an alert with a link to settings), no free slot in 90 days (an error message), Google unavailable (an error message), and a signed-out user (the sign-in page).

## Non-Goals & Drift Guardrails

- **(owner to confirm)** Not a general project manager: no projects, labels, shared lists, or comments.
- No task store outside Google Calendar.
- No calendar other than Google Calendar.
- No analytics, tracking, or third-party telemetry.

## Decision Filter

- Does the change keep Google Calendar as the only task store?
- Does the change keep scheduling automatic, without a manual time choice?
- Does the change add personal data to the server? If yes, it needs an update of the privacy posture below and owner approval.

## Success Definition

- **(owner to confirm)** A user creates a task in a few seconds and sees it in Google Calendar at a sensible time.
- Incomplete tasks never stay in the past after the nightly job.
- An action link from the calendar completes or reschedules the task.
- A Google failure shows an error. It never shows an empty or wrong task list as a success.

## Persistence and Privacy Posture

| Data or capability                                             | Purpose                               | Storage or recipient                            | Retention or expiry                               |
| -------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Google user id (OpenID `sub`), email, display name             | Sign-in and the header avatar         | PostgreSQL `users`                              | Until account deletion                            |
| Google OAuth access and refresh tokens                         | Calendar access on behalf of the user | PostgreSQL `users`, encrypted (AES-256-GCM)     | Until account deletion or a new sign-in           |
| Settings (calendar id, work hours, time zone, duration, color) | Scheduling                            | PostgreSQL `user_settings`                      | Until account deletion                            |
| Action link tokens (hash only), event id, calendar id          | Action links in event descriptions    | PostgreSQL `action_tokens`                      | Deleted after expiry, or 30 days after use        |
| Session (user id, CSRF token, sign-in state)                   | Signed-in browser                     | PostgreSQL `app_sessions`; cookie `caltodo.sid` | 7 days after the last change; deleted at sign-out |
| Tasks (title, details, time, completion)                       | The product                           | Google Calendar only                            | Under the user's control in Google Calendar       |

- Forbidden data flows: task text, tokens, or personal data in logs; any third party other than Google.
- Telemetry and diagnostics: none in the browser. The server writes structured logs with allowlisted fields (route, status, timing, counts) to Railway.
- Approved deletion policies: account deletion removes the user, the settings, the action tokens, and the sessions of the user. The events in Google Calendar stay, because they belong to the user's calendar.

## Open Questions (optional)

- The owner confirms the sections marked above.
