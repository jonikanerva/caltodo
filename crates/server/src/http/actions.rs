//! The action link routes (`server/handlers/actionRoutes.ts`).
//!
//! `GET /action/{token}` is a server-rendered page. `POST /api/action/{token}`
//! answers HTML when the `Accept` header contains `text/html` (the forms of
//! the page) and JSON otherwise.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::header::ACCEPT;
use axum::response::{Html, IntoResponse, Response};
use axum::{Extension, Json};

use super::AppState;
use super::dto::{ActionRequest, Success};
use super::errors::{Problem, ProblemCode, action_problem};
use super::html;
use super::input::{self, Body};
use super::openapi::{
    ActionPath, BadRequest, Conflict, CsrfRejected, ForbiddenProblem, GoogleFailure, InternalError,
    NotFoundProblem, PayloadTooLarge, RateLimited, Unauthenticated,
};
use super::session::{RequestSession, SignedIn, current_user, ensure_csrf_token};
use crate::application::actions::{ActionKind, ActionPage, action_page, perform_action};

fn page(status: axum::http::StatusCode, title: &str, body: &str) -> Response {
    (status, Html(html::shell(title, body))).into_response()
}

/// `GET /action/{token}`: the manage page of a task, or a sign-in page.
pub(super) async fn show(
    State(state): State<AppState>,
    RequestSession(session): RequestSession,
    Path(token): Path<String>,
) -> Response {
    use axum::http::StatusCode;
    if token.is_empty() {
        return page(StatusCode::BAD_REQUEST, "Invalid Link", html::INVALID_LINK);
    }
    let failed = || {
        page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Error",
            html::SOMETHING_WRONG,
        )
    };
    let user = match current_user(&state, &session).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return page(
                StatusCode::OK,
                "Sign in required",
                &html::sign_in_required(&token),
            );
        }
        Err(_) => return failed(),
    };
    let outcome = match action_page(&state.services, &user.id, &token).await {
        Ok(outcome) => outcome,
        Err(error) => {
            tracing::warn!(reason = error.tag(), "action page failed");
            return failed();
        }
    };
    match outcome {
        ActionPage::InvalidLink => {
            page(StatusCode::BAD_REQUEST, "Invalid Link", html::EXPIRED_LINK)
        }
        ActionPage::NotAuthorized => page(
            StatusCode::FORBIDDEN,
            "Not authorized",
            html::NOT_AUTHORIZED,
        ),
        ActionPage::TaskDeleted => {
            page(StatusCode::NOT_FOUND, "Task not found", html::TASK_DELETED)
        }
        ActionPage::TaskUnmappable => page(
            StatusCode::NOT_FOUND,
            "Task not found",
            html::TASK_UNMAPPABLE,
        ),
        ActionPage::Manage { title, completed } => match ensure_csrf_token(&session).await {
            Ok(csrf) => page(
                StatusCode::OK,
                "Manage task",
                &html::manage(&token, &title, completed, &csrf),
            ),
            Err(_) => failed(),
        },
    }
}

fn wants_html(headers: &HeaderMap) -> bool {
    headers
        .get(ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/html"))
}

/// Completes or reschedules the task of an action link, then writes a new
/// link into the event and uses up this one.
#[utoipa::path(
    post,
    path = "/api/action/{token}",
    operation_id = "performAction",
    tag = "actions",
    security(("csrfToken" = [])),
    params(ActionPath),
    request_body(
        content = ActionRequest,
        content_type = "application/json",
        description = "The action. The HTML form of the action page sends the same fields as `application/x-www-form-urlencoded` and gets an HTML page back."
    ),
    responses(
        (status = 200, description = "The action is done.", body = Success),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        ForbiddenProblem,
        NotFoundProblem,
        Conflict,
        PayloadTooLarge,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn perform(
    State(state): State<AppState>,
    signed_in: SignedIn,
    Path(token): Path<String>,
    headers: HeaderMap,
    Extension(body): Extension<Body>,
) -> Response {
    let html = wants_html(&headers);
    let respond_error = |problem: Problem| {
        if html {
            page(
                problem.status(),
                "Error",
                &html::action_failed(problem.detail()),
            )
        } else {
            problem.into_response()
        }
    };
    let Ok(kind) = input::action(&body) else {
        return respond_error(Problem::new(ProblemCode::InvalidAction));
    };
    match perform_action(&state.services, &signed_in.user.id, &token, kind).await {
        Ok(title) => {
            if html {
                let label = match kind {
                    ActionKind::Complete => "Task completed",
                    ActionKind::Reschedule => "Task rescheduled",
                };
                page(
                    axum::http::StatusCode::OK,
                    label,
                    &html::action_done(label, &title),
                )
            } else {
                Json(Success::OK).into_response()
            }
        }
        Err(error) => respond_error(action_problem(&error)),
    }
}
