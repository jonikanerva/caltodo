//! The task routes through the router (`taskRoutes.test.ts`,
//! `task-api.integration.test.ts`, `calendar.test.ts`) and the P3 fixes.

use axum::http::{Method, StatusCode};
use caltodo::application::ports::GoogleError;
use caltodo::fakes::CalendarCall;
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::support::{Client, TestApp, busy_event, task_event, ts};

async fn ready(pool: PgPool) -> (TestApp, Client) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-t", "t@example.com", "Tess").await;
    app.configure_calendar(&client, "UTC").await;
    (app, client)
}

async fn post(app: &TestApp, client: &Client, path: &str, body: &Value) -> crate::support::Reply {
    app.send(client.request(Method::POST, path).json(body).build())
        .await
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_list_is_empty_without_a_calendar(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-e", "e@example.com", "E").await;
    let reply = app
        .send(client.request(Method::GET, "/api/tasks").build())
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!([]));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_list_orders_tasks_and_reads_the_window(pool: PgPool) {
    let (app, client) = ready(pool).await;
    app.clock.set(ts("2026-02-10T12:00:00Z"));
    app.calendar.put_event(
        "primary",
        task_event(
            "late",
            "Late",
            "2026-02-12T09:00:00Z",
            "2026-02-12T10:00:00Z",
            Some(false),
        ),
    );
    app.calendar.put_event(
        "primary",
        task_event(
            "early",
            "Early",
            "2026-02-11T09:00:00Z",
            "2026-02-11T09:30:00Z",
            None,
        ),
    );
    app.calendar.put_event(
        "primary",
        task_event(
            "done",
            "Done",
            "2026-02-01T09:00:00Z",
            "2026-02-01T10:00:00Z",
            Some(true),
        ),
    );
    app.calendar.put_event(
        "primary",
        busy_event("meeting", "2026-02-11T08:00:00Z", "2026-02-11T08:30:00Z"),
    );
    app.calendar.put_event(
        "primary",
        task_event(
            "far",
            "Far",
            "2026-08-01T09:00:00Z",
            "2026-08-01T10:00:00Z",
            Some(false),
        ),
    );
    let reply = app
        .send(client.request(Method::GET, "/api/tasks").build())
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let tasks = reply.json();
    let ids: Vec<&str> = tasks
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["early", "late", "done"]);
    assert_eq!(
        tasks[0],
        json!({
            "id": "early", "title": "Early", "details": "Details of Early", "duration": 30,
            "scheduledStart": "2026-02-11T09:00:00.000Z", "scheduledEnd": "2026-02-11T09:30:00.000Z",
            "completed": false, "completedAt": null, "priority": 0
        })
    );
    assert_eq!(tasks[1]["priority"], 1);
    assert_eq!(tasks[2]["completedAt"], "2026-03-01T08:00:00.000Z");
    let window = app
        .calendar
        .calls()
        .into_iter()
        .find_map(|call| match call {
            CalendarCall::List {
                time_min, time_max, ..
            } => Some((time_min, time_max)),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        window,
        (ts("2026-01-27T12:00:00Z"), ts("2026-05-11T12:00:00Z"))
    );
}

/// P3(a): the Node server answered an empty list when Google failed.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_google_failure_is_an_error_not_an_empty_list(pool: PgPool) {
    let (app, client) = ready(pool).await;
    app.calendar.put_event(
        "primary",
        task_event(
            "t1",
            "T",
            "2026-03-03T09:00:00Z",
            "2026-03-03T09:30:00Z",
            Some(false),
        ),
    );
    app.calendar.fail_list(Some(GoogleError::Transport));
    let reply = app
        .send(client.request(Method::GET, "/api/tasks").build())
        .await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn without_stored_google_access_the_list_is_500(pool: PgPool) {
    let (app, client) = ready(pool).await;
    sqlx::query("UPDATE users SET access_token = NULL")
        .execute(&app.pool)
        .await
        .unwrap();
    let reply = app
        .send(client.request(Method::GET, "/api/tasks").build())
        .await;
    assert_eq!(
        reply.problem(StatusCode::INTERNAL_SERVER_ERROR),
        "calendar_unavailable"
    );
    assert_eq!(reply.json()["detail"], "Failed to access calendar");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn creates_a_task_in_the_first_free_slot_with_an_action_link(pool: PgPool) {
    let (app, client) = ready(pool).await;
    app.calendar.put_event(
        "primary",
        busy_event("busy", "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z"),
    );
    let reply = post(
        &app,
        &client,
        "/api/tasks",
        &json!({"title": "Write tests", "details": "Cover it", "duration": 45}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json()["urgentMoveFailed"], false);
    let task = reply.json();
    assert_eq!(task["title"], "Write tests");
    assert_eq!(task["details"], "Cover it");
    assert_eq!(task["scheduledStart"], "2026-03-02T10:00:00.000Z");
    assert_eq!(task["scheduledEnd"], "2026-03-02T10:45:00.000Z");
    assert_eq!(task["duration"], 45);
    let event = app
        .calendar
        .event("primary", task["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(event.summary.as_deref(), Some("☑️ Write tests"));
    let description = event.description.unwrap();
    assert!(
        description.starts_with("Cover it\n\nActions:\n- Manage: https://todo.example/action/"),
        "{description}"
    );
    assert!(
        description.ends_with("\n\n---\nCreated by Todo"),
        "{description}"
    );
    let tokens: i64 =
        sqlx::query_scalar("SELECT count(*) FROM action_tokens WHERE used_at IS NULL")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(tokens, 1);
    // The default duration of the settings applies without a duration.
    let default = post(&app, &client, "/api/tasks", &json!({"title": "Second"})).await;
    assert_eq!(default.json()["duration"], 30);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn task_creation_failures_keep_their_codes(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-f", "f@example.com", "F").await;
    let no_calendar = post(&app, &client, "/api/tasks", &json!({"title": "T"})).await;
    assert_eq!(no_calendar.problem(StatusCode::BAD_REQUEST), "no_calendar");
    assert_eq!(no_calendar.json()["detail"], "No calendar configured");
    app.configure_calendar(&client, "UTC").await;
    for invalid in [
        json!({}),
        json!({"title": ""}),
        json!({"title": "T", "duration": 10}),
        json!({"title": "T", "details": null}),
    ] {
        let reply = post(&app, &client, "/api/tasks", &invalid).await;
        assert_eq!(
            reply.problem(StatusCode::BAD_REQUEST),
            "invalid_request",
            "{invalid}"
        );
        assert_eq!(reply.json()["detail"], "Invalid request payload");
    }
    // No slot: work hours that end before they start.
    sqlx::query("UPDATE user_settings SET work_start_hour = 17, work_end_hour = 9")
        .execute(&app.pool)
        .await
        .unwrap();
    let no_slot = post(&app, &client, "/api/tasks", &json!({"title": "T"})).await;
    assert_eq!(no_slot.problem(StatusCode::CONFLICT), "no_free_slot");
    assert_eq!(
        no_slot.json()["detail"],
        "No free time slots available in the next 90 days."
    );
    sqlx::query("UPDATE user_settings SET work_start_hour = 9, work_end_hour = 17")
        .execute(&app.pool)
        .await
        .unwrap();
    app.calendar.fail_insert(Some(GoogleError::Status(500)));
    let not_created = post(&app, &client, "/api/tasks", &json!({"title": "T"})).await;
    assert_eq!(
        not_created.problem(StatusCode::INTERNAL_SERVER_ERROR),
        "event_not_created"
    );
    assert_eq!(
        not_created.json()["detail"],
        "Failed to create calendar event"
    );
}

/// P3(a): a slot search that cannot read the calendar fails instead of
/// reporting "no free slot" (Node) or ignoring the busy events.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_failed_slot_search_is_a_google_error(pool: PgPool) {
    let (app, client) = ready(pool).await;
    app.calendar.fail_list(Some(GoogleError::Status(500)));
    let reply = post(&app, &client, "/api/tasks", &json!({"title": "T"})).await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn an_urgent_task_moves_to_the_front(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_old_task(&app);
    let reply = post_urgent(&app, &client).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json()["urgentMoveFailed"], false);
    assert_eq!(reply.json()["scheduledStart"], "2026-03-02T09:00:00.000Z");
    let old = app.calendar.event("primary", "old").unwrap();
    assert_eq!(old.start, Some(ts("2026-03-02T09:30:00Z")));
}

fn put_old_task(app: &TestApp) {
    app.calendar.put_event(
        "primary",
        task_event(
            "old",
            "Old",
            "2026-03-02T09:00:00Z",
            "2026-03-02T10:00:00Z",
            Some(false),
        ),
    );
}

async fn post_urgent(app: &TestApp, client: &Client) -> crate::support::Reply {
    post(
        app,
        client,
        "/api/tasks",
        &json!({"title": "Urgent", "urgent": true, "duration": 30}),
    )
    .await
}

/// Issue #5 item 4: the task exists, so the answer stays 200, but it
/// reports that the other tasks did not move after the urgent task.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_failed_move_of_another_task_is_reported(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_old_task(&app);
    app.calendar.fail_patch("old");
    let reply = post_urgent(&app, &client).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json()["urgentMoveFailed"], true);
    // The urgent task moved to the front; the old task kept its slot.
    assert_eq!(reply.json()["scheduledStart"], "2026-03-02T09:00:00.000Z");
    let old = app.calendar.event("primary", "old").unwrap();
    assert_eq!(old.start, Some(ts("2026-03-02T09:00:00Z")));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_failed_reschedule_after_an_urgent_create_is_reported(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_old_task(&app);
    // The slot search of the create reads the calendar; the read of
    // "reschedule all" fails.
    app.calendar.fail_lists_after(1, GoogleError::Status(503));
    let reply = post_urgent(&app, &client).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json()["urgentMoveFailed"], true);
    // The task stays in the first free slot, after the old task.
    assert_eq!(reply.json()["scheduledStart"], "2026-03-02T10:00:00.000Z");
    let old = app.calendar.event("primary", "old").unwrap();
    assert_eq!(old.start, Some(ts("2026-03-02T09:00:00Z")));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn completes_and_reopens_a_task(pool: PgPool) {
    let (app, client) = ready(pool).await;
    app.calendar.put_event(
        "primary",
        task_event(
            "t1",
            "Task",
            "2026-03-03T09:00:00Z",
            "2026-03-03T09:30:00Z",
            Some(false),
        ),
    );
    app.clock.set(ts("2026-03-02T11:00:00Z"));
    let done = app
        .send(
            client
                .request(Method::PATCH, "/api/tasks/t1")
                .json(&json!({"completed": true}))
                .build(),
        )
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.text());
    assert_eq!(done.json()["completed"], true);
    assert_eq!(done.json()["completedAt"], "2026-03-02T11:00:00.000Z");
    let event = app.calendar.event("primary", "t1").unwrap();
    assert_eq!(event.summary.as_deref(), Some("✅ Task"));
    assert_eq!(event.transparency.as_deref(), Some("transparent"));
    assert_eq!(
        event
            .private_properties
            .get("caltodoCompleted")
            .map(String::as_str),
        Some("true")
    );
    let redo = app
        .send(
            client
                .request(Method::PATCH, "/api/tasks/t1")
                .json(&json!({"completed": false}))
                .build(),
        )
        .await;
    assert_eq!(redo.json()["completed"], false);
    let event = app.calendar.event("primary", "t1").unwrap();
    assert_eq!(event.summary.as_deref(), Some("☑️ Task"));
    assert_eq!(event.transparency.as_deref(), Some("opaque"));

    let missing = app
        .send(
            client
                .request(Method::PATCH, "/api/tasks/nope")
                .json(&json!({"completed": true}))
                .build(),
        )
        .await;
    assert_eq!(missing.problem(StatusCode::NOT_FOUND), "task_not_found");
    assert_eq!(missing.json()["detail"], "Task not found");
    let invalid = app
        .send(
            client
                .request(Method::PATCH, "/api/tasks/t1")
                .json(&json!({"completed": "yes"}))
                .build(),
        )
        .await;
    assert_eq!(invalid.problem(StatusCode::BAD_REQUEST), "invalid_request");
    // A foreign event is no task.
    app.calendar.put_event(
        "primary",
        busy_event("meeting", "2026-03-03T10:00:00Z", "2026-03-03T11:00:00Z"),
    );
    let foreign = app
        .send(
            client
                .request(Method::POST, "/api/tasks/meeting/complete")
                .build(),
        )
        .await;
    assert_eq!(foreign.problem(StatusCode::NOT_FOUND), "task_not_found");
    let complete = app
        .send(
            client
                .request(Method::POST, "/api/tasks/t1/complete")
                .build(),
        )
        .await;
    assert_eq!(complete.json(), json!({"success": true}));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn reorders_by_swapping_slots(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    let reply = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": ["t1", "t2"]}),
    )
    .await;
    assert_eq!(reply.json(), json!({"success": true}));
    assert_eq!(start_of(&app, "t1"), ts("2026-03-03T09:00:00Z"));
    assert_eq!(start_of(&app, "t2"), ts("2026-03-03T10:00:00Z"));
    let invalid = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": "bad"}),
    )
    .await;
    assert_eq!(invalid.problem(StatusCode::BAD_REQUEST), "invalid_task_ids");
    assert_eq!(invalid.json()["detail"], "Invalid taskIds payload");
}

fn put_two_tasks(app: &TestApp) {
    app.calendar.put_event(
        "primary",
        task_event(
            "t1",
            "One",
            "2026-03-03T10:00:00Z",
            "2026-03-03T10:30:00Z",
            Some(false),
        ),
    );
    app.calendar.put_event(
        "primary",
        task_event(
            "t2",
            "Two",
            "2026-03-03T09:00:00Z",
            "2026-03-03T09:30:00Z",
            Some(false),
        ),
    );
}

fn start_of(app: &TestApp, id: &str) -> jiff::Timestamp {
    app.calendar.event("primary", id).unwrap().start.unwrap()
}

fn patches(app: &TestApp) -> Vec<String> {
    app.calendar
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            CalendarCall::Patch { event, .. } => Some(event),
            _ => None,
        })
        .collect()
}

