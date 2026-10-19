//! Cargo build script of the server crate.
//!
//! `sqlx::migrate!` in `src/db/mod.rs` embeds the files of `migrations/` at
//! compile time. On stable Rust, SQLx cannot tell Cargo to watch that
//! directory, so a change that only adds a migration could reuse a binary
//! without it. The SQLx documentation of `migrate!` recommends this build
//! script for that reason.

// Clippy does not apply `print_stdout` to build scripts: Cargo reads their
// instructions from standard output.
fn main() {
    println!("cargo:rerun-if-changed=../../migrations");
}
