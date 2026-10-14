//! `action_tokens`: the hashes of the action links.
//!
//! `expires_at`, `used_at`, and `created_at` are naive `timestamp` columns
//! with UTC wall-clock time ([`super::naive_utc`]). `created_at` comes from
//! the column default `now()`, like on the Node server.

use caltodo_domain::ids::{CalendarId, EventId, UserId};
use jiff::Timestamp;

use super::{Store, StoreError, naive_utc};

/// A stored token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionTokenRecord {
    pub id: String,
    pub user_id: UserId,
    pub event_id: EventId,
    pub calendar_id: CalendarId,
    /// `None` when the stored value is outside the instant range of Jiff.
    pub expires_at: Option<Timestamp>,
    pub used: bool,
}

/// A new token row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewActionToken<'a> {
    pub token_hash: &'a str,
    pub user_id: &'a UserId,
    pub event_id: &'a EventId,
    pub calendar_id: &'a CalendarId,
    pub expires_at: Timestamp,
}

impl Store {
    /// Stores a token and returns its id.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn create_action_token(
        &self,
        token: &NewActionToken<'_>,
    ) -> Result<String, StoreError> {
        Ok(sqlx::query_scalar!(
            "INSERT INTO action_tokens (token_hash, user_id, event_id, calendar_id, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id",
            token.token_hash,
            token.user_id.as_str(),
            token.event_id.as_str(),
            token.calendar_id.as_str(),
            naive_utc::to_db(token.expires_at) as _,
        )
        .fetch_one(&self.pool)
        .await?)
    }

    /// The token with this hash.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn action_token_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<ActionTokenRecord>, StoreError> {
        let row = sqlx::query!(
            r#"SELECT id, user_id, event_id, calendar_id,
                      expires_at AS "expires_at: jiff_sqlx::DateTime",
                      used_at AS "used_at: jiff_sqlx::DateTime"
                 FROM action_tokens WHERE token_hash = $1"#,
            token_hash
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| {
            Some(ActionTokenRecord {
                id: row.id,
                user_id: UserId::new(row.user_id)?,
                event_id: EventId::new(row.event_id)?,
                calendar_id: CalendarId::new(row.calendar_id)?,
                expires_at: naive_utc::from_db(row.expires_at),
                used: row.used_at.is_some(),
            })
        }))
    }

    /// Marks an unused token as used. `false` when the token is missing or
    /// already used, so two requests cannot both consume it.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn mark_action_token_used(
        &self,
        id: &str,
        now: Timestamp,
    ) -> Result<bool, StoreError> {
        let marked = sqlx::query!(
            "UPDATE action_tokens SET used_at = $2 WHERE id = $1 AND used_at IS NULL",
            id,
            naive_utc::to_db(now) as _,
        )
        .execute(&self.pool)
        .await?;
        Ok(marked.rows_affected() > 0)
    }

    /// Marks every other unused token of an event as used, so only the
    /// newest link of the event works.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn invalidate_event_tokens(
        &self,
        user: &UserId,
        event: &EventId,
        calendar: &CalendarId,
        keep_hash: &str,
        now: Timestamp,
    ) -> Result<(), StoreError> {
        sqlx::query!(
            "UPDATE action_tokens SET used_at = $5
              WHERE user_id = $1 AND event_id = $2 AND calendar_id = $3
                AND used_at IS NULL AND token_hash <> $4",
            user.as_str(),
            event.as_str(),
            calendar.as_str(),
            keep_hash,
            naive_utc::to_db(now) as _,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Deletes the expired tokens and the tokens used before `used_before`.
    /// Returns the number of deleted rows.
    ///
    /// # Errors
    ///
    /// A query fails.
    pub async fn cleanup_action_tokens(
        &self,
        now: Timestamp,
        used_before: Timestamp,
    ) -> Result<u64, StoreError> {
        let expired = sqlx::query!(
            "DELETE FROM action_tokens WHERE expires_at < $1",
            naive_utc::to_db(now) as _,
        )
        .execute(&self.pool)
        .await?;
        let used = sqlx::query!(
            "DELETE FROM action_tokens WHERE used_at IS NOT NULL AND used_at < $1",
            naive_utc::to_db(used_before) as _,
        )
        .execute(&self.pool)
        .await?;
        Ok(expired.rows_affected() + used.rows_affected())
    }
}
