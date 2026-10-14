//! "Reschedule all" against the Node server (golden test).
//!
//! `crates/domain/tests/fixtures/calendar.golden.json` holds four scenarios
//! of the Node `rescheduleAllUserTasks`: the calendar events, the clock, the
//! settings, the time patches in order, the list calls, and the summary.

use std::sync::Arc;

use caltodo::application::tasks::reschedule_all;
use caltodo::config::Secret;
use caltodo::db::settings::SettingsChange;
use caltodo::db::users::NewUser;
use caltodo::domain::event::CalendarEvent;
use caltodo::domain::instant::{parse, to_iso};
use caltodo::fakes::{CalendarCall, FakeCalendar, FakeOAuth, FixedClock};
use caltodo::wiring::{self, Adapters};
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::support::{settings, ts};

fn event(value: &Value) -> CalendarEvent {
    let text = |field: &str| value[field].as_str().map(str::to_owned);
    CalendarEvent {
        id: text("id"),
        status: text("status"),
        summary: text("summary"),
        description: text("description"),
        start: value["start"]["dateTime"].as_str().and_then(parse),
        end: value["end"]["dateTime"].as_str().and_then(parse),
        updated: value["updated"].as_str().and_then(parse),
        transparency: text("transparency"),
        private_properties: value["extendedProperties"]["private"]
            .as_object()
            .map(|map| {
                map.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn reschedule_all_equals_the_node_scenarios(pool: PgPool) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../domain/tests/fixtures/calendar.golden.json"
    );
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let scenarios = golden["rescheduleAll"].as_array().unwrap();
    assert_eq!(scenarios.len(), 4);
    for (index, scenario) in scenarios.iter().enumerate() {
        let name = scenario["name"].as_str().unwrap();
        let clock = FixedClock::new(ts(scenario["now"].as_str().unwrap()));
        let calendar = FakeCalendar::new(Arc::new(clock.clone()));
        let adapters = Adapters {
            calendar: Arc::new(calendar.clone()),
            oauth: Arc::new(FakeOAuth::new("/cb")),
            clock: Arc::new(clock),
        };
        let services = wiring::services(pool.clone(), &settings("UTC"), &adapters);
        let user = services
            .store
            .record_sign_in(
                &NewUser {
                    google_id: format!("sub-{index}"),
                    email: String::new(),
                    display_name: "U".into(),
                },
                &Secret::new("access"),
                None,
            )
            .await
            .unwrap();
        let config = &scenario["settings"];
        services
            .store
            .save_settings(
                &user.id,
                &SettingsChange {
                    calendar_id: Some("primary".into()),
                    work_start_hour: i32::try_from(config["workStartHour"].as_i64().unwrap())
                        .unwrap(),
                    work_end_hour: i32::try_from(config["workEndHour"].as_i64().unwrap()).unwrap(),
                    timezone: config["timezone"].as_str().unwrap().to_owned(),
                    default_duration: i32::try_from(config["defaultDuration"].as_i64().unwrap())
                        .unwrap(),
                    event_color: "1".into(),
                },
            )
            .await
            .unwrap();
        for value in scenario["events"].as_array().unwrap() {
            calendar.put_event("primary", event(value));
        }
        for id in scenario["failPatch"].as_array().into_iter().flatten() {
            calendar.fail_patch(id.as_str().unwrap());
        }
        for id in scenario["cancelled"].as_array().into_iter().flatten() {
            calendar.cancel_on_get(id.as_str().unwrap());
        }
        let priority: Vec<String> = scenario["priority"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|id| id.as_str().unwrap().to_owned())
            .collect();

        let summary = reschedule_all(&services, &user.id, &priority)
            .await
            .unwrap();

        assert_eq!(
            serde_json::to_value(summary).unwrap(),
            scenario["summary"],
            "{name}"
        );
        let calls = calendar.calls();
        let patches: Vec<Value> = calls
            .iter()
            .filter_map(|call| match call {
                CalendarCall::Patch { event, patch } => Some(json!({
                    "eventId": event,
                    "start": {"dateTime": to_iso(patch.start.as_ref().unwrap().date_time), "timeZone": patch.start.as_ref().unwrap().time_zone},
                    "end": {"dateTime": to_iso(patch.end.as_ref().unwrap().date_time), "timeZone": patch.end.as_ref().unwrap().time_zone},
                })),
                _ => None,
            })
            .collect();
        assert_eq!(Value::from(patches), scenario["patches"], "{name}");
        let lists: Vec<Value> = calls
            .iter()
            .filter_map(|call| match call {
                CalendarCall::List {
                    time_min, time_max, ..
                } => Some(json!({
                    "timeMin": to_iso(*time_min),
                    "timeMax": to_iso(*time_max),
                })),
                _ => None,
            })
            .collect();
        assert_eq!(Value::from(lists), scenario["listCalls"], "{name}");
    }
}
