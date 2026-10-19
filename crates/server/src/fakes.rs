//! In-memory fakes of the Google ports and a settable clock.
//!
//! The integration tests and the e2e server (`examples/e2e_server.rs`) use
//! them, so the real router runs without network access. The production
//! wiring never builds them.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, PoisonError};

use caltodo_domain::event::CalendarEvent;
use caltodo_domain::ids::{CalendarId, EventId};
use jiff::Timestamp;

use crate::application::ports::{
    Authorization, BoxFuture, CalendarApi, CalendarSummary, Clock, EventPatch, GoogleError,
    GoogleProfile, NewEvent, OAuthApi, TokenGrant,
};
use crate::config::Secret;

/// A clock that tests set and move.
#[derive(Debug, Clone)]
pub struct FixedClock(Arc<Mutex<Timestamp>>);

impl FixedClock {
    #[must_use]
    pub fn new(now: Timestamp) -> Self {
        Self(Arc::new(Mutex::new(now)))
    }

    pub fn set(&self, now: Timestamp) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = now;
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// One recorded call of the fake calendar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalendarCall {
    List {
        calendar: String,
        time_min: Timestamp,
        time_max: Timestamp,
    },
    Get {
        event: String,
    },
    Insert {
        event: NewEvent,
    },
    Patch {
        event: String,
        patch: EventPatch,
    },
    ListCalendars,
}

#[derive(Debug, Default)]
struct CalendarState {
    /// Events by calendar id and event id.
    events: BTreeMap<(String, String), CalendarEvent>,
    calendars: Vec<CalendarSummary>,
    next_id: u64,
    calls: Vec<CalendarCall>,
    /// The access tokens that the fake accepts; empty accepts every token.
    valid_tokens: BTreeSet<String>,
    fail_list: Option<GoogleError>,
    /// The number of list calls that still succeed before `fail_lists_later`
    /// applies, and its error.
    fail_lists_later: Option<(usize, GoogleError)>,
    fail_calendars: Option<GoogleError>,
    fail_insert: Option<GoogleError>,
    fail_patch: BTreeSet<String>,
    fail_description_patch: bool,
    fail_get: BTreeMap<String, GoogleError>,
    /// Per event: the number of gets that still succeed, and the error of
    /// every later get.
    fail_gets_later: BTreeMap<String, (usize, GoogleError)>,
    /// Events that a get reports as cancelled while the list still has them.
    cancelled_on_get: BTreeSet<String>,
}

/// A fake Google Calendar.
#[derive(Debug, Clone)]
pub struct FakeCalendar {
    state: Arc<Mutex<CalendarState>>,
    clock: Arc<dyn Clock>,
}

