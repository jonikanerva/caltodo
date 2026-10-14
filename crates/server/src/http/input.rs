//! Request body decoding and validation with the rules of the Node server
//! (`shared/schema.ts`, Zod).
//!
//! The body middleware (`body.rs`) has already read the body under its size
//! limit and checked that a JSON body parses. Each function here checks the
//! shape like Zod did: a missing optional field is fine, `null` is not, and
//! unknown fields are ignored.

use caltodo_domain::ids::EventId;
use caltodo_domain::settings::{
    TASK_IDS_MAX, TaskMinutes, TimeZoneName, WorkHour, is_valid_details, is_valid_title,
};
use caltodo_domain::text::utf16_len;
use serde_json::{Map, Value};

use crate::application::actions::ActionKind;
use crate::application::tasks::NewTask;
use crate::db::settings::SettingsChange;

/// The body does not pass the check. Each route maps it to its own problem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("invalid request body")]
pub struct Invalid;

/// The decoded body of a request: JSON, a form, or nothing that a parser of
/// the Node server read.
#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    /// No JSON or form body. Express left `req.body` empty.
    None,
    Json(Value),
    Form(Vec<(String, String)>),
}

impl Body {
    /// The JSON object of the body.
    fn object(&self) -> Option<&Map<String, Value>> {
        match self {
            Self::Json(Value::Object(map)) => Some(map),
            Self::None | Self::Json(_) | Self::Form(_) => None,
        }
    }

    /// The text field `name`: a JSON string or the first form value.
    #[must_use]
    pub fn text_field(&self, name: &str) -> Option<&str> {
        match self {
            Self::Json(Value::Object(map)) => map.get(name).and_then(Value::as_str),
            // A repeated form key became an array in Express, and an array
            // is no text.
            Self::Form(pairs) => {
                let mut values = pairs.iter().filter(|(key, _)| key == name);
                match (values.next(), values.next()) {
                    (Some((_, value)), None) => Some(value.as_str()),
                    _ => None,
                }
            }
            Self::None | Self::Json(_) => None,
        }
    }
}

/// An optional field: absent is `Ok(None)`, any present value must pass.
fn optional<'a, T>(
    map: &'a Map<String, Value>,
    name: &str,
    read: impl FnOnce(&'a Value) -> Option<T>,
) -> Result<Option<T>, Invalid> {
    match map.get(name) {
        None => Ok(None),
        Some(value) => read(value).map(Some).ok_or(Invalid),
    }
}

/// A whole number. Zod accepted any number; the integer columns of the
/// database and the minute arithmetic need whole numbers.
fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.fract() == 0.0 && number.abs() < 9.0e15)
            .map(|number| {
                // A whole number below 2^53 converts exactly.
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "the value is whole and below 2^53"
                )]
                let whole = number as i64;
                whole
            })
    })
}

/// `createTaskSchema`.
///
/// # Errors
///
/// An invalid body (`Invalid request payload`).
pub fn new_task(body: &Body) -> Result<NewTask, Invalid> {
    let map = body.object().ok_or(Invalid)?;
    let title = map.get("title").and_then(Value::as_str).ok_or(Invalid)?;
    if !is_valid_title(title) {
        return Err(Invalid);
    }
    let details = optional(map, "details", Value::as_str)?;
    if details.is_some_and(|details| !is_valid_details(details)) {
        return Err(Invalid);
    }
    let urgent = optional(map, "urgent", Value::as_bool)?.unwrap_or(false);
    let duration = optional(map, "duration", integer)?
        .map(|minutes| TaskMinutes::from_i64(minutes).ok_or(Invalid))
        .transpose()?;
    Ok(NewTask {
        title: title.to_owned(),
        // `data.details || null`: empty details are no details.
        details: details
            .filter(|details| !details.is_empty())
            .map(str::to_owned),
        urgent,
        duration_minutes: duration.map(TaskMinutes::get),
    })
}

/// `{ completed: boolean }` of `PATCH /api/tasks/{id}`.
///
/// # Errors
///
/// An invalid body (`Invalid request payload`).
pub fn completion(body: &Body) -> Result<bool, Invalid> {
    body.object()
        .and_then(|map| map.get("completed"))
        .and_then(Value::as_bool)
        .ok_or(Invalid)
}

/// `taskIdsSchema`: 1 to 200 non-empty strings.
///
/// # Errors
///
/// An invalid body (`Invalid taskIds payload`).
pub fn task_ids(body: &Body) -> Result<Vec<EventId>, Invalid> {
    let items = body
        .object()
        .and_then(|map| map.get("taskIds"))
        .and_then(Value::as_array)
        .ok_or(Invalid)?;
    if items.is_empty() || items.len() > TASK_IDS_MAX {
        return Err(Invalid);
    }
    items
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|id| utf16_len(id) >= 1)
                .and_then(EventId::new)
                .ok_or(Invalid)
        })
        .collect()
}

