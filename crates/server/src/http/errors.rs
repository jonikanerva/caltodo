//! The public failures of the `/api` routes as RFC 9457 Problem Details.
//!
//! Every failure of an `/api` route answers `application/problem+json`:
//!
//! ```json
//! {"type":"about:blank","title":"Conflict","status":409,
//!  "detail":"No free time slots available in the next 90 days.","code":"no_free_slot"}
//! ```
//!
//! - `type` is always `about:blank`, so `title` is the HTTP status phrase.
//! - `code` is the stable application code ([`ProblemCode`]).
//! - `detail` is a fixed text. It keeps the human texts of the Node server,
//!   for example `Task not found`. It never contains user input, a Google
//!   error, or a SQL error.
//!
//! The Node server answered `{"error": "<text>"}` instead (ADR 0004).

use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

use crate::application::AppError;
use crate::application::actions::ActionError;
use crate::application::ports::GoogleError;

/// The media type of a Problem Details body.
pub const PROBLEM_JSON: &str = "application/problem+json";

/// The stable application code of a public failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProblemCode {
    /// The body or a path value is invalid (400).
    InvalidRequest,
    /// The `taskIds` body is invalid (400).
    InvalidTaskIds,
    /// The settings body is invalid (400).
    InvalidSettings,
    /// The `action` of an action link request is invalid (400).
    InvalidAction,
    /// The user has no calendar in the settings (400).
    NoCalendar,
    /// The user has no settings (400).
    NoSettings,
    /// The action link is unknown, used, or expired (400).
    InvalidLink,
    /// The task event has no start and end time (400).
    InvalidEventTime,
    /// The request has no signed-in session (401).
    Unauthenticated,
    /// The CSRF token is missing or wrong (403).
    CsrfRejected,
    /// The action link belongs to another user (403).
    Forbidden,
    /// No API route has this path and method (404).
    NotFound,
    /// The task event does not exist or is no task (404).
    TaskNotFound,
    /// No free slot in the next 90 days (409).
    NoFreeSlot,
    /// The body is larger than the limit (413).
    PayloadTooLarge,
    /// Too many requests from this client (429).
    RateLimited,
    /// The server failed (500).
    InternalError,
    /// The user has no stored Google access (500).
    CalendarUnavailable,
    /// Google did not create the event (500).
    EventNotCreated,
    /// Google Calendar failed, timed out, or answered unexpectedly (502).
    GoogleUnavailable,
    /// Google refused the stored refresh token; the user must sign in again (502).
    GoogleReauthorizationRequired,
    /// The Google sign-in failed after the redirect (502).
    SignInFailed,
}

impl ProblemCode {
    /// Every code, in declaration order.
    pub const ALL: [Self; 22] = [
        Self::InvalidRequest,
        Self::InvalidTaskIds,
        Self::InvalidSettings,
        Self::InvalidAction,
        Self::NoCalendar,
        Self::NoSettings,
        Self::InvalidLink,
        Self::InvalidEventTime,
        Self::Unauthenticated,
        Self::CsrfRejected,
        Self::Forbidden,
        Self::NotFound,
        Self::TaskNotFound,
        Self::NoFreeSlot,
        Self::PayloadTooLarge,
        Self::RateLimited,
        Self::InternalError,
        Self::CalendarUnavailable,
        Self::EventNotCreated,
        Self::GoogleUnavailable,
        Self::GoogleReauthorizationRequired,
        Self::SignInFailed,
    ];

    #[must_use]
    pub fn status(self) -> StatusCode {
        match self {
            Self::InvalidRequest
            | Self::InvalidTaskIds
            | Self::InvalidSettings
            | Self::InvalidAction
            | Self::NoCalendar
            | Self::NoSettings
            | Self::InvalidLink
            | Self::InvalidEventTime => StatusCode::BAD_REQUEST,
            Self::Unauthenticated => StatusCode::UNAUTHORIZED,
            Self::CsrfRejected | Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound | Self::TaskNotFound => StatusCode::NOT_FOUND,
            Self::NoFreeSlot => StatusCode::CONFLICT,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::InternalError | Self::CalendarUnavailable | Self::EventNotCreated => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            Self::GoogleUnavailable | Self::GoogleReauthorizationRequired | Self::SignInFailed => {
                StatusCode::BAD_GATEWAY
            }
        }
    }

