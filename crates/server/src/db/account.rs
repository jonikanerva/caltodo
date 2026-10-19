//! The deletion of a user's data (`DELETE /api/account`).

use caltodo_domain::ids::UserId;

use super::{Store, StoreError};

impl Store {
    /// Deletes the stored data of a user in one transaction: the action
    /// tokens, the settings, the user row, and the sessions. The calendar
    /// events stay in Google Calendar.
    ///
    /// # Errors
    ///
    /// A query fails; the transaction then changes nothing.
    pub async fn delete_user_data(&self, user: &UserId) -> Result<(), StoreError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query!(
            "DELETE FROM action_tokens WHERE user_id = $1",
            user.as_str()
        )
        .execute(&mut *transaction)
        .await?;
        sqlx::query!(
            "DELETE FROM user_settings WHERE user_id = $1",
            user.as_str()
        )
        .execute(&mut *transaction)
        .await?;
        sqlx::query!("DELETE FROM users WHERE id = $1", user.as_str())
            .execute(&mut *transaction)
            .await?;
        sqlx::query!("DELETE FROM app_sessions WHERE user_id = $1", user.as_str())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }
}
