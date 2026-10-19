//! The Google Calendar JSON resources that the adapter reads and writes.

use std::collections::BTreeMap;

use caltodo_domain::event::CalendarEvent;
use caltodo_domain::instant;
use serde::{Deserialize, Serialize};

use crate::application::ports::{CalendarSummary, EventPatch, EventTime, NewEvent};

/// An event resource (only the read fields).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventJson {
    id: Option<String>,
    status: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    start: Option<EventTimeJson>,
    end: Option<EventTimeJson>,
    updated: Option<String>,
    transparency: Option<String>,
    extended_properties: Option<ExtendedPropertiesJson>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventTimeJson {
    date_time: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ExtendedPropertiesJson {
    private: Option<BTreeMap<String, String>>,
}

impl From<EventJson> for CalendarEvent {
    /// A `dateTime` or `updated` value that does not parse reads as missing:
    /// the event then is no timed task. The Node server failed the request
    /// on such a value.
    fn from(event: EventJson) -> Self {
        Self {
            id: event.id,
            status: event.status,
            summary: event.summary,
            description: event.description,
            start: event
                .start
                .and_then(|time| time.date_time)
                .and_then(|text| instant::parse(&text)),
            end: event
                .end
                .and_then(|time| time.date_time)
                .and_then(|text| instant::parse(&text)),
            updated: event.updated.and_then(|text| instant::parse(&text)),
            transparency: event.transparency,
            private_properties: event
                .extended_properties
                .and_then(|properties| properties.private)
                .unwrap_or_default(),
        }
    }
}

/// One page of `events.list`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub items: Option<Vec<EventJson>>,
    pub next_page_token: Option<String>,
}

/// One page of `calendarList.list`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarListPage {
    pub items: Option<Vec<CalendarListEntryJson>>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CalendarListEntryJson {
    id: Option<String>,
    summary: Option<String>,
    primary: Option<bool>,
}

impl From<CalendarListEntryJson> for CalendarSummary {
    /// `listCalendars`: missing values become `""` and `false`.
    fn from(entry: CalendarListEntryJson) -> Self {
        Self {
            id: entry.id.unwrap_or_default(),
            summary: entry.summary.unwrap_or_default(),
            primary: entry.primary.unwrap_or(false),
        }
    }
}

/// `start` or `end` of a request body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTimeBody {
    date_time: String,
    time_zone: String,
}

impl From<&EventTime> for EventTimeBody {
    fn from(time: &EventTime) -> Self {
        Self {
            date_time: instant::to_iso(time.date_time),
            time_zone: time.time_zone.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct ExtendedPropertiesBody {
    private: BTreeMap<String, String>,
}

/// The body of `events.insert` (`createCalendarEvent`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertBody {
    summary: String,
    description: String,
    visibility: &'static str,
    start: EventTimeBody,
    end: EventTimeBody,
    color_id: String,
    extended_properties: ExtendedPropertiesBody,
}

impl From<&NewEvent> for InsertBody {
    fn from(event: &NewEvent) -> Self {
        Self {
            summary: event.summary.clone(),
            description: event.description.clone(),
            visibility: "private",
            start: EventTimeBody::from(&event.start),
            end: EventTimeBody::from(&event.end),
            color_id: event.color_id.clone(),
            extended_properties: ExtendedPropertiesBody {
                private: event.private_properties.clone(),
            },
        }
    }
}

/// The body of `events.patch`: only the changed fields.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start: Option<EventTimeBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end: Option<EventTimeBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transparency: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extended_properties: Option<ExtendedPropertiesBody>,
}

impl From<&EventPatch> for PatchBody {
    fn from(patch: &EventPatch) -> Self {
        Self {
            summary: patch.summary.clone(),
            description: patch.description.clone(),
            start: patch.start.as_ref().map(EventTimeBody::from),
            end: patch.end.as_ref().map(EventTimeBody::from),
            transparency: patch.transparency,
            extended_properties: patch
                .private_properties
                .clone()
                .map(|private| ExtendedPropertiesBody { private }),
        }
    }
}