    /// The status phrase of RFC 9110, section 15.
    fn title(self) -> &'static str {
        match self.status() {
            StatusCode::BAD_REQUEST => "Bad Request",
            StatusCode::UNAUTHORIZED => "Unauthorized",
            StatusCode::FORBIDDEN => "Forbidden",
            StatusCode::NOT_FOUND => "Not Found",
            StatusCode::CONFLICT => "Conflict",
            StatusCode::PAYLOAD_TOO_LARGE => "Content Too Large",
            StatusCode::TOO_MANY_REQUESTS => "Too Many Requests",
            StatusCode::BAD_GATEWAY => "Bad Gateway",
            _ => "Internal Server Error",
        }
    }

    /// The default detail text: the text of the Node server where it had one.
    #[must_use]
    pub fn detail(self) -> &'static str {
        match self {
            Self::InvalidRequest => "Invalid request payload",
            Self::InvalidTaskIds => "Invalid taskIds payload",
            Self::InvalidSettings => "Invalid settings data",
            Self::InvalidAction => "Invalid action.",
            Self::NoCalendar => "No calendar configured",
            Self::NoSettings => "No settings configured.",
            Self::InvalidLink => "Invalid or expired link.",
            Self::InvalidEventTime => "Invalid event time range.",
            Self::Unauthenticated => "Unauthorized",
            Self::CsrfRejected => "Invalid CSRF token",
            Self::Forbidden => "Unauthorized.",
            Self::NotFound => "No API route has this path and method.",
            Self::TaskNotFound => "Task not found",
            Self::NoFreeSlot => "No free time slots available in the next 90 days.",
            Self::PayloadTooLarge => "The request body is too large.",
            Self::RateLimited => "Too many requests, please try again later.",
            Self::InternalError => "Internal Server Error",
            Self::CalendarUnavailable => "Failed to access calendar",
            Self::EventNotCreated => "Failed to create calendar event",
            Self::GoogleUnavailable => "Google Calendar is unavailable. Try again later.",
            Self::GoogleReauthorizationRequired => {
                "Google Calendar access has expired. Sign out and sign in again."
            }
            Self::SignInFailed => "The sign-in with Google failed. Try again.",
        }
    }
}

/// An RFC 9457 Problem Details body with the application `code` extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct Problem {
    /// Always `about:blank`.
    #[serde(rename = "type")]
    #[schema(value_type = String)]
    type_uri: &'static str,
    /// The HTTP status phrase.
    #[schema(value_type = String)]
    title: &'static str,
    /// The HTTP status code of the response.
    status: u16,
    /// A fixed explanation. It contains no request data.
    #[schema(value_type = String)]
    detail: &'static str,
    code: ProblemCode,
}

impl Problem {
    /// The problem of a code with its default detail.
    #[must_use]
    pub fn new(code: ProblemCode) -> Self {
        Self::with_detail(code, code.detail())
    }

    /// The problem of a code with another fixed detail, such as the
    /// operation text of a 500 or the action-link variant `Task not found.`.
    #[must_use]
    pub fn with_detail(code: ProblemCode, detail: &'static str) -> Self {
        Self {
            type_uri: "about:blank",
            title: code.title(),
            status: code.status().as_u16(),
            detail,
            code,
        }
    }

    #[must_use]
    pub fn code(&self) -> ProblemCode {
        self.code
    }

    #[must_use]
    pub fn detail(&self) -> &'static str {
        self.detail
    }

    #[must_use]
    pub fn status(&self) -> StatusCode {
        self.code.status()
    }
}

