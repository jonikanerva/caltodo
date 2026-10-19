# ADR 0002: Sessions in a new table, and the Google sign-in

- Status: accepted; `user_sessions` is dropped (update of 2026-10-19)
- Date: 2026-10-14

## Context

The Node server kept sessions with express-session and connect-pg-simple in the table `user_sessions` (cookie `connect.sid`). Passport did the Google sign-in.

- `STACK.md` §2.5 of the profile names tower-sessions with a maintained store. The inspected `tower-sessions-sqlx-store` 0.15.0 uses SQLx 0.8. This server uses SQLx 0.9 (ADR 0003). Two SQLx versions mean two connection pools for one database.
- The session data of express-session is a Node-specific JSON format with a signature in the cookie that only `cookie-signature` with the same secret can check. A shared format between the two servers adds risk with no user value.
- Owner decision (P2): a new session table through tower-sessions 0.15 and a first-party SQLx 0.9 `SessionStore`, a new cookie name, and one new sign-in for each user. Do not drop or change `user_sessions`.

## Decision

1. `crates/server/src/db/sessions.rs` implements the tower-sessions `SessionStore` trait on the SQLx pool of the server. The table is `app_sessions` (`migrations/0002_app_sessions.sql`): the session id, the user id, the JSON data, and the expiry instant.
2. The cookie is `caltodo.sid`. It holds only the session id, signed with a key that the server derives from `SESSION_SECRET` (SHA-512 with a fixed context text). It is `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production, and it expires 7 days after the last change of the session. The server ignores `connect.sid`.
3. The sign-in uses the `oauth2` crate with the endpoints, the scopes (`profile`, `email`, `calendar`, `calendar.events`), `access_type=offline`, and `prompt=consent` of the Node server. The server adds PKCE (S256). It keeps the `state` and the PKCE verifier in the session and checks both in the callback. The user id is the OpenID `sub` of the userinfo endpoint, as Passport stored it in `users.google_id`.
4. A successful sign-in clears the session data and changes the session id (fixation protection), then stores the user id and a new CSRF token. A sign-in that starts on an action page keeps the pending action token across this change.
5. Sign-out deletes the session row and the cookie. Account deletion deletes the rows of the user in `app_sessions` and in `user_sessions`. The 01:15 job deletes expired rows of `app_sessions`.

## Threat model

- **Stolen cookie:** it gives the session for at most 7 days of inactivity. `HttpOnly` stops script access. `Secure` stops a plain-HTTP leak in production.
- **Forged cookie:** the signature stops a made-up session id. The session id is 128 random bits from tower-sessions.
- **Session fixation:** the id changes at sign-in (decision 4). A test proves that the old id stops working.
- **Cross-site request forgery:** `SameSite=Lax` and the CSRF token of every write (`STACK.md` §2.5).
- **OAuth code injection or replay:** `state` and PKCE (decision 3). A callback without the right `state` fails, and a test proves it.
- **Store failure:** a database error on session load is a 500 problem. It never signs in a user.

## Alternatives

- **`tower-sessions-sqlx-store`.** Rejected: it needs SQLx 0.8 (context).
- **Keep `user_sessions` and the express-session format.** Rejected: the owner chose one new sign-in (P2).
- **`openidconnect`.** Not chosen. The Node server used the userinfo endpoint and stored its `sub`. The `oauth2` crate with the same endpoint keeps `users.google_id` the same with less code. An ID-token check would add no value, because the server reads the profile over TLS from Google directly.

## Consequences

- Each user signs in once after the release.
- The first-party store needs an independent security review (`STACK.md` §13).
- `user_sessions` stays. Its rows expire. A later change can drop it when a revert to the Node server is no longer needed.

## Cost of reversal

Low. A revert to the Node server uses `user_sessions` again. The users sign in once more.

## Update 2026-10-19: `user_sessions` is dropped

The owner ended the Node rollback path (issue #5, item 17). Migration `0003_drop_user_sessions.sql` drops `user_sessions` and its rows.

- Account deletion deletes the rows of the user in `app_sessions` only (decision 5).
- A revert to the Node server is no longer possible. The cost of reversal above no longer applies. The restore path for the dropped rows is a Railway PostgreSQL backup.
