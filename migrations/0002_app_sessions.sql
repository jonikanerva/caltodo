-- The session table of the Rust server (ADR 0002). It replaces
-- `user_sessions`, which stays for a revert to the Node server.
--
-- `user_id` copies the signed-in user of the session data, so an account
-- deletion can remove the sessions of that user. It has no foreign key: the
-- Node server deletes users without knowing this table, and a revert must
-- keep working.
CREATE TABLE IF NOT EXISTS "app_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" varchar,
  "data" jsonb NOT NULL,
  "expiry_date" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "app_sessions_expiry_date_idx" ON "app_sessions" ("expiry_date");
CREATE INDEX IF NOT EXISTS "app_sessions_user_id_idx" ON "app_sessions" ("user_id");
