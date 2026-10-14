//! The ports of the external services: Google Calendar, Google OAuth, and the
//! clock. `google/` implements them over HTTP; tests and the e2e server use
//! fakes.

use std::collections::BTreeMap;
use std::fmt::Debug;
use std::future::Future;
use std::pin::Pin;

use caltodo_domain::event::CalendarEvent;
use caltodo_domain::ids::{CalendarId, EventId};
use jiff::Timestamp;

use crate::config::Secret;

/// A boxed future of a port method.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A failed Google call. The texts are fixed: a Google error can contain a
/// URL or a token, so it never reaches a log or a response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum GoogleError {
    /// HTTP 401: the access token is expired or revoked.
    #[error("Google rejected the access token")]
    Unauthorized,
    /// HTTP 404 or 410: the event or calendar does not exist.
    #[error("the Google resource does not exist")]
    NotFound,
    /// Another failure status.
    #[error("Google answered with an error status")]
    Status(u16),
    /// No response: connection, timeout, or body limit.
    #[error("the Google request failed")]
    Transport,
    /// A response that does not decode.
    #[error("the Google response is invalid")]
    InvalidResponse,
    /// The event list has more pages than the page limit.
    #[error("the Google event list has too many pages")]
    TooManyPages,
    /// Google refused the refresh token (`invalid_grant`): the user must
    /// sign in again.
    #[error("Google refused the refresh token")]
    RefreshRejected,
}

/// An event start or end with the zone that Google Calendar shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventTime {
    pub date_time: Timestamp,
    pub time_zone: String,
}

/// A new task event. Its visibility is always `private`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEvent {
    pub summary: String,
    pub description: String,
    pub start: EventTime,
    pub end: EventTime,
    pub color_id: String,
    pub private_properties: BTreeMap<String, String>,
}

/// A partial event change. `None` leaves a field as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventPatch {
    pub summary: Option<String>,
    pub description: Option<String>,
    pub start: Option<EventTime>,
    pub end: Option<EventTime>,
    pub transparency: Option<&'static str>,
    pub private_properties: Option<BTreeMap<String, String>>,
}

/// One calendar of the user's calendar list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarSummary {
    pub id: String,
    pub summary: String,
    pub primary: bool,
}

/// Google Calendar API v3 with one access token per call.
pub trait CalendarApi: Send + Sync + Debug {
    /// The single events that overlap `[time_min, time_max)`, ordered by
    /// start, from every result page.
    fn list_events<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        time_min: Timestamp,
        time_max: Timestamp,
    ) -> BoxFuture<'a, Result<Vec<CalendarEvent>, GoogleError>>;

    fn get_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a EventId,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>>;

    fn insert_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a NewEvent,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>>;

    fn patch_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a EventId,
        patch: &'a EventPatch,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>>;

    fn list_calendars<'a>(
        &'a self,
        token: &'a Secret,
    ) -> BoxFuture<'a, Result<Vec<CalendarSummary>, GoogleError>>;
}

/// The start of a Google sign-in: the URL and the values that the callback
/// must match.
#[derive(Debug, Clone)]
pub struct Authorization {
    pub url: String,
    /// The OAuth `state`.
    pub state: Secret,
    pub pkce_verifier: Secret,
}

/// The tokens of a code exchange or a refresh.
#[derive(Debug, Clone)]
pub struct TokenGrant {
    pub access_token: Secret,
    /// Google sends a refresh token only on a consent.
    pub refresh_token: Option<Secret>,
}

/// The OpenID Connect userinfo of a Google account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleProfile {
    /// The stable account id (`users.google_id`).
    pub sub: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

/// Google OAuth 2.0 and the userinfo endpoint.
pub trait OAuthApi: Send + Sync + Debug {
    /// A new authorization request.
    ///
    /// # Errors
    ///
    /// No random state is available.
    fn begin(&self) -> Result<Authorization, GoogleError>;

    fn exchange_code<'a>(
        &'a self,
        code: &'a str,
        pkce_verifier: &'a Secret,
    ) -> BoxFuture<'a, Result<TokenGrant, GoogleError>>;

    fn refresh<'a>(
        &'a self,
        refresh_token: &'a Secret,
    ) -> BoxFuture<'a, Result<TokenGrant, GoogleError>>;

    fn profile<'a>(
        &'a self,
        access_token: &'a Secret,
    ) -> BoxFuture<'a, Result<GoogleProfile, GoogleError>>;
}

/// The current time.
pub trait Clock: Send + Sync + Debug {
    fn now(&self) -> Timestamp;
}

/// The system clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        Timestamp::now()
    }
}
