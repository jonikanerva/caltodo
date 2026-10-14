//! The caltodo server: tasks that live as Google Calendar events and move
//! into free time slots. `VISION.md` describes the product and `STACK.md`
//! the module responsibilities.
//!
//! Dependency direction: `http` → `application` → `domain`. `google`
//! implements the ports of `application`; `db` holds the SQL. `config` reads
//! the environment once. `wiring` connects the concrete services.
//! `lifecycle` runs the server with its shutdown deadline. `domain` is the
//! separate crate `caltodo-domain` (`crates/domain`).
//!
//! This crate replaced a Node server (ADR 0001). A comment that names a
//! `server/*.ts` file refers to that server; read the file with
//! `git show <commit>:<path>` at the commit before its removal.

pub use caltodo_domain as domain;

pub mod application;
pub mod config;
pub mod db;
pub mod fakes;
pub mod google;
pub mod http;
pub mod lifecycle;
pub mod observability;
pub mod security;
pub mod wiring;
