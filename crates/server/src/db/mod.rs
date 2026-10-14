//! PostgreSQL: the connection pool, the migrations, and the queries.
//!
//! Every query is a checked SQLx macro; `.sqlx/` holds the offline metadata.
//! A query failure becomes [`StoreError`] with a fixed text: a SQL error can
//! contain stored values, so it never reaches a log or a response.

pub mod account;
pub mod action_tokens;
pub mod sessions;
pub mod settings;
pub mod users;

use std::time::Duration;

use sqlx::PgPool;
use sqlx::migrate::Migrator;
use sqlx::postgres::PgPoolOptions;

use crate::config::Secret;
use crate::security::token_cipher::TokenCipher;

/// The migrations in `migrations/`, embedded in the binary.
pub static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// The most connections of the pool. One web process serves one user group;
/// the Node server used the `pg` default of 10.
const MAX_CONNECTIONS: u32 = 5;
/// The longest wait for a free connection.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

/// A database operation failed.
#[derive(Debug, thiserror::Error)]
#[error("database operation failed")]
pub struct StoreError(#[source] sqlx::Error);

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        Self(error)
    }
}

/// The schema does not have every embedded migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the database schema is not migrated; run `caltodo migrate`")]
pub struct NotMigrated;

/// Opens the pool.
///
/// # Errors
///
/// The database is unreachable or rejects the connection.
pub async fn connect(url: &Secret) -> Result<PgPool, StoreError> {
    Ok(PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(ACQUIRE_TIMEOUT)
        .connect(url.expose())
        .await?)
}

/// Applies the pending migrations (`caltodo migrate`).
///
/// # Errors
///
/// A migration fails, or an applied migration has another checksum.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}

/// Checks that every embedded migration is applied. `caltodo serve` runs
/// this check, so a release never serves a schema it does not know.
///
/// # Errors
///
/// [`NotMigrated`], or the ledger query fails.
pub async fn ensure_migrated(pool: &PgPool) -> Result<(), StoreError> {
    let applied: Vec<i64> = sqlx::query_scalar!(
        r#"SELECT version AS "version!" FROM _sqlx_migrations WHERE success ORDER BY version"#
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let missing = MIGRATOR
        .iter()
        .any(|migration| !applied.contains(&migration.version));
    if missing {
        return Err(StoreError(sqlx::Error::Protocol(NotMigrated.to_string())));
    }
    Ok(())
}

/// One round trip to the database, for `GET /readyz`.
///
/// # Errors
///
/// The database does not answer.
pub async fn ping(pool: &PgPool) -> Result<(), StoreError> {
    sqlx::query_scalar!(r#"SELECT 1 AS "one!""#)
        .fetch_one(pool)
        .await?;
    Ok(())
}

/// The conversion of the naive `timestamp` columns of `action_tokens`.
///
/// The values are UTC wall-clock time, whatever the process time zone is
/// (ADR 0003). The Node server wrote them through drizzle-orm 0.45.1:
/// `pg-core/columns/timestamp.js` writes `Date.toISOString()` and reads
/// `value + "+0000"`, and `node-postgres/session.js` turns off the pg
/// TIMESTAMP parser. `tests/fixtures/node/naive_timestamps.golden.json`
/// records this from the real Node code with `TZ=Europe/Helsinki`. The
/// conversion has no zone setting on purpose: `TZ` sets only the job times.
pub mod naive_utc {
    use jiff::Timestamp;
    use jiff::tz::TimeZone;

    /// The UTC wall-clock value of an instant, at millisecond precision like
    /// a JavaScript `Date`.
    #[must_use]
    pub fn to_db(instant: Timestamp) -> jiff_sqlx::DateTime {
        let instant = caltodo_domain::instant::to_millis(instant);
        jiff_sqlx::DateTime::from(TimeZone::UTC.to_datetime(instant))
    }

    /// The instant of a stored UTC wall-clock value, or `None` outside the
    /// instant range of Jiff.
    #[must_use]
    pub fn from_db(value: jiff_sqlx::DateTime) -> Option<Timestamp> {
        TimeZone::UTC.to_timestamp(value.to_jiff()).ok()
    }
}

/// The database access of the server: the pool and the token cipher.
#[derive(Debug, Clone)]
pub struct Store {
    pool: PgPool,
    cipher: TokenCipher,
}

impl Store {
    #[must_use]
    pub fn new(pool: PgPool, cipher: TokenCipher) -> Self {
        Self { pool, cipher }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}
