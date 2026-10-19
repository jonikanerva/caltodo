//! CSRF, body limits, rate limits, security headers, routing fallbacks, and
//! the operational routes (`csrf.test.ts`, `app.integration.test.ts`).

use axum::http::header::CONTENT_TYPE;
use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt as _;

use crate::support::{TestApp, request, settings};

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn unsafe_methods_need_the_session_csrf_token(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-c", "c@example.com", "C").await;
    let without = app
        .send(
            client
                .request(Method::POST, "/api/auth/logout")
                .without_header("x-csrf-token")
                .build(),
        )
        .await;
    assert_eq!(without.problem(StatusCode::FORBIDDEN), "csrf_rejected");
    assert_eq!(without.json()["detail"], "Invalid CSRF token");
    let wrong = app
        .send(
            client
                .request(Method::POST, "/api/auth/logout")
                .header("x-csrf-token", "wrong")
                .build(),
        )
        .await;
    assert_eq!(wrong.problem(StatusCode::FORBIDDEN), "csrf_rejected");
    // The JSON body field works without the header.
    let body = app
        .send(
            client
                .request(Method::POST, "/api/tasks/reload")
                .without_header("x-csrf-token")
                .json(&json!({"csrfToken": client.csrf.clone().unwrap()}))
                .build(),
        )
        .await;
    assert_eq!(body.problem(StatusCode::BAD_REQUEST), "no_calendar");
    // Without a session no token can match; an unknown API path too.
    let anonymous = app
        .send(
            request(Method::POST, "/api/unknown")
                .header("x-csrf-token", "x")
                .build(),
        )
        .await;
    assert_eq!(anonymous.problem(StatusCode::FORBIDDEN), "csrf_rejected");
    // Safe methods need no token.
    let get = app
        .send(client.request(Method::GET, "/api/settings").build())
        .await;
    assert_eq!(get.status, StatusCode::OK);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn bodies_have_limits_and_must_parse(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-b", "b@example.com", "B").await;
    let big_json = format!(r#"{{"title":"{}"}}"#, "a".repeat(100 * 1024));
    let too_big = app
        .send(
            client
                .request(Method::POST, "/api/tasks")
                .raw(
                    CONTENT_TYPE.as_str(),
                    "application/json",
                    big_json.into_bytes(),
                )
                .build(),
        )
        .await;
    assert_eq!(
        too_big.problem(StatusCode::PAYLOAD_TOO_LARGE),
        "payload_too_large"
    );
    let csrf = client.csrf.clone().unwrap();
    let big_form = app
        .send(
            client
                .request(Method::POST, "/api/action/x")
                .form(&[("csrfToken", &csrf), ("action", &"c".repeat(51 * 1024))])
                .build(),
        )
        .await;
    assert_eq!(
        big_form.problem(StatusCode::PAYLOAD_TOO_LARGE),
        "payload_too_large"
    );
    let broken = app
        .send(
            client
                .request(Method::POST, "/api/tasks")
                .raw(
                    CONTENT_TYPE.as_str(),
                    "application/json",
                    b"{broken".to_vec(),
                )
                .build(),
        )
        .await;
    assert_eq!(broken.problem(StatusCode::BAD_REQUEST), "invalid_request");
    // A body of another media type is no body (`express.json` skipped it).
    let text = app
        .send(
            client
                .request(Method::POST, "/api/tasks")
                .raw(
                    CONTENT_TYPE.as_str(),
                    "text/plain",
                    br#"{"title":"T"}"#.to_vec(),
                )
                .build(),
        )
        .await;
    assert_eq!(text.problem(StatusCode::BAD_REQUEST), "invalid_request");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn rate_limits_count_per_client_address(pool: PgPool) {
    let app = TestApp::new(pool);
    for _ in 0..25 {
        let reply = app
            .send(
                request(Method::GET, "/api/auth/google")
                    .header("x-forwarded-for", "1.1.1.1, 9.9.9.9")
                    .build(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::FOUND);
    }
    let limited = app
        .send(
            request(Method::GET, "/api/auth/google")
                .header("x-forwarded-for", "8.8.8.8, 9.9.9.9")
                .build(),
        )
        .await;
    assert_eq!(
        limited.problem(StatusCode::TOO_MANY_REQUESTS),
        "rate_limited"
    );
    assert_eq!(limited.header("ratelimit-limit"), Some("25"));
    assert_eq!(limited.header("ratelimit-policy"), Some("25;w=900"));
    assert!(limited.header("retry-after").is_some());
    // Another client is not limited.
    let other = app
        .send(
            request(Method::GET, "/api/auth/google")
                .header("x-forwarded-for", "9.9.9.8")
                .build(),
        )
        .await;
    assert_eq!(other.status, StatusCode::FOUND);
    // The action pages share a limit of 40 and answer text.
    for _ in 0..40 {
        app.send(
            request(Method::GET, "/action/x")
                .header("x-forwarded-for", "7.7.7.7")
                .build(),
        )
        .await;
    }
    let page = app
        .send(
            request(Method::GET, "/action/x")
                .header("x-forwarded-for", "7.7.7.7")
                .build(),
        )
        .await;
    assert_eq!(page.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(page.text(), "Too many requests, please try again later.");
    let api = app
        .send(
            request(Method::GET, "/api/healthz-nope")
                .header("x-forwarded-for", "7.7.7.7")
                .build(),
        )
        .await;
    assert_eq!(
        api.status,
        StatusCode::NOT_FOUND,
        "the API limit is separate"
    );
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_api_limit_is_120_per_minute(pool: PgPool) {
    let app = TestApp::new(pool);
    for _ in 0..120 {
        let reply = app
            .send(
                request(Method::GET, "/api/auth/user")
                    .header("x-forwarded-for", "5.5.5.5")
                    .build(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }
    let limited = app
        .send(
            request(Method::GET, "/api/auth/user")
                .header("x-forwarded-for", "5.5.5.5")
                .build(),
        )
        .await;
    assert_eq!(
        limited.problem(StatusCode::TOO_MANY_REQUESTS),
        "rate_limited"
    );
    let health = app
        .send(
            request(Method::GET, "/healthz")
                .header("x-forwarded-for", "5.5.5.5")
                .build(),
        )
        .await;
    assert_eq!(
        health.status,
        StatusCode::OK,
        "operational routes have no limit"
    );
}

/// The number of rows in `app_sessions`.
async fn session_rows(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM app_sessions")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Uses up the `/api` limit (120 per minute) of one client address.
async fn exhaust_the_api_limit(app: &TestApp, address: &str) {
    for _ in 0..120 {
        let reply = app
            .send(
                request(Method::GET, "/api/auth/user")
                    .header("x-forwarded-for", address)
                    .build(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }
}

/// A JSON POST to `/api/tasks` with a body that never ends. A middleware
/// that reads the body never answers it.
fn endless_post(address: &str) -> axum::http::Request<axum::body::Body> {
    let body = axum::body::Body::from_stream(futures_util::stream::pending::<
        Result<axum::body::Bytes, std::io::Error>,
    >());
    axum::http::Request::builder()
        .method(Method::POST)
        .uri("/api/tasks")
        .header("x-forwarded-for", address)
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .unwrap()
}

/// Issue #5 item 9: the rate limit runs before the session layer and before
/// the body read, the body parse, and the CSRF check. A limited client gets
/// 429 for a body over the limit, a body that does not parse, a body that
/// never ends, and a request without a CSRF token. The same request from
/// another address shows the answer without the limit (the control).
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_rate_limit_runs_before_the_session_and_the_body(pool: PgPool) {
    let app = TestApp::new(pool.clone());
    let client = app.sign_in("sub-o", "o@example.com", "O").await;
    exhaust_the_api_limit(&app, "6.6.6.6").await;
    let rows = session_rows(&pool).await;

    let big_json = format!(r#"{{"title":"{}"}}"#, "a".repeat(100 * 1024)).into_bytes();
    let cases = [
        (
            "a body over the limit",
            big_json,
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "a body that does not parse",
            b"{broken".to_vec(),
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (case, body, unlimited) in cases {
        let post = |address: &str| {
            client
                .request(Method::POST, "/api/tasks")
                .header("x-forwarded-for", address)
                .raw(CONTENT_TYPE.as_str(), "application/json", body.clone())
                .build()
        };
        let control = app.send(post("6.6.6.7")).await;
        assert_eq!(control.status, unlimited, "control: {case}");
        let limited = app.send(post("6.6.6.6")).await;
        assert_eq!(
            limited.problem(StatusCode::TOO_MANY_REQUESTS),
            "rate_limited",
            "{case}"
        );
        assert_eq!(limited.header("set-cookie"), None, "{case}");
    }

    let without_csrf = |address: &str| {
        client
            .request(Method::POST, "/api/auth/logout")
            .header("x-forwarded-for", address)
            .without_header("x-csrf-token")
            .build()
    };
    let control = app.send(without_csrf("6.6.6.7")).await;
    assert_eq!(control.problem(StatusCode::FORBIDDEN), "csrf_rejected");
    let limited = app.send(without_csrf("6.6.6.6")).await;
    assert_eq!(
        limited.problem(StatusCode::TOO_MANY_REQUESTS),
        "rate_limited"
    );

    // A body that never ends: the limited request answers at once, and the
    // same request without the limit waits for the body.
    let limited = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        app.router.clone().oneshot(endless_post("6.6.6.6")),
    )
    .await
    .expect("the limited request answers without the body")
    .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let control = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        app.router.clone().oneshot(endless_post("6.6.6.8")),
    )
    .await;
    assert!(control.is_err(), "without the limit the body is read");

    // A sign-in start writes a session row; a limited start does not.
    assert_eq!(
        session_rows(&pool).await,
        rows,
        "the limited requests wrote no session"
    );
    let start = |address: &str| {
        request(Method::GET, "/api/auth/google")
            .header("x-forwarded-for", address)
            .build()
    };
    let control = app.send(start("6.6.6.9")).await;
    assert_eq!(control.status, StatusCode::FOUND);
    assert_eq!(session_rows(&pool).await, rows + 1);
    let limited = app.send(start("6.6.6.6")).await;
    assert_eq!(
        limited.problem(StatusCode::TOO_MANY_REQUESTS),
        "rate_limited"
    );
    assert_eq!(limited.header("set-cookie"), None);
    assert_eq!(session_rows(&pool).await, rows + 1);
}

/// Issue #5 item 9: each request to a sign-in route counts exactly once in
/// the sign-in limit (25 per 15 minutes, `STACK.md` §15). The Node server
/// mounted the same limiter twice on the callback path, so there the
/// callback counted twice.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn each_sign_in_request_counts_once(pool: PgPool) {
    let app = TestApp::new(pool);
    let send = |path: &str| {
        app.send(
            request(Method::GET, path)
                .header("x-forwarded-for", "4.4.4.4")
                .build(),
        )
    };
    // The start and the callback share one counter: 13 starts and 12
    // callbacks use the 25 requests.
    for n in 0..25_u32 {
        let path = if n % 2 == 0 {
            "/api/auth/google"
        } else {
            "/api/auth/google/callback"
        };
        let reply = send(path).await;
        assert_eq!(reply.status, StatusCode::FOUND, "request {n} to {path}");
        assert_eq!(reply.header("ratelimit-limit"), Some("25"));
        let remaining = (24 - n).to_string();
        assert_eq!(
            reply.header("ratelimit-remaining"),
            Some(remaining.as_str()),
            "request {n} to {path}"
        );
    }
    for path in ["/api/auth/google/callback", "/api/auth/google"] {
        let limited = send(path).await;
        assert_eq!(
            limited.problem(StatusCode::TOO_MANY_REQUESTS),
            "rate_limited",
            "{path}"
        );
        assert_eq!(limited.header("ratelimit-policy"), Some("25;w=900"));
    }
}

const HEADERS: [(&str, &str); 11] = [
    (
        "content-security-policy",
        "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:",
    ),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "same-origin"),
    ("origin-agent-cluster", "?1"),
    ("referrer-policy", "no-referrer"),
    ("x-content-type-options", "nosniff"),
    ("x-dns-prefetch-control", "off"),
    ("x-download-options", "noopen"),
    ("x-frame-options", "DENY"),
    ("x-permitted-cross-domain-policies", "none"),
    ("x-xss-protection", "0"),
];

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn every_answer_has_the_security_headers(pool: PgPool) {
    let app = TestApp::new(pool);
    for path in [
        "/healthz",
        "/api/unknown",
        "/action/x",
        "/",
        "/api/auth/user",
    ] {
        let reply = app.send(request(Method::GET, path).build()).await;
        for (name, value) in HEADERS {
            assert_eq!(reply.header(name), Some(value), "{path} {name}");
        }
        assert_eq!(reply.header("strict-transport-security"), None, "{path}");
        assert_eq!(reply.header("x-powered-by"), None, "{path}");
    }
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn production_adds_hsts_and_secure_cookies(pool: PgPool) {
    let mut production = settings("UTC");
    production.production = true;
    let app = TestApp::with(pool, &production, None);
    let reply = app
        .send(request(Method::GET, "/api/auth/google").build())
        .await;
    assert_eq!(
        reply.header("strict-transport-security"),
        Some("max-age=31536000; includeSubDomains")
    );
    assert!(reply.header("set-cookie").unwrap().contains("Secure"));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn unknown_api_paths_and_methods_are_problem_404(pool: PgPool) {
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-u", "u@example.com", "U").await;
    for (method, path) in [
        (Method::GET, "/api/unknown"),
        (Method::GET, "/api"),
        (Method::DELETE, "/api/tasks"),
        (Method::POST, "/api/tasks/t1"),
        (Method::POST, "/api/auth/google"),
    ] {
        let reply = app.send(client.request(method.clone(), path).build()).await;
        assert_eq!(
            reply.problem(StatusCode::NOT_FOUND),
            "not_found",
            "{method} {path}"
        );
    }
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_operational_routes_answer(pool: PgPool) {
    let app = TestApp::new(pool);
    let health = app.send(request(Method::GET, "/healthz").build()).await;
    assert_eq!(health.json(), json!({"ok": true}));
    let ready = app.send(request(Method::GET, "/readyz").build()).await;
    assert_eq!(ready.json(), json!({"ready": true}));
    let version = app.send(request(Method::GET, "/version").build()).await;
    assert_eq!(
        version.json(),
        json!({"version": env!("CARGO_PKG_VERSION"), "commit": "unknown"})
    );
    let post = app.send(request(Method::POST, "/healthz").build()).await;
    assert_eq!(
        post.status,
        StatusCode::FORBIDDEN,
        "CSRF runs before the method check"
    );
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn readiness_fails_without_the_database(pool: PgPool) {
    let app = TestApp::new(pool.clone());
    pool.close().await;
    let ready = app.send(request(Method::GET, "/readyz").build()).await;
    assert_eq!(ready.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(ready.json(), json!({"ready": false}));
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_serves_deep_links_but_not_api_paths(pool: PgPool) {
    let dir = std::env::temp_dir().join(format!("caltodo-web-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>Todo</title>").unwrap();
    std::fs::write(dir.join("assets/index-abc.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("favicon.png"), [0_u8, 1, 2]).unwrap();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));
    let html = |path: &str| {
        request(Method::GET, path)
            .header("accept", "text/html")
            .build()
    };

    let root = app.send(html("/")).await;
    assert_eq!(root.status, StatusCode::OK);
    assert_eq!(root.header("cache-control"), Some("no-cache"));
    assert_eq!(
        root.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    let deep = app.send(html("/settings")).await;
    assert_eq!(deep.status, StatusCode::OK);
    assert!(deep.text().contains("<title>Todo</title>"));
    let asset = app
        .send(request(Method::GET, "/assets/index-abc.js").build())
        .await;
    assert_eq!(asset.status, StatusCode::OK);
    assert_eq!(asset.header("cache-control"), None);
    let missing_asset = app.send(html("/assets/missing.js")).await;
    assert_eq!(missing_asset.status, StatusCode::NOT_FOUND);
    let favicon = app.send(request(Method::GET, "/favicon.png").build()).await;
    assert_eq!(favicon.status, StatusCode::OK);
    let api = app.send(html("/api/unknown")).await;
    assert_eq!(api.problem(StatusCode::NOT_FOUND), "not_found");
    std::fs::remove_dir_all(dir).ok();
}