/// The response of a code with its default detail.
#[must_use]
pub fn problem(code: ProblemCode) -> Response {
    Problem::new(code).into_response()
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let status = self.code.status();
        match serde_json::to_vec(&self) {
            Ok(body) => (
                status,
                [(CONTENT_TYPE, HeaderValue::from_static(PROBLEM_JSON))],
                body,
            )
                .into_response(),
            // The body has only text, integer, and enum fields, so this
            // serialization cannot fail. The status still holds.
            Err(_) => status.into_response(),
        }
    }
}

impl From<GoogleError> for Problem {
    fn from(error: GoogleError) -> Self {
        match error {
            GoogleError::RefreshRejected => Self::new(ProblemCode::GoogleReauthorizationRequired),
            GoogleError::Unauthorized
            | GoogleError::NotFound
            | GoogleError::Status(_)
            | GoogleError::Transport
            | GoogleError::InvalidResponse
            | GoogleError::TooManyPages => Self::new(ProblemCode::GoogleUnavailable),
        }
    }
}

/// The problem of a failed use case. `fallback` is the operation text of
/// the Node server for an unexpected failure, such as `Failed to get tasks`.
#[must_use]
pub fn app_problem(error: &AppError, fallback: &'static str) -> Problem {
    match error {
        AppError::NoCalendar => Problem::new(ProblemCode::NoCalendar),
        AppError::NoCalendarAccess => Problem::new(ProblemCode::CalendarUnavailable),
        AppError::Google(error) => Problem::from(*error),
        AppError::TaskNotFound => Problem::new(ProblemCode::TaskNotFound),
        AppError::NoFreeSlot => Problem::new(ProblemCode::NoFreeSlot),
        AppError::InvalidEventTime => Problem::new(ProblemCode::InvalidEventTime),
        AppError::EventNotCreated => Problem::new(ProblemCode::EventNotCreated),
        AppError::CreatedEventMissing => {
            Problem::with_detail(ProblemCode::InternalError, "Failed to load created event")
        }
        AppError::CreatedEventInvalid => {
            Problem::with_detail(ProblemCode::InternalError, "Failed to map created event")
        }
        AppError::UpdatedEventInvalid
        | AppError::InvalidStoredSettings
        | AppError::Store(_)
        | AppError::Random(_) => Problem::with_detail(ProblemCode::InternalError, fallback),
    }
}

/// The problem of a failed action link request (`actionRoutes.ts`).
#[must_use]
pub fn action_problem(error: &ActionError) -> Problem {
    match error {
        ActionError::InvalidLink => Problem::new(ProblemCode::InvalidLink),
        ActionError::Forbidden => Problem::new(ProblemCode::Forbidden),
        ActionError::NoSettings => Problem::new(ProblemCode::NoSettings),
        ActionError::TaskNotFound => {
            Problem::with_detail(ProblemCode::TaskNotFound, "Task not found.")
        }
        ActionError::InvalidEventTime => Problem::new(ProblemCode::InvalidEventTime),
        ActionError::App(error) => app_problem(error, "Failed to process action"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_a_status_a_title_and_a_fixed_detail() {
        for code in ProblemCode::ALL {
            let json = serde_json::to_value(Problem::new(code)).unwrap();
            assert_eq!(json["type"], "about:blank");
            assert_eq!(json["status"], code.status().as_u16());
            assert_ne!(code.detail(), "");
            let expected_title = match code.status() {
                StatusCode::PAYLOAD_TOO_LARGE => Some("Content Too Large"),
                status => status.canonical_reason(),
            };
            assert_eq!(Some(code.title()), expected_title, "{code:?}");
            let text = json["code"].as_str().unwrap();
            assert!(
                text.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
                "{text}"
            );
        }
    }

    #[test]
    fn google_failures_hide_their_cause() {
        let problem = Problem::from(GoogleError::Status(503));
        assert_eq!(problem.code(), ProblemCode::GoogleUnavailable);
        assert_eq!(
            Problem::from(GoogleError::RefreshRejected).code(),
            ProblemCode::GoogleReauthorizationRequired
        );
    }
}
