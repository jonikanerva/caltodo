//! `users`: the Google account of each user and its OAuth tokens.
//!
//! The tokens are stored encrypted (`security::token_cipher`). A read
//! decrypts them; a stored value that does not decrypt reads as no token,
//! like on the Node server.

use caltodo_domain::ids::UserId;

use super::{Store, StoreError};
use crate::config::Secret;
use crate::security::RandomUnavailable;

/// A user with decrypted tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: UserId,
    /// The OpenID `sub` of the Google account.
    pub google_id: String,
    pub email: String,
    pub display_name: String,
    pub access_token: Option<Secret>,
    pub refresh_token: Option<Secret>,
}

/// The Google profile of a sign-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewUser {
    pub google_id: String,
    pub email: String,
    pub display_name: String,
}

/// A user write failed.
#[derive(Debug, thiserror::Error)]
pub enum UserWriteError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Random(#[from] RandomUnavailable),
}

impl From<sqlx::Error> for UserWriteError {
    fn from(error: sqlx::Error) -> Self {
        Self::Store(StoreError::from(error))
    }
}

struct UserRow {
    id: String,
    google_id: String,
    email: String,
    display_name: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
}

impl Store {
    fn user_of_row(&self, row: UserRow) -> Option<User> {
        Some(User {
            id: UserId::new(row.id)?,
            google_id: row.google_id,
            email: row.email,
            display_name: row.display_name,
            access_token: self.decrypt(row.access_token.as_deref()),
            refresh_token: self.decrypt(row.refresh_token.as_deref()),
        })
    }

    /// `decryptToken(value) ?? null`: an empty stored value stays an empty
    /// token; the caller treats an empty access token as no access.
    fn decrypt(&self, stored: Option<&str>) -> Option<Secret> {
        stored
            .and_then(|value| self.cipher.decrypt(value))
            .map(Secret::new)
    }

    fn encrypt(&self, token: Option<&Secret>) -> Result<Option<String>, RandomUnavailable> {
        token
            .map(|token| self.cipher.encrypt(token.expose()))
            .transpose()
    }

    /// The user with this id.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn user(&self, id: &UserId) -> Result<Option<User>, StoreError> {
        let row = sqlx::query_as!(
            UserRow,
            "SELECT id, google_id, email, display_name, access_token, refresh_token
               FROM users WHERE id = $1",
            id.as_str()
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| self.user_of_row(row)))
    }

    /// The user with this Google account id.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn user_by_google_id(&self, google_id: &str) -> Result<Option<User>, StoreError> {
        let row = sqlx::query_as!(
            UserRow,
            "SELECT id, google_id, email, display_name, access_token, refresh_token
               FROM users WHERE google_id = $1",
            google_id
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| self.user_of_row(row)))
    }

    /// Records a sign-in (the Google strategy of `server/auth.ts`).
    ///
    /// An existing user gets the new access token, and the new refresh token
    /// when Google sent one. A new user also gets the default settings: work
    /// hours 9 to 17, `America/New_York`, 60 minutes, and color `1`. Both
    /// writes of a new user are one transaction.
    ///
    /// # Errors
    ///
    /// A query fails, or no random nonce is available for the encryption.
    pub async fn record_sign_in(
        &self,
        profile: &NewUser,
        access_token: &Secret,
        refresh_token: Option<&Secret>,
    ) -> Result<User, UserWriteError> {
        if let Some(existing) = self.user_by_google_id(&profile.google_id).await? {
            let refresh = refresh_token.or(existing.refresh_token.as_ref());
            return self
                .update_tokens(&existing.id, access_token, refresh)
                .await?
                .ok_or_else(|| UserWriteError::Store(StoreError(sqlx::Error::RowNotFound)));
        }
        let access = self.encrypt(Some(access_token))?;
        let refresh = self.encrypt(refresh_token)?;
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query_as!(
            UserRow,
            "INSERT INTO users (google_id, email, display_name, access_token, refresh_token)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, google_id, email, display_name, access_token, refresh_token",
            profile.google_id,
            profile.email,
            profile.display_name,
            access,
            refresh,
        )
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query!(
            "INSERT INTO user_settings
               (user_id, work_start_hour, work_end_hour, timezone, default_duration, event_color)
             VALUES ($1, 9, 17, 'America/New_York', 60, '1')",
            row.id,
        )
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.user_of_row(row)
            .ok_or_else(|| UserWriteError::Store(StoreError(sqlx::Error::RowNotFound)))
    }

    /// Stores new tokens. A missing refresh token clears the stored one,
    /// like the Node `updateUser` with `refreshToken: undefined || null`.
    ///
    /// # Errors
    ///
    /// The query fails, or no random nonce is available.
    pub async fn update_tokens(
        &self,
        id: &UserId,
        access_token: &Secret,
        refresh_token: Option<&Secret>,
    ) -> Result<Option<User>, UserWriteError> {
        let access = self.encrypt(Some(access_token))?;
        let refresh = self.encrypt(refresh_token)?;
        let row = sqlx::query_as!(
            UserRow,
            "UPDATE users SET access_token = $2, refresh_token = $3 WHERE id = $1
             RETURNING id, google_id, email, display_name, access_token, refresh_token",
            id.as_str(),
            access,
            refresh,
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| self.user_of_row(row)))
    }

    /// The users with a configured calendar, for the midnight reschedule.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn users_with_calendar(&self) -> Result<Vec<UserId>, StoreError> {
        let ids = sqlx::query_scalar!(
            "SELECT u.id FROM users u
               JOIN user_settings s ON s.user_id = u.id
              WHERE s.calendar_id IS NOT NULL AND s.calendar_id <> ''
              ORDER BY u.id"
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(ids.into_iter().filter_map(UserId::new).collect())
    }
}
