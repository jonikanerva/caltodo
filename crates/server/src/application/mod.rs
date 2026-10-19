//! The use cases: tasks, settings, action links, sign-in, and the jobs.
//!
//! Dependency direction: `http` → `application` → `domain`. `google/`
//! implements the ports of [`ports`]; `db/` holds the queries. The use cases
//! keep the behaviour of the Node server (`server/calendar.ts` and
//! `server/handlers/*.ts`), except for the defects that ADR 0001 lists:
//! a Google failure in the task list, the calendar list, or a free-slot
//! search is now an explicit error instead of an empty result. A Google
//! failure of a single-task route is a Google error, not "Task not found"
//! (issue #29).

pub mod actions;
pub mod calendar_access;
pub mod jobs;
pub mod ports;
pub mod session_auth;
pub mod tasks;

use std::sync::Arc;

use jiff::tz::TimeZone;
use jiff::{Span, Timestamp, Zoned};

use crate::db::{Store, StoreError};
use crate::security::RandomUnavailable;
use crate::security::action_tokens::TokenHasher;
use ports::{CalendarApi, Clock, GoogleError, OAuthApi};

/// The services that the use cases share.
#[derive(Debug, Clone)]
pub struct Services {
    pub store: Store,
    pub calendar: Arc<dyn CalendarApi>,
    pub oauth: Arc<dyn OAuthApi>,
    pub clock: Arc<dyn Clock>,
    pub tokens: TokenHasher,
    /// The origin of the action links.
    pub app_origin: Arc<str>,
    /// The process time zone: the Node server did its calendar-day
    /// arithmetic in this zone (`Date.setDate`).
    pub process_zone: TimeZone,
}

impl Services {
    /// `instant` moved by whole calendar days in the process time zone, like
    /// `date.setDate(date.getDate() + days)` on the Node server.
    #[must_use]
    pub fn add_days(&self, instant: Timestamp, days: i64) -> Timestamp {
        let zoned: Zoned = instant.to_zoned(self.process_zone.clone());
        zoned
            .checked_add(Span::new().days(days))
            .map_or(instant, |moved| moved.timestamp())
    }
}

/// A failed use case. Each variant maps to one public problem
/// (`http::errors`).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("No calendar configured")]
    NoCalendar,
    /// The user has no stored access token (`getCalendarClient` gave null).
    #[error("Failed to access calendar")]
    NoCalendarAccess,
    #[error(transparent)]
    Google(#[from] GoogleError),
    #[error("Task not found")]
    TaskNotFound,
    #[error("No free time slots available in the next 90 days.")]
    NoFreeSlot,
    /// A requested task event has no valid start and end time.
    #[error("Invalid event time range.")]
    InvalidEventTime,
    #[error("Failed to create calendar event")]
    EventNotCreated,
    #[error("Failed to load created event")]
    CreatedEventMissing,
    #[error("Failed to map created event")]
    CreatedEventInvalid,
    #[error("Failed to map updated task")]
    UpdatedEventInvalid,
    /// A stored setting that the scheduler cannot use, such as an unknown
    /// time zone.
    #[error("stored settings are invalid")]
    InvalidStoredSettings,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Random(#[from] RandomUnavailable),
}

impl AppError {
    /// A fixed tag for the log.
    #[must_use]
    pub fn tag(&self) -> &'static str {
        match self {
            Self::NoCalendar => "no_calendar",
            Self::NoCalendarAccess => "no_calendar_access",
            Self::Google(error) => google_tag(*error),
            Self::TaskNotFound => "task_not_found",
            Self::NoFreeSlot => "no_free_slot",
            Self::InvalidEventTime => "invalid_event_time",
            Self::EventNotCreated => "event_not_created",
            Self::CreatedEventMissing => "created_event_missing",
            Self::CreatedEventInvalid => "created_event_invalid",
            Self::UpdatedEventInvalid => "updated_event_invalid",
            Self::InvalidStoredSettings => "invalid_stored_settings",
            Self::Store(_) => "database",
            Self::Random(_) => "random_unavailable",
        }
    }
}

/// A fixed tag of a Google failure for the log.
#[must_use]
pub fn google_tag(error: GoogleError) -> &'static str {
    match error {
        GoogleError::Unauthorized => "google_unauthorized",
        GoogleError::NotFound => "google_not_found",
        GoogleError::Status(_) => "google_status",
        GoogleError::Transport => "google_transport",
        GoogleError::InvalidResponse => "google_invalid_response",
        GoogleError::TooManyPages => "google_too_many_pages",
        GoogleError::RefreshRejected => "google_refresh_rejected",
    }
}
