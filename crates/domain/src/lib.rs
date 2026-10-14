//! The caltodo domain: the rules of tasks that live as Google Calendar
//! events, the free-slot search, and the validated user settings.
//!
//! The crate is pure. It reads no clock, environment, file, or random source
//! (`crates/domain/clippy.toml` bans these calls). The server passes the
//! current time, the time zone rules, and the decoded calendar events in.
//!
//! The rules preserve the behaviour of the replaced Node server. A comment
//! that names a `server/*.ts` file refers to that server; read it with
//! `git show <commit>:<path>` at the commit before its removal. The golden
//! fixtures in `tests/fixtures/` come from that server.

pub mod event;
pub mod ids;
pub mod instant;
pub mod reorder;
pub mod schedule;
pub mod settings;
pub mod task;
pub mod text;
