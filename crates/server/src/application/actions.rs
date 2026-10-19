//! The action links of the calendar events (`server/handlers/actionRoutes.ts`
//! and `server/tokens.ts`).

use caltodo_domain::ids::UserId;
use caltodo_domain::task::Task;

use super::calendar_access::UserCalendar;
use super::ports::GoogleError;
use super::tasks::{CalendarSettings, action_support};
use super::{AppError, Services};
use crate::db::StoreError;
use crate::db::action_tokens::ActionTokenRecord;

/// What the action page shows to a signed-in user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionPage {
    /// The token is valid: the task title and its state.
    Manage { title: String, completed: bool },
    /// Unknown, used, or expired token.
    InvalidLink,
    /// The token belongs to another user.
    NotAuthorized,
    /// The event is gone, or the user has no stored Google access.
    TaskDeleted,
    /// The event is no task anymore.
    TaskUnmappable,
}

/// The two actions of an action link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Complete,
    Reschedule,
}

impl ActionKind {
    /// The `action` value of the form or the JSON body.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "complete" => Some(Self::Complete),
            "reschedule" => Some(Self::Reschedule),
            _ => None,
        }
    }
}

/// A failed action, with the texts of the Node server.
#[derive(Debug, thiserror::Error)]
pub enum ActionError {
    #[error("Invalid or expired link.")]
    InvalidLink,
    #[error("Unauthorized.")]
    Forbidden,
    #[error("No settings configured.")]
    NoSettings,
    #[error("Task not found.")]
    TaskNotFound,
    #[error("Invalid event time range.")]
    InvalidEventTime,
    #[error(transparent)]
    App(#[from] AppError),
}

impl From<StoreError> for ActionError {
    fn from(error: StoreError) -> Self {
        Self::App(AppError::Store(error))
    }
}

/// The action failure of a task failure: the link variant of "Task not
/// found", or the failure itself.
fn action_failure(error: AppError) -> ActionError {
    match error {
        AppError::TaskNotFound => ActionError::TaskNotFound,
        other => ActionError::App(other),
    }
}

/// The valid token of a raw link value (`getActionToken`): known, unused,
/// and not expired.
async fn valid_token(
    services: &Services,
    raw: &str,
) -> Result<Option<ActionTokenRecord>, StoreError> {
    if raw.is_empty() {
        return Ok(None);
    }
    let Some(record) = services
        .store
        .action_token_by_hash(&services.tokens.hash(raw))
        .await?
    else {
        return Ok(None);
    };
    let now = services.clock.now();
    let live = !record.used && record.expires_at.is_some_and(|expires| expires > now);
    Ok(live.then_some(record))
}

/// `GET /action/{token}` for a signed-in user.
///
/// # Errors
///
/// A database failure, or a Google failure other than a missing event. The
/// Node server showed the "Task not found" page for a Google failure too
/// (issue #29).
pub async fn action_page(
    services: &Services,
    user: &UserId,
    raw: &str,
) -> Result<ActionPage, AppError> {
    let Some(token) = valid_token(services, raw).await? else {
        return Ok(ActionPage::InvalidLink);
    };
    if token.user_id != *user {
        return Ok(ActionPage::NotAuthorized);
    }
    let Some(calendar) = UserCalendar::open(services, user).await? else {
        return Ok(ActionPage::TaskDeleted);
    };
    let event = match calendar
        .get_event(&token.calendar_id, &token.event_id)
        .await
    {
        Ok(event) if !event.is_cancelled() => event,
        Ok(_) | Err(GoogleError::NotFound) => return Ok(ActionPage::TaskDeleted),
        Err(error) => return Err(AppError::Google(error)),
    };
    Ok(match Task::from_event(&event) {
        Some(task) => ActionPage::Manage {
            title: task.title,
            completed: task.completed,
        },
        None => ActionPage::TaskUnmappable,
    })
}

/// `POST /api/action/{token}`: completes or reschedules the task of a link,
/// uses up the old link, and writes a new link into the event. Returns the
/// task title for the confirmation page.
///
/// # Errors
///
/// The failures of [`ActionError`], in the order of the Node server.
pub async fn perform_action(
    services: &Services,
    user: &UserId,
    raw: &str,
    kind: ActionKind,
) -> Result<String, ActionError> {
    let token = valid_token(services, raw)
        .await?
        .ok_or(ActionError::InvalidLink)?;
    if token.user_id != *user {
        return Err(ActionError::Forbidden);
    }
    let row = services
        .store
        .settings(user)
        .await?
        .ok_or(ActionError::NoSettings)?;
    // The link acts on the calendar of the token, with the other settings
    // of the user.
    let settings = CalendarSettings {
        row,
        calendar: token.calendar_id.clone(),
    };
    let calendar = UserCalendar::open(services, user)
        .await?
        .ok_or(ActionError::TaskNotFound)?;
    // A missing task is "Task not found."; a Google failure stays a Google
    // failure. The Node server answered "Task not found." for both
    // (issue #29).
    let event = action_support::read_task(&calendar, &token.calendar_id, &token.event_id)
        .await
        .map_err(action_failure)?;
    let task = Task::from_event(&event).ok_or(ActionError::TaskNotFound)?;

    match kind {
        ActionKind::Complete => {
            action_support::complete(&calendar, &token.calendar_id, &token.event_id)
                .await
                .map_err(action_failure)?;
        }
        ActionKind::Reschedule => {
            if event.time_range().is_none() {
                return Err(ActionError::InvalidEventTime);
            }
            action_support::reschedule(services, user, &settings, &token.event_id)
                .await
                .map_err(action_failure)?;
        }
    }

    // Consume the token before the new link of the event retires the older
    // tokens. Otherwise the retirement marks this token as used, and a
    // successful action answers "Invalid or expired link.". The update is
    // conditional, so of two concurrent requests only one gets success.
    if !services
        .store
        .mark_action_token_used(&token.id, services.clock.now())
        .await?
    {
        return Err(ActionError::InvalidLink);
    }

    action_support::refresh_actions(
        services,
        &calendar,
        user,
        &token.calendar_id,
        &token.event_id,
        task.details.as_deref(),
    )
    .await;
    Ok(task.title)
}
