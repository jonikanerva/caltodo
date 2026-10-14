//! The HTTP interface: routes, middleware, sessions, the action pages, and
//! the built single-page client.
//!
//! The middleware order, from the outside in:
//!
//! 1. [`request_context`]: request id, log line, panic containment, and the
//!    security headers on every response;
//! 2. [`rate_limit::limit`];
//! 3. the session layer (`session.rs`);
//! 4. [`body::body_and_csrf`]: body limits, body parsing, and CSRF;
//! 5. the routes.

pub mod actions;
pub mod auth;
pub mod body;
pub mod dto;
pub mod errors;
pub mod html;
pub mod input;
pub mod openapi;
mod probes;
pub mod rate_limit;
pub mod session;
pub mod static_files;
pub mod tasks;

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use axum::Router;
use axum::extract::{MatchedPath, Request};
use axum::http::header::{
    CONTENT_SECURITY_POLICY, REFERRER_POLICY, STRICT_TRANSPORT_SECURITY, X_CONTENT_TYPE_OPTIONS,
    X_FRAME_OPTIONS,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::FutureExt;
use tracing::Instrument;

use crate::application::Services;
use crate::config::BuildInfo;
use rate_limit::RateLimits;
use session::SessionSettings;
use static_files::StaticSite;

/// The state of the handlers.
#[derive(Debug, Clone)]
pub struct AppState {
    pub services: Services,
    pub site: Arc<StaticSite>,
    pub build: Arc<BuildInfo>,
    pub limits: Arc<RateLimits>,
    pub sessions: SessionSettings,
    /// HSTS and the `Secure` cookie flag.
    pub production: bool,
}

/// All routes with the middleware.
pub fn app(state: AppState) -> Router {
    let (api, _document) = openapi::api_router();
    let session_layer = state.sessions.layer();
    let production = state.production;
    Router::new()
        .route("/healthz", get(probes::health).fallback(not_found))
        .route("/readyz", get(probes::readiness).fallback(not_found))
        .route("/version", get(probes::version).fallback(not_found))
        .route(
            "/api/auth/google",
            get(auth::google_start).fallback(api_method_not_found),
        )
        .route(
            "/api/auth/google/callback",
            get(auth::google_callback).fallback(api_method_not_found),
        )
        .route("/action/{token}", get(actions::show))
        .merge(api)
        .fallback(static_files::serve_fallback)
        .layer(middleware::from_fn(body::body_and_csrf))
        .layer(session_layer)
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state.limits),
            rate_limit::limit,
        ))
        .layer(middleware::from_fn(move |request: Request, next: Next| {
            request_context(production, request, next)
        }))
        .with_state(state)
}

/// Runs each request in a `request` span, writes one log line per request,
/// contains a panic in request handling as the `internal_error` problem
/// (500), and adds the security headers to every response.
///
/// The span carries a random request id, the route pattern, and the method.
/// The log never has the path, the query, a header, or a body: a token, an
/// event id, or a calendar id is private data.
async fn request_context(production: bool, request: Request, next: Next) -> Response {
    let started = tokio::time::Instant::now();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_owned(), |path| path.as_str().to_owned());
    let method = request.method().as_str().to_owned();
    let span = tracing::info_span!(
        "request",
        request_id = tracing::field::Empty,
        route = route.as_str(),
        method = method.as_str(),
    );

    // `Uuid::new_v4` panics when the operating system gives no random bytes,
    // so the id is made inside the panic containment. The panic payload is
    // dropped unread, because it can contain private data.
    let id_span = span.clone();
    let handled = async move {
        id_span.record(
            "request_id",
            tracing::field::display(uuid::Uuid::new_v4().hyphenated()),
        );
        next.run(request).await
    };
    async move {
        let mut response = match AssertUnwindSafe(handled).catch_unwind().await {
            Ok(response) => response,
            Err(_payload) => {
                tracing::error!("request handling panicked");
                errors::problem(errors::ProblemCode::InternalError)
            }
        };
        add_security_headers(response.headers_mut(), production);
        tracing::info!(
            status = u64::from(response.status().as_u16()),
            elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "request completed"
        );
        response
    }
    .instrument(span)
    .await
}

/// The Content-Security-Policy of the Node server in production. The action
/// pages have an inline `<style>`, so styles allow `'unsafe-inline'`.
pub const CONTENT_SECURITY_POLICY_VALUE: &str = "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:";

/// The HSTS value of helmet 8.
pub const HSTS_VALUE: &str = "max-age=31536000; includeSubDomains";

/// The headers of helmet 8 with the settings of the Node server: its CSP,
/// `X-Frame-Options: DENY`, and HSTS only in production. Express also sent
/// no `X-Powered-By`.
fn add_security_headers(headers: &mut HeaderMap, production: bool) {
    let fixed: [(HeaderName, &'static str); 10] = [
        (CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY_VALUE),
        (
            HeaderName::from_static("cross-origin-opener-policy"),
            "same-origin",
        ),
        (
            HeaderName::from_static("cross-origin-resource-policy"),
            "same-origin",
        ),
        (HeaderName::from_static("origin-agent-cluster"), "?1"),
        (REFERRER_POLICY, "no-referrer"),
        (X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (HeaderName::from_static("x-dns-prefetch-control"), "off"),
        (HeaderName::from_static("x-download-options"), "noopen"),
        (X_FRAME_OPTIONS, "DENY"),
        (
            HeaderName::from_static("x-permitted-cross-domain-policies"),
            "none",
        ),
    ];
    for (name, value) in fixed {
        headers.insert(name, HeaderValue::from_static(value));
    }
    headers.insert(
        HeaderName::from_static("x-xss-protection"),
        HeaderValue::from_static("0"),
    );
    if production {
        headers.insert(
            STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static(HSTS_VALUE),
        );
    }
}

/// An empty 404 of an operational route with another method.
async fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

/// A Problem Details 404 of an `/api` route with another method.
async fn api_method_not_found() -> Response {
    errors::problem(errors::ProblemCode::NotFound)
}
