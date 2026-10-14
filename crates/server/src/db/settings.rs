//! `user_settings`: one row per user.

use caltodo_domain::ids::UserId;

use super::{Store, StoreError};

/// A stored settings row, as the API returns it.
///
/// The values are the stored values: the database permits values that the
/// settings form never sends, so the scheduler validates them before use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsRow {
    pub id: String,
    pub user_id: String,
    pub calendar_id: Option<String>,
    pub work_start_hour: i32,
    pub work_end_hour: i32,
    pub timezone: String,
    pub default_duration: i32,
    pub event_color: String,
}

/// A validated settings change (`PATCH /api/settings`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsChange {
    /// `None` keeps the stored calendar; `Some` replaces it.
    pub calendar_id: Option<String>,
    pub work_start_hour: i32,
    pub work_end_hour: i32,
    pub timezone: String,
    pub default_duration: i32,
    pub event_color: String,
}

impl Store {
    /// The settings of a user.
    ///
    /// # Errors
    ///
    /// The query fails.
    pub async fn settings(&self, user: &UserId) -> Result<Option<SettingsRow>, StoreError> {
        Ok(sqlx::query_as!(
            SettingsRow,
            "SELECT id, user_id, calendar_id, work_start_hour, work_end_hour, timezone,
                    default_duration, event_color
               FROM user_settings WHERE user_id = $1",
            user.as_str()
        )
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Updates the settings of a user, or creates them (one statement, so a
    /// concurrent first save cannot fail on the unique user id). A change
    /// without a calendar keeps the stored calendar; a new row then has none.
    ///
    /// # Errors
    ///
    /// The query fails, for example for a user that no longer exists.
    pub async fn save_settings(
        &self,
        user: &UserId,
        change: &SettingsChange,
    ) -> Result<SettingsRow, StoreError> {
        Ok(sqlx::query_as!(
            SettingsRow,
            "INSERT INTO user_settings
               (user_id, calendar_id, work_start_hour, work_end_hour, timezone,
                default_duration, event_color)
             VALUES ($1, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id) DO UPDATE SET
               calendar_id = CASE WHEN $2 THEN EXCLUDED.calendar_id
                                  ELSE user_settings.calendar_id END,
               work_start_hour = EXCLUDED.work_start_hour,
               work_end_hour = EXCLUDED.work_end_hour,
               timezone = EXCLUDED.timezone,
               default_duration = EXCLUDED.default_duration,
               event_color = EXCLUDED.event_color
             RETURNING id, user_id, calendar_id, work_start_hour, work_end_hour, timezone,
                       default_duration, event_color",
            user.as_str(),
            change.calendar_id.is_some(),
            change.calendar_id,
            change.work_start_hour,
            change.work_end_hour,
            change.timezone,
            change.default_duration,
            change.event_color,
        )
        .fetch_one(&self.pool)
        .await?)
    }
}
