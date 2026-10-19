//! The sign-in routes and the account routes (`server/handlers/authRoutes.ts`).

use axum::Json;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::http::header::LOCATION;
use axum::response::{IntoResponse, Response};

use super::AppState;
use super::dto::{AuthUser, Success};
use super::errors::{Problem, ProblemCode};
use super::html::encode_uri_component;
use super::openapi::{CsrfRejected, InternalError, RateLimited, Unauthenticated};
use super::session::{
    OAUTH_STATE_KEY, OAUTH_VERIFIER_KEY, PENDING_ACTION_KEY, RequestSession, SessionFailed,
    SignedIn, current_user, ensure_csrf_token, set_text, sign_in, take_text,
};
use crate::application::google_tag;
use crate::application::session_auth::{SignInError, complete_sign_in};
use crate::config::Secret;
use crate::security::constant_time_eq;

/// A `302 Found` redirect, like Express `res.redirect`.
fn redirect(location: &str) -> Response {
    match axum::http::HeaderValue::from_str(location) {
        Ok(value) => (StatusCode::FOUND, [(LOCATION, value)]).into_response(),
        Err(_) => Problem::new(ProblemCode::InternalError).into_response(),
    }
}

/// The value of a query parameter that appears exactly once. Express read a
/// repeated parameter as an array, which the handlers ignored.
fn single_param(query: Option<&str>, name: &str) -> Option<String> {
    let query = query?;
    let mut values = form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned());
    match (values.next(), values.next()) {
        (Some(value), None) => Some(value),
        _ => None,
    }
}

/// `GET /api/auth/google`: starts the Google sign-in. An `actionToken`
/// query parameter is kept, so the callback returns to that action page.
pub(super) async fn google_start(
    State(state): State<AppState>,
    RequestSession(session): RequestSession,
    RawQuery(query): RawQuery,
) -> Response {
    if let Some(token) = single_param(query.as_deref(), "actionToken")
        && let Err(failed) = set_text(&session, PENDING_ACTION_KEY, &token).await
    {
        return failed.into_response();
    }
    let Ok(authorization) = state.services.oauth.begin() else {
        return Problem::new(ProblemCode::SignInFailed).into_response();
    };
    let stored = async {
        set_text(&session, OAUTH_STATE_KEY, authorization.state.expose()).await?;
        set_text(
            &session,
            OAUTH_VERIFIER_KEY,
            authorization.pkce_verifier.expose(),
        )
        .await
    };
    if let Err(failed) = stored.await {
        return failed.into_response();
    }
    redirect(&authorization.url)
}

/// `GET /api/auth/google/callback`: completes the sign-in.
///
/// A denied consent, a missing code, or a `state` that does not match goes
/// back to `/` (Passport `failureRedirect`). The new session gets a new id
/// against session fixation. A sign-in that started on an action page
/// returns there.
pub(super) async fn google_callback(
    State(state): State<AppState>,
    RequestSession(session): RequestSession,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let (Ok(expected_state), Ok(verifier)) = (
        take_text(&session, OAUTH_STATE_KEY).await,
        take_text(&session, OAUTH_VERIFIER_KEY).await,
    ) else {
        return SessionFailed.into_response();
    };
    if let Some(error) = single_param(query, "error") {
        return if error == "access_denied" {
            redirect("/")
        } else {
            Problem::new(ProblemCode::SignInFailed).into_response()
        };
    }
    let (Some(code), Some(returned_state), Some(expected_state), Some(verifier)) = (
        single_param(query, "code"),
        single_param(query, "state"),
        expected_state,
        verifier,
    ) else {
        return redirect("/");
    };
    if !constant_time_eq(&returned_state, &expected_state) {
        return redirect("/");
    }
    let user = match complete_sign_in(&state.services, &code, &Secret::new(verifier)).await {
        Ok(user) => user,
        Err(SignInError::Google(error)) => {
            tracing::warn!(reason = google_tag(error), "sign-in failed");
            return Problem::new(ProblemCode::SignInFailed).into_response();
        }
        Err(SignInError::Store(_)) => {
            tracing::error!(reason = "database", "sign-in failed");
            return Problem::new(ProblemCode::InternalError).into_response();
        }
    };
    let pending = match take_text(&session, PENDING_ACTION_KEY).await {
        Ok(pending) => pending,
        Err(failed) => return failed.into_response(),
    };
    if let Err(failed) = sign_in(&session, &user.id).await {
        return failed.into_response();
    }
    match pending {
        Some(token) => redirect(&format!("/action/{}", encode_uri_component(&token))),
        None => redirect("/"),
    }
}

/// The signed-in user with the CSRF token of the session.
#[utoipa::path(
    get,
    path = "/api/auth/user",
    operation_id = "getCurrentUser",
    tag = "auth",
    responses(
        (status = 200, description = "The signed-in user.", body = AuthUser),
        Unauthenticated,
        RateLimited,
        InternalError
    )
)]
pub(super) async fn current(
    State(state): State<AppState>,
    RequestSession(session): RequestSession,
) -> Response {
    let user = match current_user(&state, &session).await {
        Ok(Some(user)) => user,
        // The Node text of this route; the other routes answer the
        // `requireAuth` text "Unauthorized" (ADR 0004).
        Ok(None) => {
            return Problem::with_detail(ProblemCode::Unauthenticated, "Not authenticated")
                .into_response();
        }
        Err(failed) => return failed.into_response(),
    };
    match ensure_csrf_token(&session).await {
        Ok(token) => Json(AuthUser::new(&user, token)).into_response(),
        Err(failed) => failed.into_response(),
    }
}

/// Signs out: deletes the session and its cookie.
#[utoipa::path(
    post,
    path = "/api/auth/logout",
    operation_id = "logout",
    tag = "auth",
    security(("csrfToken" = [])),
    responses(
        (status = 200, description = "The session is deleted.", body = Success),
        CsrfRejected,
        RateLimited,
        InternalError
    )
)]
pub(super) async fn logout(RequestSession(session): RequestSession) -> Response {
    match session.flush().await {
        Ok(()) => Json(Success::OK).into_response(),
        Err(_) => Problem::with_detail(ProblemCode::InternalError, "Logout failed").into_response(),
    }
}

/// Deletes the stored data of the user and signs out. The calendar events
/// stay in Google Calendar.
#[utoipa::path(
    delete,
    path = "/api/account",
    operation_id = "deleteAccount",
    tag = "auth",
    security(("csrfToken" = [])),
    responses(
        (status = 200, description = "The account data is deleted.", body = Success),
        Unauthenticated,
        CsrfRejected,
        RateLimited,
        InternalError
    )
)]
pub(super) async fn delete_account(State(state): State<AppState>, signed_in: SignedIn) -> Response {
    if state
        .services
        .store
        .delete_user_data(&signed_in.user.id)
        .await
        .is_err()
    {
        tracing::error!(reason = "database", "account data not deleted");
        return Problem::with_detail(ProblemCode::InternalError, "Failed to delete user data")
            .into_response();
    }
    if signed_in.session.flush().await.is_err() {
        tracing::warn!(
            reason = "session",
            "session not deleted after account deletion"
        );
    }
    Json(Success::OK).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_single_query_parameters() {
        assert_eq!(
            single_param(Some("actionToken=a%2Fb&x=1"), "actionToken").as_deref(),
            Some("a/b")
        );
        assert_eq!(
            single_param(Some("actionToken=a&actionToken=b"), "actionToken"),
            None
        );
        assert_eq!(single_param(None, "code"), None);
    }
}
