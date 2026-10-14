//! The OpenAPI 3.1 document of the `/api` routes (`contract/openapi.json`).
//!
//! [`api_routes`] registers every documented route through `utoipa-axum`, so
//! the router and the document come from one list. The `openapi` binary
//! exports the document; it needs no state, environment, network, database,
//! or client build.
//!
//! Outside the contract: the browser navigations `GET /api/auth/google`,
//! `GET /api/auth/google/callback`, and `GET /action/{token}` (redirects and
//! HTML), and the operational routes `/healthz`, `/readyz`, and `/version`.
//!
//! The annotations describe the handlers; they do not prove what a handler
//! answers. `tests/api_contract.rs` checks the answered statuses and bodies
//! against this document.

use axum::Router;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityScheme};
use utoipa::{IntoParams, IntoResponses, Modify, OpenApi};
use utoipa_axum::router::{OpenApiRouter, UtoipaMethodRouterExt};
use utoipa_axum::routes;

use super::errors::{Problem, ProblemCode, problem};
use super::{AppState, actions, auth, tasks};

#[derive(Debug, OpenApi)]
#[openapi(
    info(
        title = "caltodo API",
        description = "Tasks that live as Google Calendar events. Every failure answers RFC 9457 Problem Details (`application/problem+json`) with a stable `code`. A request that is not GET must send the CSRF token of `GET /api/auth/user` as the `X-CSRF-Token` header."
    ),
    components(schemas(Problem, ProblemCode)),
    modifiers(&Security),
    tags(
        (name = "auth", description = "The signed-in user and the account"),
        (name = "tasks", description = "Tasks as Google Calendar events"),
        (name = "settings", description = "Calendar choice, work hours, and defaults"),
        (name = "actions", description = "The action links in event descriptions")
    )
)]
struct ApiDoc;

/// Adds the security schemes and removes the empty licence that the derive
/// takes from the crate manifest.
#[derive(Debug)]
struct Security;

impl Modify for Security {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        openapi.info.license = None;
        let components = openapi
            .components
            .get_or_insert_with(utoipa::openapi::Components::new);
        components.add_security_scheme(
            "sessionCookie",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::with_description(
                "caltodo.sid",
                "The HttpOnly session cookie of the Google sign-in. The browser sends it; script never reads it.",
            ))),
        );
        components.add_security_scheme(
            "csrfToken",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::with_description(
                "X-CSRF-Token",
                "The `csrfToken` of `GET /api/auth/user`.",
            ))),
        );
    }
}

/// The documented `/api` routes. Another method on a documented path
/// answers a Problem Details 404, like an unknown `/api` path.
pub fn api_routes() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(auth::current).map(|r| r.fallback(method_not_found)))
        .routes(routes!(auth::logout).map(|r| r.fallback(method_not_found)))
        .routes(routes!(auth::delete_account).map(|r| r.fallback(method_not_found)))
        .routes(
            routes!(tasks::get_settings, tasks::update_settings)
                .map(|r| r.fallback(method_not_found)),
        )
        .routes(routes!(tasks::calendars).map(|r| r.fallback(method_not_found)))
        .routes(routes!(tasks::list, tasks::create).map(|r| r.fallback(method_not_found)))
        .routes(routes!(tasks::reorder).map(|r| r.fallback(method_not_found)))
        .routes(routes!(tasks::bulk_complete).map(|r| r.fallback(method_not_found)))
        .routes(routes!(tasks::reschedule_all).map(|r| r.fallback(method_not_found)))
        .routes(routes!(tasks::reload).map(|r| r.fallback(method_not_found)))
        .routes(routes!(tasks::update).map(|r| r.fallback(method_not_found)))
        .routes(routes!(tasks::complete).map(|r| r.fallback(method_not_found)))
        .routes(routes!(tasks::reschedule).map(|r| r.fallback(method_not_found)))
        .routes(routes!(actions::perform).map(|r| r.fallback(method_not_found)))
}

/// The `/api` router and the document of the same routes.
pub fn api_router() -> (Router<AppState>, utoipa::openapi::OpenApi) {
    api_routes().split_for_parts()
}