impl FakeCalendar {
    #[must_use]
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            state: Arc::new(Mutex::new(CalendarState::default())),
            clock,
        }
    }

    fn with<T>(&self, change: impl FnOnce(&mut CalendarState) -> T) -> T {
        change(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// Adds or replaces an event.
    pub fn put_event(&self, calendar: &str, event: CalendarEvent) {
        let id = event.id.clone().unwrap_or_default();
        self.with(|state| state.events.insert((calendar.to_owned(), id), event));
    }

    /// The stored event.
    #[must_use]
    pub fn event(&self, calendar: &str, id: &str) -> Option<CalendarEvent> {
        self.with(|state| {
            state
                .events
                .get(&(calendar.to_owned(), id.to_owned()))
                .cloned()
        })
    }

    /// Every stored event of a calendar.
    #[must_use]
    pub fn events(&self, calendar: &str) -> Vec<CalendarEvent> {
        self.with(|state| {
            state
                .events
                .iter()
                .filter(|((owner, _), _)| owner == calendar)
                .map(|(_, event)| event.clone())
                .collect()
        })
    }

    pub fn set_calendars(&self, calendars: Vec<CalendarSummary>) {
        self.with(|state| state.calendars = calendars);
    }

    /// Accepts only these access tokens; another token gets 401.
    pub fn accept_tokens(&self, tokens: &[&str]) {
        self.with(|state| {
            state.valid_tokens = tokens.iter().map(|token| (*token).to_owned()).collect();
        });
    }

    pub fn fail_list(&self, error: Option<GoogleError>) {
        self.with(|state| state.fail_list = error);
    }

    /// The next `succeed` list calls succeed; every later list call fails.
    pub fn fail_lists_after(&self, succeed: usize, error: GoogleError) {
        self.with(|state| state.fail_lists_later = Some((succeed, error)));
    }

    pub fn fail_calendars(&self, error: Option<GoogleError>) {
        self.with(|state| state.fail_calendars = error);
    }

    pub fn fail_insert(&self, error: Option<GoogleError>) {
        self.with(|state| state.fail_insert = error);
    }

    pub fn fail_patch(&self, event: &str) {
        self.with(|state| state.fail_patch.insert(event.to_owned()));
    }

    /// Every patch that writes a description fails.
    pub fn fail_description_patches(&self, fail: bool) {
        self.with(|state| state.fail_description_patch = fail);
    }

    /// A get of this event reports it as cancelled; the list still has it.
    pub fn cancel_on_get(&self, event: &str) {
        self.with(|state| state.cancelled_on_get.insert(event.to_owned()));
    }

    pub fn fail_get(&self, event: &str, error: GoogleError) {
        self.with(|state| state.fail_get.insert(event.to_owned(), error));
    }

    /// The next `succeed` gets of this event succeed; every later get fails.
    pub fn fail_gets_after(&self, event: &str, succeed: usize, error: GoogleError) {
        self.with(|state| {
            state
                .fail_gets_later
                .insert(event.to_owned(), (succeed, error))
        });
    }

    /// The recorded calls, oldest first.
    #[must_use]
    pub fn calls(&self) -> Vec<CalendarCall> {
        self.with(|state| state.calls.clone())
    }

    pub fn clear_calls(&self) {
        self.with(|state| state.calls.clear());
    }

    fn check_token(state: &CalendarState, token: &Secret) -> Result<(), GoogleError> {
        if state.valid_tokens.is_empty() || state.valid_tokens.contains(token.expose()) {
            Ok(())
        } else {
            Err(GoogleError::Unauthorized)
        }
    }

    fn list(
        &self,
        token: &Secret,
        calendar: &CalendarId,
        time_min: Timestamp,
        time_max: Timestamp,
    ) -> Result<Vec<CalendarEvent>, GoogleError> {
        self.with(|state| {
            Self::check_token(state, token)?;
            state.calls.push(CalendarCall::List {
                calendar: calendar.to_string(),
                time_min,
                time_max,
            });
            if let Some(error) = state.fail_list {
                return Err(error);
            }
            if let Some((succeed, error)) = &mut state.fail_lists_later {
                if *succeed == 0 {
                    return Err(*error);
                }
                *succeed -= 1;
            }
            let mut events: Vec<CalendarEvent> = state
                .events
                .iter()
                .filter(|((owner, _), _)| owner == calendar.as_str())
                .map(|(_, event)| event)
                .filter(|event| !event.is_cancelled())
                .filter(|event| {
                    event
                        .time_range()
                        .is_some_and(|(start, end)| end > time_min && start < time_max)
                })
                .cloned()
                .collect();
            events.sort_by_key(|event| event.start);
            Ok(events)
        })
    }

    fn get(
        &self,
        token: &Secret,
        calendar: &CalendarId,
        event: &EventId,
    ) -> Result<CalendarEvent, GoogleError> {
        self.with(|state| {
            Self::check_token(state, token)?;
            state.calls.push(CalendarCall::Get {
                event: event.to_string(),
            });
            if let Some(error) = state.fail_get.get(event.as_str()) {
                return Err(*error);
            }
            if let Some((succeed, error)) = state.fail_gets_later.get_mut(event.as_str()) {
                if *succeed == 0 {
                    return Err(*error);
                }
                *succeed -= 1;
            }
            let mut found = state
                .events
                .get(&(calendar.to_string(), event.to_string()))
                .cloned()
                .ok_or(GoogleError::NotFound)?;
            if state.cancelled_on_get.contains(event.as_str()) {
                found.status = Some("cancelled".to_owned());
            }
            Ok(found)
        })
    }

    fn insert(
        &self,
        token: &Secret,
        calendar: &CalendarId,
        new_event: &NewEvent,
    ) -> Result<CalendarEvent, GoogleError> {
        let now = self.clock.now();
        self.with(|state| {
            Self::check_token(state, token)?;
            state.calls.push(CalendarCall::Insert {
                event: new_event.clone(),
            });
            if let Some(error) = state.fail_insert {
                return Err(error);
            }
            state.next_id += 1;
            let id = format!("evt-{}", state.next_id);
            let event = CalendarEvent {
                id: Some(id.clone()),
                status: Some("confirmed".to_owned()),
                summary: Some(new_event.summary.clone()),
                description: Some(new_event.description.clone()),
                start: Some(new_event.start.date_time),
                end: Some(new_event.end.date_time),
                updated: Some(now),
                transparency: None,
                private_properties: new_event.private_properties.clone(),
            };
            state
                .events
                .insert((calendar.to_string(), id), event.clone());
            Ok(event)
        })
    }

    fn patch(
        &self,
        token: &Secret,
        calendar: &CalendarId,
        event: &EventId,
        patch: &EventPatch,
    ) -> Result<CalendarEvent, GoogleError> {
        let now = self.clock.now();
        self.with(|state| {
            Self::check_token(state, token)?;
            state.calls.push(CalendarCall::Patch {
                event: event.to_string(),
                patch: patch.clone(),
            });
            if state.fail_patch.contains(event.as_str())
                || (state.fail_description_patch && patch.description.is_some())
            {
                return Err(GoogleError::Status(500));
            }
            let stored = state
                .events
                .get_mut(&(calendar.to_string(), event.to_string()))
                .ok_or(GoogleError::NotFound)?;
            if let Some(summary) = &patch.summary {
                stored.summary = Some(summary.clone());
            }
            if let Some(description) = &patch.description {
                stored.description = Some(description.clone());
            }
            if let Some(start) = &patch.start {
                stored.start = Some(start.date_time);
            }
            if let Some(end) = &patch.end {
                stored.end = Some(end.date_time);
            }
            if let Some(transparency) = patch.transparency {
                stored.transparency = Some(transparency.to_owned());
            }
            if let Some(private) = &patch.private_properties {
                stored.private_properties.clone_from(private);
            }
            stored.updated = Some(now);
            Ok(stored.clone())
        })
    }
}

impl CalendarApi for FakeCalendar {
    fn list_events<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        time_min: Timestamp,
        time_max: Timestamp,
    ) -> BoxFuture<'a, Result<Vec<CalendarEvent>, GoogleError>> {
        Box::pin(std::future::ready(
            self.list(token, calendar, time_min, time_max),
        ))
    }

    fn get_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a EventId,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>> {
        Box::pin(std::future::ready(self.get(token, calendar, event)))
    }

    fn insert_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a NewEvent,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>> {
        Box::pin(std::future::ready(self.insert(token, calendar, event)))
    }

    fn patch_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a EventId,
        patch: &'a EventPatch,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>> {
        Box::pin(std::future::ready(
            self.patch(token, calendar, event, patch),
        ))
    }

    fn list_calendars<'a>(
        &'a self,
        token: &'a Secret,
    ) -> BoxFuture<'a, Result<Vec<CalendarSummary>, GoogleError>> {
        let result = self.with(|state| {
            Self::check_token(state, token)?;
            state.calls.push(CalendarCall::ListCalendars);
            match state.fail_calendars {
                Some(error) => Err(error),
                None => Ok(state.calendars.clone()),
            }
        });
        Box::pin(std::future::ready(result))
    }
}

