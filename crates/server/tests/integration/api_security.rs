//! CSRF, body limits, rate limits, security headers, routing fallbacks, and
//! the operational routes (`csrf.test.ts`, `app.integration.test.ts`).

use axum::http::header::CONTENT_TYPE;
use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;

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