/// Issue #5 item 5: one invalid task among valid tasks stops the whole
/// request before the first change (DOCTRINE P5).
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_reorder_with_one_invalid_task_changes_nothing(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    app.calendar.put_event(
        "primary",
        task_event(
            "cancelled",
            "Gone",
            "2026-03-03T11:00:00Z",
            "2026-03-03T11:30:00Z",
            Some(false),
        ),
    );
    app.calendar.cancel_on_get("cancelled");
    app.calendar.put_event(
        "primary",
        busy_event("meeting", "2026-03-03T12:00:00Z", "2026-03-03T13:00:00Z"),
    );
    let mut timeless = task_event(
        "timeless",
        "No time",
        "2026-03-03T14:00:00Z",
        "2026-03-03T14:30:00Z",
        Some(false),
    );
    timeless.end = None;
    app.calendar.put_event("primary", timeless);
    for (invalid, status, code, detail) in [
        (
            "gone",
            StatusCode::NOT_FOUND,
            "task_not_found",
            "Task not found",
        ),
        (
            "cancelled",
            StatusCode::NOT_FOUND,
            "task_not_found",
            "Task not found",
        ),
        (
            "meeting",
            StatusCode::NOT_FOUND,
            "task_not_found",
            "Task not found",
        ),
        (
            "timeless",
            StatusCode::BAD_REQUEST,
            "invalid_event_time",
            "Invalid event time range.",
        ),
    ] {
        let reply = post(
            &app,
            &client,
            "/api/tasks/reorder",
            &json!({"taskIds": ["t1", invalid, "t2"]}),
        )
        .await;
        assert_eq!(reply.problem(status), code, "{invalid}");
        assert_eq!(reply.json()["detail"], detail, "{invalid}");
    }
    // Only missing tasks: the same answer (`no_tasks_to_reorder` is gone).
    let none = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": ["gone"]}),
    )
    .await;
    assert_eq!(none.problem(StatusCode::NOT_FOUND), "task_not_found");
    assert_eq!(patches(&app), Vec::<String>::new());
    assert_eq!(start_of(&app, "t1"), ts("2026-03-03T10:00:00Z"));
    assert_eq!(start_of(&app, "t2"), ts("2026-03-03T09:00:00Z"));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_reorder_with_a_failed_read_changes_nothing(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    app.calendar.fail_get("t2", GoogleError::Status(500));
    let reply = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": ["t1", "t2"]}),
    )
    .await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
    assert_eq!(patches(&app), Vec::<String>::new());
    assert_eq!(start_of(&app, "t1"), ts("2026-03-03T10:00:00Z"));
}

