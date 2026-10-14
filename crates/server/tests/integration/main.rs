//! The integration tests of the server: one test binary, so the harness in
//! `support.rs` compiles once.
//!
//! The tests that need PostgreSQL use `#[sqlx::test]`: each test gets its own
//! database on the server of `DATABASE_URL` (`mise run db:start`).

#![expect(
    clippy::unwrap_used,
    clippy::panic,
    reason = "the helpers of this test binary fail a check by panicking"
)]

mod api_actions;
mod api_auth;
mod api_security;
mod api_tasks;
mod contract;
mod google_http;
mod jobs;
mod reschedule_golden;
mod schema;
mod storage;
mod support;
mod vectors;