/// The OpenAPI document as pretty JSON with a final newline.
///
/// # Errors
///
/// A JSON serialization failure of the document.
pub fn document_json() -> Result<String, serde_json::Error> {
    let mut text = api_routes().into_openapi().to_pretty_json()?;
    text.push('\n');
    Ok(text)
}

/// The answer to another method on a documented path.
async fn method_not_found() -> axum::response::Response {
    problem(ProblemCode::NotFound)
}

// ---- Parameters -------------------------------------------------------------

/// The task path.
#[derive(Debug, IntoParams)]
#[into_params(parameter_in = Path)]
#[expect(dead_code, reason = "documents the path; axum decodes it")]
pub struct TaskPath {
    /// The Google Calendar event id of the task.
    #[param(min_length = 1)]
    id: String,
}

/// The action link path.
#[derive(Debug, IntoParams)]
#[into_params(parameter_in = Path)]
#[expect(dead_code, reason = "documents the path; axum decodes it")]
pub struct ActionPath {
    /// The raw action token of the link.
    #[param(min_length = 1)]
    token: String,
}

// ---- Failure responses --------------------------------------------------------

/// 400: an invalid body, or a missing calendar or settings.
#[derive(Debug, IntoResponses)]
#[response(
    status = 400,
    description = "Problem `invalid_request`, `invalid_task_ids`, `invalid_settings`, `invalid_action`, `no_calendar`, `no_settings`, `invalid_link`, or `invalid_event_time`.",
    content_type = "application/problem+json"
)]
pub struct BadRequest(pub Problem);

/// 401: no signed-in session.
#[derive(Debug, IntoResponses)]
#[response(
    status = 401,
    description = "Problem `unauthenticated`: no signed-in session.",
    content_type = "application/problem+json"
)]
pub struct Unauthenticated(pub Problem);

/// 403: a missing or wrong CSRF token.
#[derive(Debug, IntoResponses)]
#[response(
    status = 403,
    description = "Problem `csrf_rejected`: the CSRF token is missing or wrong.",
    content_type = "application/problem+json"
)]
pub struct CsrfRejected(pub Problem);

/// 403 of the action route: the token of another user, or a CSRF failure.
#[derive(Debug, IntoResponses)]
#[response(
    status = 403,
    description = "Problem `forbidden` (the link belongs to another user) or `csrf_rejected`.",
    content_type = "application/problem+json"
)]
pub struct ForbiddenProblem(pub Problem);

/// 404: a missing task.
#[derive(Debug, IntoResponses)]
#[response(
    status = 404,
    description = "Problem `task_not_found` or `no_tasks_to_reorder`.",
    content_type = "application/problem+json"
)]
pub struct NotFoundProblem(pub Problem);

/// 409: no free slot.
#[derive(Debug, IntoResponses)]
#[response(
    status = 409,
    description = "Problem `no_free_slot`: no free time slot in the next 90 days.",
    content_type = "application/problem+json"
)]
pub struct Conflict(pub Problem);

/// 413: the body is too large.
#[derive(Debug, IntoResponses)]
#[response(
    status = 413,
    description = "Problem `payload_too_large`: more than 100 KiB of JSON or 50 KiB of form data.",
    content_type = "application/problem+json"
)]
pub struct PayloadTooLarge(pub Problem);

/// 429: too many requests.
#[derive(Debug, IntoResponses)]
#[response(
    status = 429,
    description = "Problem `rate_limited`: too many requests from this client.",
    content_type = "application/problem+json"
)]
pub struct RateLimited(pub Problem);

/// 500: a server failure.
#[derive(Debug, IntoResponses)]
#[response(
    status = 500,
    description = "Problem `internal_error`, `calendar_unavailable`, or `event_not_created`.",
    content_type = "application/problem+json"
)]
pub struct InternalError(pub Problem);

/// 502: Google failed.
#[derive(Debug, IntoResponses)]
#[response(
    status = 502,
    description = "Problem `google_unavailable` or `google_reauthorization_required`.",
    content_type = "application/problem+json"
)]
pub struct GoogleFailure(pub Problem);