#[derive(Debug, Default)]
struct OAuthState {
    /// Authorization codes and the profile that each code signs in.
    codes: BTreeMap<String, GoogleProfile>,
    /// The PKCE verifiers of the started authorizations, so parallel
    /// sign-ins do not overwrite each other.
    verifiers: BTreeSet<String>,
    issued: u64,
    /// Access tokens and the account they belong to.
    access: BTreeMap<String, GoogleProfile>,
    /// The refresh tokens that work.
    refresh: BTreeSet<String>,
    refresh_calls: u64,
    /// A refresh token grant gives a new refresh token too.
    rotate_refresh: bool,
}

/// A fake Google OAuth server: a code from [`FakeOAuth::code_for`] signs in
/// the given profile. The authorization URL points straight at the callback,
/// so a browser completes the sign-in without leaving the test server.
#[derive(Debug, Clone)]
pub struct FakeOAuth {
    state: Arc<Mutex<OAuthState>>,
    /// The callback URL that [`OAuthApi::begin`] redirects to.
    callback: String,
}

impl FakeOAuth {
    #[must_use]
    pub fn new(callback: impl Into<String>) -> Self {
        Self {
            state: Arc::new(Mutex::new(OAuthState::default())),
            callback: callback.into(),
        }
    }

    fn with<T>(&self, change: impl FnOnce(&mut OAuthState) -> T) -> T {
        change(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// Registers a code that signs in `profile`.
    pub fn code_for(&self, code: &str, profile: GoogleProfile) {
        self.with(|state| state.codes.insert(code.to_owned(), profile));
    }

    /// Makes a refresh token valid.
    pub fn accept_refresh_token(&self, token: &str) {
        self.with(|state| state.refresh.insert(token.to_owned()));
    }

    /// A refresh then also returns a new refresh token.
    pub fn rotate_refresh_tokens(&self) {
        self.with(|state| state.rotate_refresh = true);
    }

    /// The number of refresh calls.
    #[must_use]
    pub fn refresh_calls(&self) -> u64 {
        self.with(|state| state.refresh_calls)
    }

    /// The access token that the next grant issues.
    #[must_use]
    pub fn next_access_token(&self) -> String {
        self.with(|state| format!("fake-access-{}", state.issued + 1))
    }
}

impl OAuthApi for FakeOAuth {
    fn begin(&self) -> Result<Authorization, GoogleError> {
        let state = crate::security::random_base64url(16).map_err(|_| GoogleError::Transport)?;
        let verifier = crate::security::random_base64url(32).map_err(|_| GoogleError::Transport)?;
        self.with(|inner| inner.verifiers.insert(verifier.clone()));
        Ok(Authorization {
            url: format!("{}?code=fake-code&state={state}", self.callback),
            state: Secret::new(state),
            pkce_verifier: Secret::new(verifier),
        })
    }

    fn exchange_code<'a>(
        &'a self,
        code: &'a str,
        pkce_verifier: &'a Secret,
    ) -> BoxFuture<'a, Result<TokenGrant, GoogleError>> {
        let result = self.with(|state| {
            if !state.verifiers.remove(pkce_verifier.expose()) {
                return Err(GoogleError::Status(400));
            }
            let profile = state
                .codes
                .get(code)
                .cloned()
                .ok_or(GoogleError::Status(400))?;
            state.issued += 1;
            let access = format!("fake-access-{}", state.issued);
            let refresh = format!("fake-refresh-{}", state.issued);
            state.access.insert(access.clone(), profile);
            state.refresh.insert(refresh.clone());
            Ok(TokenGrant {
                access_token: Secret::new(access),
                refresh_token: Some(Secret::new(refresh)),
            })
        });
        Box::pin(std::future::ready(result))
    }

    fn refresh<'a>(
        &'a self,
        refresh_token: &'a Secret,
    ) -> BoxFuture<'a, Result<TokenGrant, GoogleError>> {
        let result = self.with(|state| {
            state.refresh_calls += 1;
            if !state.refresh.contains(refresh_token.expose()) {
                return Err(GoogleError::RefreshRejected);
            }
            state.issued += 1;
            let access = format!("fake-access-{}", state.issued);
            let refresh = state.rotate_refresh.then(|| {
                let next = format!("fake-refresh-{}", state.issued);
                state.refresh.insert(next.clone());
                Secret::new(next)
            });
            Ok(TokenGrant {
                access_token: Secret::new(access),
                refresh_token: refresh,
            })
        });
        Box::pin(std::future::ready(result))
    }

    fn profile<'a>(
        &'a self,
        access_token: &'a Secret,
    ) -> BoxFuture<'a, Result<GoogleProfile, GoogleError>> {
        let result = self.with(|state| {
            state
                .access
                .get(access_token.expose())
                .cloned()
                .ok_or(GoogleError::Unauthorized)
        });
        Box::pin(std::future::ready(result))
    }
}