/// A failed move stops the request with an error; Google Calendar has no
/// transaction, so a move before it stays.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_reorder_stops_at_a_failed_move(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    app.calendar.fail_patch("t2");
    let reply = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": ["t1", "t2"]}),
    )
    .await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
    assert_eq!(patches(&app), vec!["t1".to_owned(), "t2".to_owned()]);
    assert_eq!(start_of(&app, "t1"), ts("2026-03-03T09:00:00Z"));
    assert_eq!(start_of(&app, "t2"), ts("2026-03-03T09:00:00Z"));

    app.calendar.put_event(
        "primary",
        task_event(
            "t3",
            "Three",
            "2026-03-03T08:00:00Z",
            "2026-03-03T08:30:00Z",
            Some(false),
        ),
    );
    app.calendar.fail_patch("t1");
    app.calendar.clear_calls();
    let first = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": ["t1", "t3"]}),
    )
    .await;
    assert_eq!(first.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
    // The request stops at the first failure: t3 is not moved.
    assert_eq!(patches(&app), vec!["t1".to_owned()]);
    assert_eq!(start_of(&app, "t3"), ts("2026-03-03T08:00:00Z"));
}

/// A task that is gone between the first read and its move (deleted in
/// Google Calendar meanwhile) gives `task_not_found`; the request stops.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_reorder_reports_a_task_that_is_gone_at_the_move(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    // The read before the first change succeeds; the read of the move finds
    // the event deleted.
    app.calendar.fail_gets_after("t1", 1, GoogleError::NotFound);
    let reply = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": ["t1", "t2"]}),
    )
    .await;
    assert_eq!(reply.problem(StatusCode::NOT_FOUND), "task_not_found");
    assert_eq!(reply.json()["detail"], "Task not found");
    assert_eq!(patches(&app), Vec::<String>::new());
    assert_eq!(start_of(&app, "t2"), ts("2026-03-03T09:00:00Z"));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn bulk_complete_completes_every_task(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    let reply = post(
        &app,
        &client,
        "/api/tasks/bulk-complete",
        &json!({"taskIds": ["t1", "t2"]}),
    )
    .await;
    assert_eq!(reply.json(), json!({"success": true}));
    for id in ["t1", "t2"] {
        let event = app.calendar.event("primary", id).unwrap();
        assert_eq!(event.completion(), Some(true), "{id}");
    }
}

