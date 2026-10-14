//! The task rules against the Node server (golden test).
//!
//! `fixtures/calendar.golden.json` comes from the Node server code
//! (`script/node-fixtures/calendar.fixtures.ts` at the commit that adds the
//! fixture). This test checks the event-to-task mapping, the event
//! descriptions, the order of `GET /api/tasks`, and the reorder slot swap.
//! The server crate checks the Google request bodies and "Reschedule all"
//! against the same file.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers of this test binary fail a check by panicking"
)]

use std::collections::BTreeMap;

use caltodo_domain::event::{CalendarEvent, description_with_actions};
use caltodo_domain::ids::EventId;
use caltodo_domain::instant::{parse, to_iso};
use caltodo_domain::reorder::{TaskLookup, plan_reorder};
use caltodo_domain::task::{Task, order_task_list};
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/calendar.golden.json")).unwrap()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// Decodes a Google event like the calendar adapter of the server.
fn event(value: &Value) -> CalendarEvent {
    let private: BTreeMap<String, String> = value["extendedProperties"]["private"]
        .as_object()
        .map_or_else(BTreeMap::new, |map| {
            map.iter()
                .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
                .collect()
        });
    CalendarEvent {
        id: text(&value["id"]),
        status: text(&value["status"]),
        summary: text(&value["summary"]),
        description: text(&value["description"]),
        start: value["start"]["dateTime"].as_str().and_then(parse),
        end: value["end"]["dateTime"].as_str().and_then(parse),
        updated: value["updated"].as_str().and_then(parse),
        transparency: text(&value["transparency"]),
        private_properties: private,
    }
}

/// The wire form of a task, like the server DTO.
fn wire(task: &Task) -> Value {
    json!({
        "id": task.id.as_str(),
        "title": task.title,
        "details": task.details,
        "duration": task.duration_minutes,
        "scheduledStart": to_iso(task.scheduled_start),
        "scheduledEnd": to_iso(task.scheduled_end),
        "completed": task.completed,
        "completedAt": task.completed_at.map(to_iso),
        "priority": task.priority,
    })
}

#[test]
fn maps_events_to_tasks_like_the_node_server() {
    let golden = golden();
    let cases = golden["mapEvents"].as_array().unwrap();
    assert_eq!(cases.len(), 25);
    for case in cases {
        let actual = Task::from_event(&event(&case["event"]))
            .as_ref()
            .map_or(Value::Null, wire);
        assert_eq!(actual, case["task"], "{}", case["name"]);
    }
}

#[test]
fn builds_the_action_descriptions_like_the_node_server() {
    let golden = golden();
    let requests = &golden["requests"];
    assert_eq!(
        Value::from(description_with_actions(
            Some("Cover boundary\nSecond line"),
            "https://todo.example/action/tok-raw"
        )),
        requests["createWithDetails"]["actionsPatch"]["requestBody"]["description"]
    );
    assert_eq!(
        Value::from(description_with_actions(
            None,
            "https://todo.example/action/tok-raw"
        )),
        requests["createWithoutDetails"]["actionsPatch"]["requestBody"]["description"]
    );
}

#[test]
fn orders_the_task_list_like_the_node_server() {
    let golden = golden();
    let list = &golden["taskList"];
    let tasks: Vec<Task> = list["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|value| Task::from_event(&event(value)))
        .collect();
    let ordered: Vec<Value> = order_task_list(tasks).iter().map(wire).collect();
    assert_eq!(Value::from(ordered), list["body"]);
}

#[test]
fn plans_the_reorder_like_the_node_server() {
    let golden = golden();
    for scenario in golden["reorder"].as_array().unwrap() {
        let requested: Vec<(EventId, TaskLookup)> = scenario["taskIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| {
                let id = id.as_str().unwrap();
                let lookup = match &scenario["events"][id] {
                    Value::String(deleted) if deleted == "deleted" => TaskLookup::Deleted,
                    Value::Array(values) => TaskLookup::Found {
                        start: parse(values[0].as_str().unwrap()).unwrap(),
                        end: parse(values[1].as_str().unwrap()).unwrap(),
                    },
                    _ => TaskLookup::Unavailable,
                };
                (EventId::new(id).unwrap(), lookup)
            })
            .collect();
        let changes = plan_reorder(&requested, 30).unwrap();
        let actual: Vec<Value> = changes
            .iter()
            .map(|change| {
                json!({
                    "eventId": change.id.as_str(),
                    "start": to_iso(change.start),
                    "end": to_iso(change.end),
                })
            })
            .collect();
        assert_eq!(scenario["status"], 200);
        assert_eq!(
            Value::from(actual),
            scenario["updates"],
            "{}",
            scenario["name"]
        );
    }
}
