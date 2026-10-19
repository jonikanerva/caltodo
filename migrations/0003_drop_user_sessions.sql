-- Drops `user_sessions`, the session table of the Node server.
--
-- The Rust server keeps its sessions in `app_sessions` (ADR 0002). The rows
-- of `user_sessions` are Node sessions; no server reads them. The owner ended
-- the rollback path to the Node server on 2026-10-19 (issue #5, item 17), so
-- the table has no use. Its constraints and indexes go with the table.
--
-- `IF EXISTS` lets the migration run on a database without the table.
-- This change deletes data. The restore path is a Railway PostgreSQL backup.
DROP TABLE IF EXISTS "user_sessions";