/// Issue #5 item 5: the Node server answered a success for missing tasks.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn bulk_complete_with_one_missing_task_changes_nothing(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    let reply = post(
        &app,
        &client,
        "/api/tasks/bulk-complete",
        &json!({"taskIds": ["t1", "missing", "t2"]}),
    )
    .await;
    assert_eq!(reply.problem(StatusCode::NOT_FOUND), "task_not_found");
    assert_eq!(reply.json()["detail"], "Task not found");
    app.calendar.fail_get("t2", GoogleError::Transport);
    let unreadable = post(
        &app,
        &client,
        "/api/tasks/bulk-complete",
        &json!({"taskIds": ["t1", "t2"]}),
    )
    .await;
    assert_eq!(
        unreadable.problem(StatusCode::BAD_GATEWAY),
        "google_unavailable"
    );
    assert_eq!(patches(&app), Vec::<String>::new());
    for id in ["t1", "t2"] {
        let event = app.calendar.event("primary", id).unwrap();
        assert_eq!(event.completion(), Some(false), "{id}");
    }
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn bulk_complete_stops_at_a_failed_change(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    app.calendar.fail_patch("t1");
    let reply = post(
        &app,
        &client,
        "/api/tasks/bulk-complete",
        &json!({"taskIds": ["t2", "t1"]}),
    )
    .await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
    // The change before the failure stays.
    let done = app.calendar.event("primary", "t2").unwrap();
    assert_eq!(done.completion(), Some(true));
    let failed = app.calendar.event("primary", "t1").unwrap();
    assert_eq!(failed.completion(), Some(false));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn without_stored_google_access_no_task_is_found(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_two_tasks(&app);
    sqlx::query("UPDATE users SET access_token = NULL")
        .execute(&app.pool)
        .await
        .unwrap();
    for path in ["/api/tasks/reorder", "/api/tasks/bulk-complete"] {
        let reply = post(&app, &client, path, &json!({"taskIds": ["t1", "t2"]})).await;
        assert_eq!(
            reply.problem(StatusCode::NOT_FOUND),
            "task_not_found",
            "{path}"
        );
    }
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn reload_reads_the_task_list_from_google(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-l", "l@example.com", "L").await;
    let missing = app
        .send(client.request(Method::POST, "/api/tasks/reload").build())
        .await;
    assert_eq!(missing.problem(StatusCode::BAD_REQUEST), "no_calendar");
    assert_eq!(app.calendar.calls(), Vec::<CalendarCall>::new());
    app.configure_calendar(&client, "UTC").await;
    app.calendar.clear_calls();
    let reply = app
        .send(client.request(Method::POST, "/api/tasks/reload").build())
        .await;
    assert_eq!(reply.json(), json!({"success": true}));
    let calls = app.calendar.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(
        matches!(&calls[0], CalendarCall::List { calendar, .. } if calendar == "primary"),
        "{calls:?}"
    );
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_failed_google_read_fails_the_reload(pool: PgPool) {
    let (app, client) = ready(pool).await;
    app.calendar.fail_list(Some(GoogleError::Transport));
    let reply = app
        .send(client.request(Method::POST, "/api/tasks/reload").build())
        .await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
    app.calendar.fail_list(Some(GoogleError::TooManyPages));
    let reply = app
        .send(client.request(Method::POST, "/api/tasks/reload").build())
        .await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn reschedules_one_task_and_all_tasks(pool: PgPool) {
    let (app, client) = ready(pool).await;
    app.calendar.put_event(
        "primary",
        task_event(
            "t1",
            "One",
            "2026-03-04T15:00:00Z",
            "2026-03-04T15:30:00Z",
            Some(false),
        ),
    );
    app.calendar.put_event(
        "primary",
        busy_event("busy", "2026-03-02T09:00:00Z", "2026-03-02T09:30:00Z"),
    );
    let one = app
        .send(
            client
                .request(Method::POST, "/api/tasks/t1/reschedule")
                .build(),
        )
        .await;
    assert_eq!(one.json(), json!({"success": true}));
    assert_eq!(
        app.calendar.event("primary", "t1").unwrap().start,
        Some(ts("2026-03-02T09:30:00Z"))
    );
    let missing = app
        .send(
            client
                .request(Method::POST, "/api/tasks/gone/reschedule")
                .build(),
        )
        .await;
    assert_eq!(missing.problem(StatusCode::NOT_FOUND), "task_not_found");

    app.calendar.put_event(
        "primary",
        task_event(
            "t2",
            "Two",
            "2026-03-05T15:00:00Z",
            "2026-03-05T16:00:00Z",
            Some(false),
        ),
    );
    let all = app
        .send(
            client
                .request(Method::POST, "/api/tasks/reschedule-all")
                .build(),
        )
        .await;
    assert_eq!(
        all.json(),
        json!({"success": true, "summary": {"moved": 1, "unchanged": 1, "skippedNoSlot": 0, "skippedInvalid": 0, "failed": 0}})
    );
    assert_eq!(
        app.calendar.event("primary", "t2").unwrap().start,
        Some(ts("2026-03-02T10:00:00Z"))
    );

    // P3(a): a failed event list is an error, not an empty summary.
    app.calendar.fail_list(Some(GoogleError::Status(503)));
    let failed = app
        .send(
            client
                .request(Method::POST, "/api/tasks/reschedule-all")
                .build(),
        )
        .await;
    assert_eq!(
        failed.problem(StatusCode::BAD_GATEWAY),
        "google_unavailable"
    );
    let failed_one = app
        .send(
            client
                .request(Method::POST, "/api/tasks/t1/reschedule")
                .build(),
        )
        .await;
    assert_eq!(
        failed_one.problem(StatusCode::BAD_GATEWAY),
        "google_unavailable"
    );
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn reschedule_all_without_a_calendar_is_an_empty_summary(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-z", "z@example.com", "Z").await;
    let reply = app
        .send(
            client
                .request(Method::POST, "/api/tasks/reschedule-all")
                .build(),
        )
        .await;
    assert_eq!(
        reply.json(),
        json!({"success": true, "summary": {"moved": 0, "unchanged": 0, "skippedNoSlot": 0, "skippedInvalid": 0, "failed": 0}})
    );
}

/// The single-task routes of issue #29: the update, the complete, and the
/// reschedule of one task.
const SINGLE_TASK_ROUTES: [&str; 3] = ["update", "complete", "reschedule"];

/// The request of a single-task route for the event `id`.
fn single_task_request(
    client: &Client,
    route: &str,
    id: &str,
) -> axum::http::Request<axum::body::Body> {
    match route {
        "update" => client
            .request(Method::PATCH, &format!("/api/tasks/{id}"))
            .json(&json!({"completed": true}))
            .build(),
        other => client
            .request(Method::POST, &format!("/api/tasks/{id}/{other}"))
            .build(),
    }
}

/// Puts an incomplete task event with the id `id` into the calendar.
fn put_task(app: &TestApp, id: &str) {
    app.calendar.put_event(
        "primary",
        task_event(
            id,
            "Single",
            "2026-03-04T15:00:00Z",
            "2026-03-04T15:30:00Z",
            Some(false),
        ),
    );
}

/// Issue #29: a Google failure on a single-task route answers the Google
/// problem of the other routes, not `task_not_found`. The task stays as it
/// was.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn single_task_routes_report_a_google_failure(pool: PgPool) {
    let (app, client) = ready(pool).await;
    let cases = [
        ("read503", GoogleError::Status(503), "google_unavailable"),
        ("transport", GoogleError::Transport, "google_unavailable"),
        (
            "refresh",
            GoogleError::RefreshRejected,
            "google_reauthorization_required",
        ),
    ];
    for route in SINGLE_TASK_ROUTES {
        for (case, error, code) in cases {
            let id = format!("{route}{case}");
            put_task(&app, &id);
            let before = app.calendar.event("primary", &id);
            app.calendar.fail_get(&id, error);
            let reply = app.send(single_task_request(&client, route, &id)).await;
            assert_eq!(
                reply.problem(StatusCode::BAD_GATEWAY),
                code,
                "{route} {case}"
            );
            assert_eq!(app.calendar.event("primary", &id), before, "{route} {case}");
        }
        // The read succeeds, and the change fails.
        let id = format!("{route}patch");
        put_task(&app, &id);
        app.calendar.fail_patch(&id);
        let reply = app.send(single_task_request(&client, route, &id)).await;
        assert_eq!(
            reply.problem(StatusCode::BAD_GATEWAY),
            "google_unavailable",
            "{route} patch"
        );
        assert_eq!(
            reply.json()["detail"],
            "Google Calendar is unavailable. Try again later."
        );
    }
    // The reschedule reads the task again before the move: a failure of
    // that read is a Google failure too.
    put_task(&app, "rescheduleagain");
    app.calendar
        .fail_gets_after("rescheduleagain", 1, GoogleError::Status(500));
    let reply = app
        .send(single_task_request(
            &client,
            "reschedule",
            "rescheduleagain",
        ))
        .await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "google_unavailable");
}

/// Issue #29: `task_not_found` stays for a task that does not exist: a 404
/// or 410 of Google, a cancelled event, or an event that is no task.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn single_task_routes_report_a_missing_task(pool: PgPool) {
    let (app, client) = ready(pool).await;
    for route in SINGLE_TASK_ROUTES {
        let absent = app
            .send(single_task_request(
                &client,
                route,
                &format!("{route}absent"),
            ))
            .await;
        assert_eq!(
            absent.problem(StatusCode::NOT_FOUND),
            "task_not_found",
            "{route} absent"
        );
        assert_eq!(absent.json()["detail"], "Task not found");

        let gone = format!("{route}gone");
        put_task(&app, &gone);
        app.calendar.fail_get(&gone, GoogleError::NotFound);
        let reply = app.send(single_task_request(&client, route, &gone)).await;
        assert_eq!(
            reply.problem(StatusCode::NOT_FOUND),
            "task_not_found",
            "{route} gone"
        );

        let cancelled = format!("{route}cancelled");
        put_task(&app, &cancelled);
        app.calendar.cancel_on_get(&cancelled);
        let reply = app
            .send(single_task_request(&client, route, &cancelled))
            .await;
        assert_eq!(
            reply.problem(StatusCode::NOT_FOUND),
            "task_not_found",
            "{route} cancelled"
        );

        let foreign = format!("{route}foreign");
        app.calendar.put_event(
            "primary",
            busy_event(&foreign, "2026-03-04T10:00:00Z", "2026-03-04T11:00:00Z"),
        );
        let before = app.calendar.event("primary", &foreign);
        let reply = app
            .send(single_task_request(&client, route, &foreign))
            .await;
        assert_eq!(
            reply.problem(StatusCode::NOT_FOUND),
            "task_not_found",
            "{route} foreign"
        );
        assert_eq!(
            app.calendar.event("primary", &foreign),
            before,
            "{route} foreign"
        );
    }
    // The task is gone when the reschedule reads it again before the move.
    put_task(&app, "reschedulelater");
    app.calendar
        .fail_gets_after("reschedulelater", 1, GoogleError::NotFound);
    let reply = app
        .send(single_task_request(
            &client,
            "reschedule",
            "reschedulelater",
        ))
        .await;
    assert_eq!(reply.problem(StatusCode::NOT_FOUND), "task_not_found");
}

/// Assumption A1 of issue #29: without stored Google access the
/// single-task routes keep `task_not_found`, like reorder and bulk complete.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn without_stored_google_access_a_single_task_is_not_found(pool: PgPool) {
    let (app, client) = ready(pool).await;
    put_task(&app, "t1");
    sqlx::query("UPDATE users SET access_token = NULL")
        .execute(&app.pool)
        .await
        .unwrap();
    for route in SINGLE_TASK_ROUTES {
        let reply = app.send(single_task_request(&client, route, "t1")).await;
        assert_eq!(
            reply.problem(StatusCode::NOT_FOUND),
            "task_not_found",
            "{route}"
        );
    }
}
