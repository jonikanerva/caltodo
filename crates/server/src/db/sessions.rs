//! The tower-sessions store on `app_sessions` (ADR 0002).
//!
//! tower-sessions-sqlx-store 0.15 depends on SQLx 0.8, and this server uses
//! SQLx 0.9, so this small adapter implements the store trait on the same
//! pool. The record data is JSON; the store copies the signed-in user id of
//! the data into `user_id`, so the account deletion can find the sessions
//! of a user. Only `create` inserts a row; `save` only updates one.

use jiff::Timestamp;
use serde_json::Value;
use sqlx::PgPool;
use tower_sessions::session::{Id, Record};
use tower_sessions::session_store::{self, SessionStore};

use super::StoreError;

/// The session data key of the signed-in user id.
pub const USER_ID_KEY: &str = "user_id";

/// The most attempts to find a free session id. A collision of two random
/// 128-bit ids does not happen in practice; the bound keeps the loop finite.
const CREATE_ATTEMPTS: usize = 8;

/// The session store.
#[derive(Debug, Clone)]
pub struct PgSessionStore {
    pool: PgPool,
}

impl PgSessionStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Deletes the expired sessions. Returns the number of deleted rows.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn delete_expired(&self, now: Timestamp) -> Result<u64, StoreError> {
        let deleted = sqlx::query!(
            "DELETE FROM app_sessions WHERE expiry_date < $1",
            jiff_sqlx::Timestamp::from(now) as _,
        )
        .execute(&self.pool)
        .await?;
        Ok(deleted.rows_affected())
    }
}

fn backend(_: sqlx::Error) -> session_store::Error {
    session_store::Error::Backend("session query failed".to_owned())
}

fn expiry(record: &Record) -> session_store::Result<jiff_sqlx::Timestamp> {
    let nanos = record.expiry_date.unix_timestamp_nanos();
    Timestamp::from_nanosecond(nanos)
        .map(jiff_sqlx::Timestamp::from)
        .map_err(|_| session_store::Error::Encode("session expiry out of range".to_owned()))
}

fn data(record: &Record) -> session_store::Result<Value> {
    serde_json::to_value(&record.data)
        .map_err(|_| session_store::Error::Encode("session data is not JSON".to_owned()))
}

fn user_id(record: &Record) -> Option<String> {
    record
        .data
        .get(USER_ID_KEY)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[async_trait::async_trait]
impl SessionStore for PgSessionStore {
    async fn create(&self, record: &mut Record) -> session_store::Result<()> {
        let data = data(record)?;
        let expiry = expiry(record)?;
        let user = user_id(record);
        for _ in 0..CREATE_ATTEMPTS {
            let inserted = sqlx::query!(
                "INSERT INTO app_sessions (id, user_id, data, expiry_date)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO NOTHING",
                record.id.to_string(),
                user,
                data,
                expiry as _,
            )
            .execute(&self.pool)
            .await
            .map_err(backend)?;
            if inserted.rows_affected() == 1 {
                return Ok(());
            }
            record.id = Id::default();
        }
        Err(session_store::Error::Backend(
            "no free session id".to_owned(),
        ))
    }

    /// Updates a session that exists and has not expired. It never inserts.
    ///
    /// tower-sessions 0.15 (`Session::save`) calls `save` for a session id
    /// from the request cookie. A new session, a session after `cycle_id`,
    /// and a session whose row did not load go to `create`. In this server
    /// each change of session data loads the row first (`Session::clear`
    /// does not, but `sign_in` follows it with `cycle_id`). If the row is gone
    /// when the request ends (sign-out, the sign-in id change, or account
    /// deletion in a concurrent request), an insert would bring the old
    /// data back, with the user id, and sign the browser in again (issue #5
    /// item 11). So zero updated rows write nothing. The result is still
    /// `Ok`: an error makes tower-sessions replace the answer of the request
    /// with an empty 500, although the request itself succeeded. The cookie
    /// of that answer names a session that does not exist, so the next
    /// request starts a new, signed-out session.
    async fn save(&self, record: &Record) -> session_store::Result<()> {
        sqlx::query!(
            "UPDATE app_sessions
             SET user_id = $2, data = $3, expiry_date = $4
             WHERE id = $1 AND expiry_date > now()",
            record.id.to_string(),
            user_id(record),
            data(record)?,
            expiry(record)? as _,
        )
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(())
    }

    async fn load(&self, session_id: &Id) -> session_store::Result<Option<Record>> {
        let row = sqlx::query!(
            r#"SELECT data, expiry_date AS "expiry_date: jiff_sqlx::Timestamp"
                 FROM app_sessions WHERE id = $1 AND expiry_date > now()"#,
            session_id.to_string(),
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(backend)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let data = serde_json::from_value(row.data)
            .map_err(|_| session_store::Error::Decode("session data is invalid".to_owned()))?;
        let nanos = row.expiry_date.to_jiff().as_nanosecond();
        let expiry_date = time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
            .map_err(|_| session_store::Error::Decode("session expiry is invalid".to_owned()))?;
        Ok(Some(Record {
            id: *session_id,
            data,
            expiry_date,
        }))
    }

    async fn delete(&self, session_id: &Id) -> session_store::Result<()> {
        sqlx::query!(
            "DELETE FROM app_sessions WHERE id = $1",
            session_id.to_string()
        )
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(())
    }
}
