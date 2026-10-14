//! Google Calendar API v3 over HTTP.

use caltodo_domain::event::CalendarEvent;
use caltodo_domain::ids::{CalendarId, EventId};
use caltodo_domain::instant;
use jiff::Timestamp;
use reqwest::{Method, Url};

use super::wire::{CalendarListPage, EventJson, EventPage, InsertBody, PatchBody};
use super::{decode_object, send, status_error};
use crate::application::ports::{
    BoxFuture, CalendarApi, CalendarSummary, EventPatch, GoogleError, NewEvent,
};
use crate::config::Secret;

/// The API root.
pub const API_BASE: &str = "https://www.googleapis.com/calendar/v3";
/// The most result pages of one event list. The page size is the Google
/// default of 250 events, so the limit is 10 000 events. A longer list
/// fails instead of being cut silently.
pub const MAX_EVENT_PAGES: usize = 40;

/// The Calendar API client.
#[derive(Debug, Clone)]
pub struct GoogleCalendar {
    client: reqwest::Client,
    base: Url,
}

impl GoogleCalendar {
    /// A client for `base` ([`API_BASE`] in production).
    ///
    /// # Errors
    ///
    /// `base` is no absolute URL.
    pub fn new(client: reqwest::Client, base: &str) -> Result<Self, GoogleError> {
        let base = Url::parse(base).map_err(|_| GoogleError::Transport)?;
        if base.cannot_be_a_base() {
            return Err(GoogleError::Transport);
        }
        Ok(Self { client, base })
    }

    /// The URL of the path segments under the base. Each segment is
    /// percent-encoded, so an id such as `a@group.calendar.google.com` or an
    /// id with `/` stays one segment.
    fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        if let Ok(mut path) = url.path_segments_mut() {
            path.pop_if_empty().extend(segments);
        }
        url
    }

    async fn request(
        &self,
        method: Method,
        url: Url,
        token: &Secret,
        body: Option<serde_json::Value>,
    ) -> Result<Vec<u8>, GoogleError> {
        let mut request = self.client.request(method, url).bearer_auth(token.expose());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let (status, bytes) = send(request).await?;
        if (200..300).contains(&status) {
            Ok(bytes)
        } else {
            Err(status_error(status))
        }
    }

    async fn event_request(
        &self,
        method: Method,
        url: Url,
        token: &Secret,
        body: Option<serde_json::Value>,
    ) -> Result<CalendarEvent, GoogleError> {
        let bytes = self.request(method, url, token, body).await?;
        Ok(CalendarEvent::from(decode_object::<EventJson>(&bytes)?))
    }

    async fn list_all_events(
        &self,
        token: &Secret,
        calendar: &CalendarId,
        time_min: Timestamp,
        time_max: Timestamp,
    ) -> Result<Vec<CalendarEvent>, GoogleError> {
        let mut events = Vec::new();
        let mut page_token: Option<String> = None;
        for _ in 0..MAX_EVENT_PAGES {
            let mut url = self.url(&["calendars", calendar.as_str(), "events"]);
            {
                let mut query = url.query_pairs_mut();
                query
                    .append_pair("timeMin", &instant::to_iso(time_min))
                    .append_pair("timeMax", &instant::to_iso(time_max))
                    .append_pair("singleEvents", "true")
                    .append_pair("orderBy", "startTime");
                if let Some(page) = &page_token {
                    query.append_pair("pageToken", page);
                }
            }
            let bytes = self.request(Method::GET, url, token, None).await?;
            let page: EventPage = decode_object(&bytes)?;
            events.extend(
                page.items
                    .unwrap_or_default()
                    .into_iter()
                    .map(CalendarEvent::from),
            );
            match page.next_page_token.filter(|next| !next.is_empty()) {
                Some(next) => page_token = Some(next),
                None => return Ok(events),
            }
        }
        Err(GoogleError::TooManyPages)
    }

    async fn calendar_list(&self, token: &Secret) -> Result<Vec<CalendarSummary>, GoogleError> {
        let url = self.url(&["users", "me", "calendarList"]);
        let bytes = self.request(Method::GET, url, token, None).await?;
        let page: CalendarListPage = decode_object(&bytes)?;
        Ok(page
            .items
            .unwrap_or_default()
            .into_iter()
            .map(CalendarSummary::from)
            .collect())
    }
}

fn json<T: serde::Serialize>(body: &T) -> Result<serde_json::Value, GoogleError> {
    serde_json::to_value(body).map_err(|_| GoogleError::InvalidResponse)
}

impl CalendarApi for GoogleCalendar {
    fn list_events<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        time_min: Timestamp,
        time_max: Timestamp,
    ) -> BoxFuture<'a, Result<Vec<CalendarEvent>, GoogleError>> {
        Box::pin(self.list_all_events(token, calendar, time_min, time_max))
    }

    fn get_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a EventId,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>> {
        let url = self.url(&["calendars", calendar.as_str(), "events", event.as_str()]);
        Box::pin(self.event_request(Method::GET, url, token, None))
    }

    fn insert_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a NewEvent,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>> {
        let url = self.url(&["calendars", calendar.as_str(), "events"]);
        Box::pin(async move {
            let body = json(&InsertBody::from(event))?;
            self.event_request(Method::POST, url, token, Some(body))
                .await
        })
    }

    fn patch_event<'a>(
        &'a self,
        token: &'a Secret,
        calendar: &'a CalendarId,
        event: &'a EventId,
        patch: &'a EventPatch,
    ) -> BoxFuture<'a, Result<CalendarEvent, GoogleError>> {
        let url = self.url(&["calendars", calendar.as_str(), "events", event.as_str()]);
        Box::pin(async move {
            let body = json(&PatchBody::from(patch))?;
            self.event_request(Method::PATCH, url, token, Some(body))
                .await
        })
    }

    fn list_calendars<'a>(
        &'a self,
        token: &'a Secret,
    ) -> BoxFuture<'a, Result<Vec<CalendarSummary>, GoogleError>> {
        Box::pin(self.calendar_list(token))
    }
}
