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

/// A temporary client build with one bundle, `index.html`, and a favicon.
fn client_build() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("caltodo-web-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>Todo</title>").unwrap();
    std::fs::write(dir.join("assets/index-abc.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("favicon.png"), [0_u8, 1, 2]).unwrap();
    dir
}

/// tower-http 0.7 (`ServeDir`, `ServeFile`) sends a strong `ETag` and answers
/// `If-None-Match`. tower-http 0.6 sent no `ETag`.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_sends_a_strong_etag(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));
    let get = |path: &str| request(Method::GET, path);

    // A matching If-None-Match is 304 with the same validator.
    let asset = app.send(get("/assets/index-abc.js").build()).await;
    assert_eq!(asset.status, StatusCode::OK);
    let etag = asset.header("etag").expect("an ETag").to_owned();
    assert!(etag.starts_with('"'), "a strong ETag: {etag}");
    assert!(asset.header("last-modified").is_some());
    let revalidated = app
        .send(
            get("/assets/index-abc.js")
                .header("if-none-match", &etag)
                .build(),
        )
        .await;
    assert_eq!(revalidated.status, StatusCode::NOT_MODIFIED);
    assert_eq!(revalidated.header("etag"), Some(etag.as_str()));

    // index.html keeps `no-cache`, so a browser revalidates it with the ETag.
    let index = app
        .send(get("/").header("accept", "text/html").build())
        .await;
    let index_etag = index.header("etag").expect("an ETag").to_owned();
    let index_again = app
        .send(
            get("/")
                .header("accept", "text/html")
                .header("if-none-match", &index_etag)
                .build(),
        )
        .await;
    assert_eq!(index_again.status, StatusCode::NOT_MODIFIED);
    assert_eq!(index_again.header("cache-control"), Some("no-cache"));
    std::fs::remove_dir_all(dir).ok();
}

/// tower-http 0.7 answers a stale `If-Match` with 412 and sends no file, on a
/// bundle and on `index.html`. tower-http 0.6 ignored `If-Match` and sent 200.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_refuses_a_stale_if_match(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));
    let stale = |path: &str| {
        request(Method::GET, path)
            .header("accept", "text/html")
            .header("if-match", "\"stale\"")
            .build()
    };

    let asset = app.send(stale("/assets/index-abc.js")).await;
    assert_eq!(asset.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(asset.text(), "");
    let index = app.send(stale("/")).await;
    assert_eq!(index.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(index.text(), "");
    std::fs::remove_dir_all(dir).ok();
}

/// tower-http 0.7 does not serve a file for a path with a trailing slash.
/// tower-http 0.6 served the file.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_has_no_file_for_a_path_with_a_trailing_slash(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));

    let asset = app
        .send(request(Method::GET, "/assets/index-abc.js/").build())
        .await;
    assert_eq!(asset.status, StatusCode::NOT_FOUND);
    let file = app
        .send(request(Method::GET, "/favicon.png/").build())
        .await;
    assert_eq!(file.status, StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(dir).ok();
}

/// One byte range is served; a multipart range request is 416.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_serves_one_byte_range(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));
    let ranged = |range: &str| {
        request(Method::GET, "/assets/index-abc.js")
            .header("range", range)
            .build()
    };

    let one_range = app.send(ranged("bytes=0-6")).await;
    assert_eq!(one_range.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(one_range.text(), "console");
    let two_ranges = app.send(ranged("bytes=0-1,4-5")).await;
    assert_eq!(two_ranges.status, StatusCode::RANGE_NOT_SATISFIABLE);
    std::fs::remove_dir_all(dir).ok();
}

/// tower-http 0.7 evaluates `If-None-Match` before `If-Modified-Since` (RFC
/// 9110, section 13.2.2): a wrong `If-None-Match` sends the file even when
/// `If-Modified-Since` is current. tower-http 0.6 answered 304.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_prefers_if_none_match_to_if_modified_since(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));

    let asset = app
        .send(request(Method::GET, "/assets/index-abc.js").build())
        .await;
    let last_modified = asset
        .header("last-modified")
        .expect("Last-Modified")
        .to_owned();
    let answer = app
        .send(
            request(Method::GET, "/assets/index-abc.js")
                .header("if-none-match", "\"wrong\"")
                .header("if-modified-since", &last_modified)
                .build(),
        )
        .await;
    assert_eq!(answer.status, StatusCode::OK);
    assert_eq!(answer.text(), "console.log(1)");
    std::fs::remove_dir_all(dir).ok();
}

