//! The action links through the router (`actionRoutes.test.ts`,
//! `action-api.integration.test.ts`, and the Node action flow golden).

use axum::http::header::CONTENT_TYPE;
use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;

use crate::support::{Client, TestApp, request, ts};

/// A signed-in user with one task; returns the raw token of its link.
async fn task_with_link(app: &TestApp, client: &Client) -> (String, String) {
    app.configure_calendar(client, "UTC").await;
    let reply = app
        .send(
            client
                .request(Method::POST, "/api/tasks")
                .json(&json!({"title": "Water <plants>", "duration": 30}))
                .build(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let id = reply.json()["id"].as_str().unwrap().to_owned();
    let description = app
        .calendar
        .event("primary", &id)
        .unwrap()
        .description
        .unwrap();
    let token = description
        .split("/action/")
        .nth(1)
        .unwrap()
        .split('\n')
        .next()
        .unwrap()
        .to_owned();
    (id, token)
}

async fn unused_tokens(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM action_tokens WHERE used_at IS NULL")
        .fetch_one(&app.pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_page_asks_a_signed_out_visitor_to_sign_in(pool: PgPool) {
    let app = TestApp::new(pool);
    let reply = app
        .send(request(Method::GET, "/action/raw-token").build())
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.header(CONTENT_TYPE.as_str()),
        Some("text/html; charset=utf-8")
    );
    let page = reply.text();
    assert!(page.contains("<h1>Sign in required</h1>"));
    assert!(page.contains(r#"href="/api/auth/google?actionToken=raw-token""#));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_page_manages_the_task_of_its_owner(pool: PgPool) {
    let app = TestApp::new(pool);
    let owner = app.sign_in("sub-o", "o@example.com", "Owner").await;
    let (_, token) = task_with_link(&app, &owner).await;
    let page = app
        .send(
            owner
                .request(Method::GET, &format!("/action/{token}"))
                .build(),
        )
        .await;
    assert_eq!(page.status, StatusCode::OK);
    let html = page.text();
    assert!(html.contains("<p>\"Water &lt;plants&gt;\"</p>"));
    assert!(html.contains(&format!(
        r#"<input type="hidden" name="csrfToken" value="{}" />"#,
        owner.csrf.clone().unwrap()
    )));
    assert!(html.contains(&format!(r#"action="/api/action/{token}""#)));

    let other = app.sign_in("sub-other", "x@example.com", "Other").await;
    let forbidden = app
        .send(
            other
                .request(Method::GET, &format!("/action/{token}"))
                .build(),
        )
        .await;
    assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
    assert!(forbidden.text().contains("<h1>Not authorized</h1>"));

    let unknown = app
        .send(owner.request(Method::GET, "/action/unknown").build())
        .await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert!(unknown.text().contains("<h1>Invalid or expired link</h1>"));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_page_reports_a_deleted_task(pool: PgPool) {
    let app = TestApp::new(pool);
    let owner = app.sign_in("sub-o", "o@example.com", "Owner").await;
    let (id, token) = task_with_link(&app, &owner).await;
    let mut event = app.calendar.event("primary", &id).unwrap();
    event.status = Some("cancelled".to_owned());
    app.calendar.put_event("primary", event);
    let page = app
        .send(
            owner
                .request(Method::GET, &format!("/action/{token}"))
                .build(),
        )
        .await;
    assert_eq!(page.status, StatusCode::NOT_FOUND);
    assert!(page.text().contains("This task may have been deleted."));
}

/// Node parity (`fixtures/node/action_flow.golden.json`): the action is
/// done, but the new link of the event retires the used link first, so the
/// answer is 400 "Invalid or expired link.". The PR lists this defect.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn an_action_completes_the_task_and_answers_like_the_node_server(pool: PgPool) {
    let app = TestApp::new(pool);
    let owner = app.sign_in("sub-o", "o@example.com", "Owner").await;
    let (id, token) = task_with_link(&app, &owner).await;
    let reply = app
        .send(
            owner
                .request(Method::POST, &format!("/api/action/{token}"))
                .json(&json!({"action": "complete"}))
                .build(),
        )
        .await;
    assert_eq!(reply.problem(StatusCode::BAD_REQUEST), "invalid_link");
    assert_eq!(reply.json()["detail"], "Invalid or expired link.");
    assert_eq!(
        app.calendar.event("primary", &id).unwrap().completion(),
        Some(true)
    );
    // The event has a new link; the old one is used.
    assert_eq!(unused_tokens(&app).await, 1);
    let description = app
        .calendar
        .event("primary", &id)
        .unwrap()
        .description
        .unwrap();
    assert!(!description.contains(&token));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_html_form_gets_the_error_page_of_the_node_server(pool: PgPool) {
    let app = TestApp::new(pool);
    let owner = app.sign_in("sub-o", "o@example.com", "Owner").await;
    let (_, token) = task_with_link(&app, &owner).await;
    let csrf = owner.csrf.clone().unwrap();
    // A form post sends the CSRF token as a field, not as a header.
    let reply = app
        .send(
            owner
                .request(Method::POST, &format!("/api/action/{token}"))
                .without_header("x-csrf-token")
                .form(&[("csrfToken", &csrf), ("action", "reschedule")])
                .accept_html()
                .build(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let page = reply.text();
    assert!(page.contains("<title>Error</title>"));
    assert!(page.contains("<p>Invalid or expired link.</p>"));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn an_action_succeeds_when_the_new_link_is_not_written(pool: PgPool) {
    let app = TestApp::new(pool);
    let owner = app.sign_in("sub-o", "o@example.com", "Owner").await;
    let (id, token) = task_with_link(&app, &owner).await;
    app.calendar.fail_description_patches(true);
    app.clock.set(ts("2026-03-02T09:05:00Z"));
    let reply = app
        .send(
            owner
                .request(Method::POST, &format!("/api/action/{token}"))
                .json(&json!({"action": "complete"}))
                .build(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json(), json!({"success": true}));
    assert_eq!(
        app.calendar.event("primary", &id).unwrap().completion(),
        Some(true)
    );
    // The link is used up: a second post fails.
    let again = app
        .send(
            owner
                .request(Method::POST, &format!("/api/action/{token}"))
                .json(&json!({"action": "complete"}))
                .build(),
        )
        .await;
    assert_eq!(again.problem(StatusCode::BAD_REQUEST), "invalid_link");

    let html_success = {
        let (_, second) = {
            app.calendar.fail_description_patches(false);
            task_with_link(&app, &owner).await
        };
        app.calendar.fail_description_patches(true);
        app.send(
            owner
                .request(Method::POST, &format!("/api/action/{second}"))
                .json(&json!({"action": "reschedule"}))
                .accept_html()
                .build(),
        )
        .await
    };
    assert_eq!(html_success.status, StatusCode::OK);
    assert!(html_success.text().contains("<h1>Task rescheduled</h1>"));
    assert!(
        html_success
            .text()
            .contains("<p>Water &lt;plants&gt; has been updated.</p>")
    );
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn action_requests_keep_the_node_failures(pool: PgPool) {
    let app = TestApp::new(pool);
    let owner = app.sign_in("sub-o", "o@example.com", "Owner").await;
    let (_, token) = task_with_link(&app, &owner).await;
    let path = format!("/api/action/{token}");

    let invalid = app
        .send(
            owner
                .request(Method::POST, &path)
                .json(&json!({"action": "delete"}))
                .build(),
        )
        .await;
    assert_eq!(invalid.problem(StatusCode::BAD_REQUEST), "invalid_action");
    assert_eq!(invalid.json()["detail"], "Invalid action.");
    let invalid_html = app
        .send(
            owner
                .request(Method::POST, &path)
                .json(&json!({}))
                .accept_html()
                .build(),
        )
        .await;
    assert_eq!(invalid_html.status, StatusCode::BAD_REQUEST);
    assert!(invalid_html.text().contains("<p>Invalid action.</p>"));

    let other = app.sign_in("sub-other", "x@example.com", "Other").await;
    let forbidden = app
        .send(
            other
                .request(Method::POST, &path)
                .json(&json!({"action": "complete"}))
                .build(),
        )
        .await;
    assert_eq!(forbidden.problem(StatusCode::FORBIDDEN), "forbidden");
    assert_eq!(forbidden.json()["detail"], "Unauthorized.");

    let unknown = app
        .send(
            owner
                .request(Method::POST, "/api/action/unknown")
                .json(&json!({"action": "complete"}))
                .build(),
        )
        .await;
    assert_eq!(unknown.problem(StatusCode::BAD_REQUEST), "invalid_link");

    let signed_out = app
        .send(
            request(Method::POST, &path)
                .json(&json!({"action": "complete"}))
                .build(),
        )
        .await;
    // CSRF runs before the sign-in check, like the Node middleware order.
    assert_eq!(signed_out.problem(StatusCode::FORBIDDEN), "csrf_rejected");

    sqlx::query("DELETE FROM user_settings")
        .execute(&app.pool)
        .await
        .unwrap();
    let no_settings = app
        .send(
            owner
                .request(Method::POST, &path)
                .json(&json!({"action": "complete"}))
                .build(),
        )
        .await;
    assert_eq!(no_settings.problem(StatusCode::BAD_REQUEST), "no_settings");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn an_expired_link_is_invalid(pool: PgPool) {
    let app = TestApp::new(pool);
    let owner = app.sign_in("sub-o", "o@example.com", "Owner").await;
    let (_, token) = task_with_link(&app, &owner).await;
    app.clock.set(ts("2026-03-09T09:00:01Z"));
    let page = app
        .send(
            owner
                .request(Method::GET, &format!("/action/{token}"))
                .build(),
        )
        .await;
    assert_eq!(page.status, StatusCode::BAD_REQUEST);
    let post = app
        .send(
            owner
                .request(Method::POST, &format!("/api/action/{token}"))
                .json(&json!({"action": "complete"}))
                .build(),
        )
        .await;
    assert_eq!(post.problem(StatusCode::BAD_REQUEST), "invalid_link");
}