/// `updateSettingsSchema`.
///
/// # Errors
///
/// An invalid body (`Invalid settings data`).
pub fn settings_change(body: &Body) -> Result<SettingsChange, Invalid> {
    let map = body.object().ok_or(Invalid)?;
    let calendar_id = optional(map, "calendarId", Value::as_str)?;
    let hour = |name: &str| {
        map.get(name)
            .and_then(integer)
            .and_then(WorkHour::from_i64)
            .ok_or(Invalid)
    };
    let work_start_hour = hour("workStartHour")?;
    let work_end_hour = hour("workEndHour")?;
    let timezone = map
        .get("timezone")
        .and_then(Value::as_str)
        .and_then(TimeZoneName::parse)
        .ok_or(Invalid)?;
    let default_duration = map
        .get("defaultDuration")
        .and_then(integer)
        .and_then(TaskMinutes::from_i64)
        .ok_or(Invalid)?;
    let event_color = map
        .get("eventColor")
        .and_then(Value::as_str)
        .ok_or(Invalid)?;
    Ok(SettingsChange {
        calendar_id: calendar_id.map(str::to_owned),
        work_start_hour: i32::from(work_start_hour.get()),
        work_end_hour: i32::from(work_end_hour.get()),
        timezone: timezone.as_str().to_owned(),
        // 15 to 480 fits in i32.
        default_duration: i32::try_from(default_duration.get()).map_err(|_| Invalid)?,
        event_color: event_color.to_owned(),
    })
}

/// `actionRequestSchema`: `action` of a JSON body or a form.
///
/// # Errors
///
/// A missing or unknown action (`Invalid action.`).
pub fn action(body: &Body) -> Result<ActionKind, Invalid> {
    body.text_field("action")
        .and_then(ActionKind::parse)
        .ok_or(Invalid)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn json_body(value: Value) -> Body {
        Body::Json(value)
    }

    #[test]
    fn validates_a_new_task_like_zod() {
        let task = new_task(&json_body(json!({"title": "Write", "extra": 1}))).unwrap();
        assert_eq!(task.title, "Write");
        assert!(!task.urgent);
        assert_eq!(task.duration_minutes, None);
        let full = new_task(&json_body(
            json!({"title": "T", "details": "D", "urgent": true, "duration": 30}),
        ))
        .unwrap();
        assert_eq!(full.details.as_deref(), Some("D"));
        assert!(full.urgent);
        assert_eq!(full.duration_minutes, Some(30));
        assert_eq!(
            new_task(&json_body(json!({"title": "T", "details": ""})))
                .unwrap()
                .details,
            None
        );
        for invalid in [
            json!({}),
            json!({"title": ""}),
            json!({"title": "a".repeat(201)}),
            json!({"title": "T", "details": null}),
            json!({"title": "T", "details": "d".repeat(5001)}),
            json!({"title": "T", "urgent": "yes"}),
            json!({"title": "T", "duration": 14}),
            json!({"title": "T", "duration": 481}),
            json!({"title": "T", "duration": 22.5}),
            json!({"title": "T", "duration": null}),
            json!(["title"]),
        ] {
            assert_eq!(
                new_task(&json_body(invalid.clone())),
                Err(Invalid),
                "{invalid}"
            );
        }
        assert_eq!(new_task(&Body::None), Err(Invalid));
    }

    #[test]
    fn validates_task_ids() {
        assert_eq!(
            task_ids(&json_body(json!({"taskIds": ["a", "b"]})))
                .unwrap()
                .len(),
            2
        );
        for invalid in [
            json!({"taskIds": []}),
            json!({"taskIds": [""]}),
            json!({"taskIds": "bad"}),
            json!({"taskIds": [1]}),
            json!({"taskIds": vec!["x"; 201]}),
        ] {
            assert_eq!(
                task_ids(&json_body(invalid.clone())),
                Err(Invalid),
                "{invalid}"
            );
        }
    }

    #[test]
    fn validates_settings() {
        let valid = json!({
            "workStartHour": 9, "workEndHour": 17, "timezone": "Europe/Helsinki",
            "defaultDuration": 60, "eventColor": "3"
        });
        let change = settings_change(&json_body(valid.clone())).unwrap();
        assert_eq!(change.calendar_id, None);
        assert_eq!(change.timezone, "Europe/Helsinki");
        let mut with_calendar = valid.clone();
        with_calendar["calendarId"] = json!("primary");
        assert_eq!(
            settings_change(&json_body(with_calendar))
                .unwrap()
                .calendar_id
                .as_deref(),
            Some("primary")
        );
        for (field, value) in [
            ("workStartHour", json!(24)),
            ("workEndHour", json!(-1)),
            ("timezone", json!("Mars/Olympus")),
            ("defaultDuration", json!(14)),
            ("eventColor", json!(1)),
            ("calendarId", json!(null)),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert_eq!(
                settings_change(&json_body(invalid)),
                Err(Invalid),
                "{field}"
            );
        }
    }

    #[test]
    fn reads_the_action_of_json_and_forms() {
        assert_eq!(
            action(&json_body(json!({"action": "complete"}))),
            Ok(ActionKind::Complete)
        );
        assert_eq!(
            action(&Body::Form(vec![
                ("csrfToken".into(), "x".into()),
                ("action".into(), "reschedule".into())
            ])),
            Ok(ActionKind::Reschedule)
        );
        assert_eq!(
            action(&json_body(json!({"action": "delete"}))),
            Err(Invalid)
        );
        assert_eq!(action(&Body::None), Err(Invalid));
    }
}