/// tower-http 0.7 sends `Last-Modified` on a 304 answer to
/// `If-Modified-Since`. tower-http 0.6 sent no validator on the 304.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_sends_last_modified_on_a_304(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));

    let asset = app
        .send(request(Method::GET, "/assets/index-abc.js").build())
        .await;
    let last_modified = asset
        .header("last-modified")
        .expect("Last-Modified")
        .to_owned();
    let answer = app
        .send(
            request(Method::GET, "/assets/index-abc.js")
                .header("if-modified-since", &last_modified)
                .build(),
        )
        .await;
    assert_eq!(answer.status, StatusCode::NOT_MODIFIED);
    assert_eq!(answer.header("last-modified"), Some(last_modified.as_str()));
    std::fs::remove_dir_all(dir).ok();
}

/// tower-http 0.7 sends no `Content-Type` on a 416 answer. tower-http 0.6
/// sent the content type of the file.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_sends_no_content_type_on_a_416(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));

    let answer = app
        .send(
            request(Method::GET, "/assets/index-abc.js")
                .header("range", "bytes=100-200")
                .build(),
        )
        .await;
    assert_eq!(answer.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(answer.header("content-type"), None);
    std::fs::remove_dir_all(dir).ok();
}

/// tower-http 0.7 keeps the whole file name with `Accept-Encoding: identity`.
/// tower-http 0.6 stripped the last extension, so `index-abc.js.map` served
/// `index-abc.js` and `index.html.bak` served `index.html`.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_client_build_keeps_the_extension_with_identity_encoding(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));
    let identity = |path: &str| {
        request(Method::GET, path)
            .header("accept-encoding", "identity")
            .build()
    };

    let map = app.send(identity("/assets/index-abc.js.map")).await;
    assert_eq!(map.status, StatusCode::NOT_FOUND);
    let backup = app.send(identity("/index.html.bak")).await;
    assert_eq!(backup.status, StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(dir).ok();
}

/// A file path with a trailing slash is a deep link for an HTML request: it
/// gets `index.html`. tower-http 0.6 served the file. Under `/assets` the
/// answer stays 404.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_file_path_with_a_trailing_slash_is_a_deep_link(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));
    let html = |path: &str| {
        request(Method::GET, path)
            .header("accept", "text/html")
            .build()
    };

    let file = app.send(html("/favicon.png/")).await;
    assert_eq!(file.status, StatusCode::OK);
    assert!(file.text().contains("<title>Todo</title>"));
    assert_eq!(file.header("cache-control"), Some("no-cache"));
    let asset = app.send(html("/assets/index-abc.js/")).await;
    assert_eq!(asset.status, StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(dir).ok();
}

/// The deep-link fallback copies the request headers to the `index.html`
/// lookup, so a stale `If-Match` on a deep link is 412 with no body.
/// tower-http 0.6 ignored `If-Match` and sent `index.html`.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_deep_link_refuses_a_stale_if_match(pool: PgPool) {
    let dir = client_build();
    let app = TestApp::with(pool, &settings("UTC"), Some(&dir));

    let answer = app
        .send(
            request(Method::GET, "/settings")
                .header("accept", "text/html")
                .header("if-match", "\"stale\"")
                .build(),
        )
        .await;
    assert_eq!(answer.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(answer.text(), "");
    std::fs::remove_dir_all(dir).ok();
}
