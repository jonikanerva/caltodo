//! The JSON bodies of the `/api` routes. The success shapes are the shapes
//! of the Node server, so the client reads the same fields.

use caltodo_domain::instant::to_iso;
use caltodo_domain::schedule::RescheduleSummary;
use caltodo_domain::task::Task;
use serde::Serialize;
use utoipa::ToSchema;

use crate::application::ports::CalendarSummary;
use crate::db::settings::SettingsRow;
use crate::db::users::User;

/// The signed-in user (`GET /api/auth/user`).
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    /// The Google account id.
    pub google_id: String,
    pub email: String,
    pub display_name: String,
    /// The CSRF token of the session. Send it as `X-CSRF-Token` on every
    /// request that is not GET, HEAD, or OPTIONS.
    pub csrf_token: String,
}

impl AuthUser {
    #[must_use]
    pub fn new(user: &User, csrf_token: String) -> Self {
        Self {
            id: user.id.to_string(),
            google_id: user.google_id.clone(),
            email: user.email.clone(),
            display_name: user.display_name.clone(),
            csrf_token,
        }
    }
}

/// A success without other data.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
pub struct Success {
    /// Always `true`.
    pub success: bool,
}

impl Success {
    pub const OK: Self = Self { success: true };
}

/// The settings of a user.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub id: String,
    pub user_id: String,
    /// The Google Calendar id for the tasks; `null` until the user selects one.
    #[schema(required = true)]
    pub calendar_id: Option<String>,
    /// The first work hour, 0 to 23.
    pub work_start_hour: i32,
    /// The hour by which tasks end, 0 to 23.
    pub work_end_hour: i32,
    /// An IANA time zone name.
    pub timezone: String,
    /// The default task duration in minutes.
    pub default_duration: i32,
    /// The Google Calendar color id of new events.
    pub event_color: String,
}

impl From<SettingsRow> for UserSettings {
    fn from(row: SettingsRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            calendar_id: row.calendar_id,
            work_start_hour: row.work_start_hour,
            work_end_hour: row.work_end_hour,
            timezone: row.timezone,
            default_duration: row.default_duration,
            event_color: row.event_color,
        }
    }
}

/// One calendar of the user's Google calendar list.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CalendarListItem {
    pub id: String,
    pub summary: String,
    pub primary: bool,
}

impl From<CalendarSummary> for CalendarListItem {
    fn from(calendar: CalendarSummary) -> Self {
        Self {
            id: calendar.id,
            summary: calendar.summary,
            primary: calendar.primary,
        }
    }
}

/// A task (`CalendarTask`). Instants are UTC with milliseconds, like
/// `2026-03-02T15:00:00.000Z`.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CalendarTask {
    /// The Google Calendar event id.
    pub id: String,
    pub title: String,
    #[schema(required = true)]
    pub details: Option<String>,
    /// The duration in whole minutes; `null` when the event ends at or before
    /// its start.
    #[schema(required = true)]
    pub duration: Option<i32>,
    pub scheduled_start: String,
    pub scheduled_end: String,
    pub completed: bool,
    #[schema(required = true)]
    pub completed_at: Option<String>,
    /// The position among the incomplete tasks; 0 for a completed task.
    #[schema(minimum = 0)]
    pub priority: u32,
}

impl From<&Task> for CalendarTask {
    fn from(task: &Task) -> Self {
        Self {
            id: task.id.to_string(),
            title: task.title.clone(),
            details: task.details.clone(),
            // A duration beyond the 32-bit range cannot come from a real
            // event; it reads as unknown rather than as a cut value.
            duration: task
                .duration_minutes
                .and_then(|minutes| i32::try_from(minutes).ok()),
            scheduled_start: to_iso(task.scheduled_start),
            scheduled_end: to_iso(task.scheduled_end),
            completed: task.completed,
            completed_at: task.completed_at.map(to_iso),
            priority: u32::try_from(task.priority).unwrap_or(u32::MAX),
        }
    }
}

/// The counters of "Reschedule all".
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RescheduleCounts {
    pub moved: u32,
    pub unchanged: u32,
    pub skipped_no_slot: u32,
    pub skipped_invalid: u32,
    pub failed: u32,
}

impl From<RescheduleSummary> for RescheduleCounts {
    fn from(summary: RescheduleSummary) -> Self {
        Self {
            moved: summary.moved,
            unchanged: summary.unchanged,
            skipped_no_slot: summary.skipped_no_slot,
            skipped_invalid: summary.skipped_invalid,
            failed: summary.failed,
        }
    }
}

/// The answer of `POST /api/tasks/reschedule-all`.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
pub struct RescheduleAllResult {
    /// Always `true`.
    pub success: bool,
    pub summary: RescheduleCounts,
}

// ---- Request bodies (documentation only; `http::input` validates) ----------

/// The body of `POST /api/tasks`.
#[derive(Debug, Clone, ToSchema)]
pub struct CreateTaskRequest {
    /// 1 to 200 UTF-16 code units.
    #[schema(min_length = 1, max_length = 200)]
    pub title: String,
    /// At most 5000 UTF-16 code units. Omit it rather than send `null`.
    #[schema(max_length = 5000, nullable = false)]
    pub details: Option<String>,
    /// Move the task to the front of the schedule. The default is `false`.
    #[schema(nullable = false)]
    pub urgent: Option<bool>,
    /// Whole minutes, 15 to 480. The default is the settings duration.
    #[schema(minimum = 15, maximum = 480, nullable = false)]
    pub duration: Option<i32>,
}

/// The body of `PATCH /api/tasks/{id}`.
#[derive(Debug, Clone, ToSchema)]
pub struct UpdateTaskRequest {
    pub completed: bool,
}

/// The body of `POST /api/tasks/reorder` and `/api/tasks/bulk-complete`.
#[derive(Debug, Clone, ToSchema)]
#[schema(rename_all = "camelCase")]
pub struct TaskIdsRequest {
    /// 1 to 200 non-empty task ids.
    #[schema(min_items = 1, max_items = 200)]
    pub task_ids: Vec<String>,
}

/// The body of `PATCH /api/settings`.
#[derive(Debug, Clone, ToSchema)]
#[schema(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    /// Omit to keep the current calendar.
    #[schema(nullable = false)]
    pub calendar_id: Option<String>,
    #[schema(minimum = 0, maximum = 23)]
    pub work_start_hour: i32,
    #[schema(minimum = 0, maximum = 23)]
    pub work_end_hour: i32,
    /// An IANA time zone name.
    pub timezone: String,
    #[schema(minimum = 15, maximum = 480)]
    pub default_duration: i32,
    pub event_color: String,
}

/// The action of an action link.
#[derive(Debug, Clone, Copy, ToSchema)]
#[schema(rename_all = "lowercase")]
pub enum ActionName {
    Complete,
    Reschedule,
}

/// The body of `POST /api/action/{token}`.
#[derive(Debug, Clone, ToSchema)]
#[schema(rename_all = "camelCase")]
pub struct ActionRequest {
    pub action: ActionName,
    /// The CSRF token, for a form post without the `X-CSRF-Token` header.
    #[schema(nullable = false)]
    pub csrf_token: Option<String>,
}
