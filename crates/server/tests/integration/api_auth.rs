//! Sign-in, sessions, sign-out, settings, and account deletion through the
//! router (`authRoutes.test.ts`, `auth-session.integration.test.ts`).

use axum::http::header::{LOCATION, SET_COOKIE};
use axum::http::{Method, StatusCode};
use caltodo::application::ports::GoogleError;
use serde_json::json;
use sqlx::PgPool;

use crate::support::{CALLBACK, Client, TestApp, request};

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_sign_in_redirects_to_google_with_the_session_cookie(pool: PgPool) {
    let app = TestApp::new(pool);
    let reply = app
        .send(request(Method::GET, "/api/auth/google").build())
        .await;
    assert_eq!(reply.status, StatusCode::FOUND);
    assert!(
        reply
            .header(LOCATION.as_str())
            .unwrap()
            .starts_with(CALLBACK)
    );
    let cookie = reply.header(SET_COOKIE.as_str()).unwrap();
    assert!(cookie.starts_with("caltodo.sid="), "{cookie}");
    for attribute in ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"] {
        assert!(cookie.contains(attribute), "{cookie}");
    }
    assert!(!cookie.contains("Secure"), "{cookie}");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_signed_in_user_reads_the_profile_and_a_csrf_token(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("google-sub-1", "ann@example.com", "Ann").await;
    assert_eq!(client.last_location.as_deref(), Some("/"));
    let reply = app
        .send(client.request(Method::GET, "/api/auth/user").build())
        .await;
    let user = reply.json();
    assert_eq!(user["googleId"], "google-sub-1");
    assert_eq!(user["email"], "ann@example.com");
    assert_eq!(user["displayName"], "Ann");
    let csrf = user["csrfToken"].as_str().unwrap();
    assert_eq!(csrf.len(), 64);
    assert_eq!(
        user.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["csrfToken", "displayName", "email", "googleId", "id"]
    );
    // The token stays the same within the session.
    let again = app
        .send(client.request(Method::GET, "/api/auth/user").build())
        .await;
    assert_eq!(again.json()["csrfToken"], csrf);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn without_a_session_the_user_route_is_401(pool: PgPool) {
    let app = TestApp::new(pool);
    let reply = app
        .send(request(Method::GET, "/api/auth/user").build())
        .await;
    assert_eq!(reply.problem(StatusCode::UNAUTHORIZED), "unauthenticated");
    // Issue #5 item 8: the Node texts. `authRoutes.ts` answered this route
    // with "Not authenticated"; `requireAuth` answered "Unauthorized".
    assert_eq!(reply.json()["detail"], "Not authenticated");
    for path in ["/api/tasks", "/api/settings", "/api/calendars"] {
        let reply = app.send(request(Method::GET, path).build()).await;
        assert_eq!(
            reply.problem(StatusCode::UNAUTHORIZED),
            "unauthenticated",
            "{path}"
        );
        assert_eq!(reply.json()["detail"], "Unauthorized", "{path}");
    }
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_sign_in_gives_a_new_session_id(pool: PgPool) {
    let app = TestApp::new(pool);
    app.oauth.code_for(
        "code-fix",
        caltodo::application::ports::GoogleProfile {
            sub: "sub-fix".to_owned(),
            email: Some("f@example.com".to_owned()),
            name: Some("F".to_owned()),
        },
    );
    // The session of the sign-in start, which an attacker could plant.
    let start = app
        .send(request(Method::GET, "/api/auth/google").build())
        .await;
    let mut client = Client::default();
    client.absorb(&start);
    let planted = client.clone();
    let location = start.header(LOCATION.as_str()).unwrap();
    let state = location.split("state=").nth(1).unwrap().to_owned();
    let callback = app
        .send(
            client
                .request(
                    Method::GET,
                    &format!("{CALLBACK}?code=code-fix&state={state}"),
                )
                .build(),
        )
        .await;
    assert_eq!(callback.status, StatusCode::FOUND);
    client.absorb(&callback);
    assert_ne!(
        client.cookie, planted.cookie,
        "the sign-in sets a new cookie"
    );

    let signed_in = app
        .send(client.request(Method::GET, "/api/auth/user").build())
        .await;
    assert_eq!(signed_in.status, StatusCode::OK);
    // The session id of the start is gone: its cookie is no sign-in, and the
    // store holds only the new session.
    let reply = app
        .send(planted.request(Method::GET, "/api/auth/user").build())
        .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM app_sessions")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 1);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_wrong_state_or_a_denial_goes_back_home(pool: PgPool) {
    let app = TestApp::new(pool);
    let start = app
        .send(request(Method::GET, "/api/auth/google").build())
        .await;
    let mut client = Client::default();
    client.absorb(&start);
    for query in ["?code=x&state=wrong", "?error=access_denied", "?state=only"] {
        let reply = app
            .send(
                client
                    .request(Method::GET, &format!("{CALLBACK}{query}"))
                    .build(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::FOUND, "{query}");
        assert_eq!(reply.header(LOCATION.as_str()), Some("/"), "{query}");
    }
    let reply = app
        .send(
            client
                .request(Method::GET, &format!("{CALLBACK}?error=server_error"))
                .build(),
        )
        .await;
    assert_eq!(reply.problem(StatusCode::BAD_GATEWAY), "sign_in_failed");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_pending_action_token_survives_the_sign_in(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app
        .sign_in_with("sub-2", "b@example.com", "Bob", Some("tok%2Fen"))
        .await;
    assert_eq!(client.last_location.as_deref(), Some("/action/tok%2Fen"));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn sign_out_deletes_the_session(pool: PgPool) {
    let app = TestApp::new(pool);
    let mut client = app.sign_in("sub-3", "c@example.com", "Cy").await;
    let reply = app
        .send(client.request(Method::POST, "/api/auth/logout").build())
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({"success": true}));
    let old = client.clone();
    client.absorb(&reply);
    assert_eq!(client.cookie, None, "the response removes the cookie");
    let after = app
        .send(old.request(Method::GET, "/api/auth/user").build())
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
    let sessions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM app_sessions WHERE user_id IS NOT NULL")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(sessions, 0);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn sessions_of_two_users_stay_apart(pool: PgPool) {
    let app = TestApp::new(pool);
    let ann = app.sign_in("sub-a", "a@example.com", "Ann").await;
    let bob = app.sign_in("sub-b", "b@example.com", "Bob").await;
    let ann_user = app
        .send(ann.request(Method::GET, "/api/auth/user").build())
        .await;
    let bob_user = app
        .send(bob.request(Method::GET, "/api/auth/user").build())
        .await;
    assert_eq!(ann_user.json()["displayName"], "Ann");
    assert_eq!(bob_user.json()["displayName"], "Bob");
    assert_ne!(ann_user.json()["csrfToken"], bob_user.json()["csrfToken"]);
    // Ann's CSRF token does not work in Bob's session.
    let mut mixed = bob.clone();
    mixed.csrf = ann.csrf.clone();
    let reply = app
        .send(mixed.request(Method::POST, "/api/auth/logout").build())
        .await;
    assert_eq!(reply.problem(StatusCode::FORBIDDEN), "csrf_rejected");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn settings_read_save_and_validate(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-s", "s@example.com", "S").await;
    let defaults = app
        .send(client.request(Method::GET, "/api/settings").build())
        .await;
    let body = defaults.json();
    assert_eq!(body["calendarId"], serde_json::Value::Null);
    assert_eq!(body["workStartHour"], 9);
    assert_eq!(body["timezone"], "America/New_York");
    assert_eq!(body["userId"], client.user_id.clone().unwrap());

    app.configure_calendar(&client, "Europe/Helsinki").await;
    let saved = app
        .send(client.request(Method::GET, "/api/settings").build())
        .await;
    assert_eq!(saved.json()["calendarId"], "primary");
    assert_eq!(saved.json()["eventColor"], "2");

    let invalid = app
        .send(
            client
                .request(Method::PATCH, "/api/settings")
                .json(
                    &json!({"workStartHour": 25, "workEndHour": 17, "timezone": "UTC",
                              "defaultDuration": 60, "eventColor": "1"}),
                )
                .build(),
        )
        .await;
    assert_eq!(invalid.problem(StatusCode::BAD_REQUEST), "invalid_settings");
    assert_eq!(invalid.json()["detail"], "Invalid settings data");

    // A user without settings reads null.
    sqlx::query("DELETE FROM user_settings")
        .execute(&app.pool)
        .await
        .unwrap();
    let none = app
        .send(client.request(Method::GET, "/api/settings").build())
        .await;
    assert_eq!(none.status, StatusCode::OK);
    assert_eq!(none.json(), serde_json::Value::Null);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn calendars_list_and_fail_explicitly(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-c", "c@example.com", "C").await;
    app.calendars(&[
        ("primary", "Main", true),
        ("work@group.calendar.google.com", "Work", false),
    ]);
    let reply = app
        .send(client.request(Method::GET, "/api/calendars").build())
        .await;
    assert_eq!(
        reply.json(),
        json!([
            {"id": "primary", "summary": "Main", "primary": true},
            {"id": "work@group.calendar.google.com", "summary": "Work", "primary": false}
        ])
    );
    // P3: the Node server answered an empty list on a Google failure.
    app.calendar.fail_calendars(Some(GoogleError::Status(503)));
    let failed = app
        .send(client.request(Method::GET, "/api/calendars").build())
        .await;
    assert_eq!(
        failed.problem(StatusCode::BAD_GATEWAY),
        "google_unavailable"
    );
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn account_deletion_removes_data_and_signs_out(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-d", "d@example.com", "D").await;
    let reply = app
        .send(client.request(Method::DELETE, "/api/account").build())
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({"success": true}));
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(users, 0);
    let sessions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM app_sessions WHERE user_id IS NOT NULL")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(sessions, 0);
    let after = app
        .send(client.request(Method::GET, "/api/auth/user").build())
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn an_expired_google_grant_refreshes_and_stores_the_new_token(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-r", "r@example.com", "R").await;
    app.calendars(&[("primary", "Main", true)]);
    // The access token of the sign-in no longer works; the refresh token does.
    let next = app.oauth.next_access_token();
    app.calendar.accept_tokens(&[&next]);
    let reply = app
        .send(client.request(Method::GET, "/api/calendars").build())
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(app.oauth.refresh_calls(), 1);
    let stored = app
        .services
        .store
        .user(&caltodo::domain::ids::UserId::new(client.user_id.clone().unwrap()).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        stored
            .access_token
            .as_ref()
            .map(caltodo::config::Secret::expose),
        Some(next.as_str())
    );
    // The stored token works now without another refresh.
    let again = app
        .send(client.request(Method::GET, "/api/calendars").build())
        .await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(app.oauth.refresh_calls(), 1);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_refused_refresh_token_asks_for_a_new_sign_in(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-x", "x@example.com", "X").await;
    app.calendar.accept_tokens(&["nothing-works"]);
    sqlx::query("UPDATE users SET refresh_token = 'revoked-plaintext'")
        .execute(&app.pool)
        .await
        .unwrap();
    let reply = app
        .send(client.request(Method::GET, "/api/calendars").build())
        .await;
    assert_eq!(
        reply.problem(StatusCode::BAD_GATEWAY),
        "google_reauthorization_required"
    );
}
