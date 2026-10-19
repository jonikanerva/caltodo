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
    let reply = post(
        &app,
        &client,
        "/api/tasks",
        &json!({"title": "Urgent", "urgent": true, "duration": 30}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let urgent = reply.json();
    assert_eq!(urgent["scheduledStart"], "2026-03-02T09:00:00.000Z");
    let old = app.calendar.event("primary", "old").unwrap();
    assert_eq!(old.start, Some(ts("2026-03-02T09:30:00Z")));
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
    let reply = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": ["t1", "t2", "gone"]}),
    )
    .await;
    assert_eq!(reply.json(), json!({"success": true}));
    assert_eq!(
        app.calendar.event("primary", "t1").unwrap().start,
        Some(ts("2026-03-03T09:00:00Z"))
    );
    assert_eq!(
        app.calendar.event("primary", "t2").unwrap().start,
        Some(ts("2026-03-03T10:00:00Z"))
    );
    let invalid = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": "bad"}),
    )
    .await;
    assert_eq!(invalid.problem(StatusCode::BAD_REQUEST), "invalid_task_ids");
    assert_eq!(invalid.json()["detail"], "Invalid taskIds payload");
    let none = post(
        &app,
        &client,
        "/api/tasks/reorder",
        &json!({"taskIds": ["gone"]}),
    )
    .await;
    assert_eq!(none.problem(StatusCode::NOT_FOUND), "no_tasks_to_reorder");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn bulk_complete_reports_success_even_for_missing_tasks(pool: PgPool) {
    let (app, client) = ready(pool).await;
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
    let reply = post(
        &app,
        &client,
        "/api/tasks/bulk-complete",
        &json!({"taskIds": ["t1", "missing"]}),
    )
    .await;
    assert_eq!(reply.json(), json!({"success": true}));
    assert_eq!(
        app.calendar.event("primary", "t1").unwrap().completion(),
        Some(true)
    );
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
