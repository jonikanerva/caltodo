//! The operational routes beside the API contract: liveness, readiness, and
//! the build identity. No answer contains a secret, a file path, or user
//! data.

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use super::AppState;

/// The longest wait of the readiness check for the database.
const READY_TIMEOUT: Duration = Duration::from_secs(2);

/// `GET /healthz`: the process serves requests. It calls no dependency.
pub(super) async fn health() -> Response {
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// `GET /readyz`: the database answers within two seconds (503 otherwise).
pub(super) async fn readiness(State(state): State<AppState>) -> Response {
    let ping = crate::db::ping(state.services.store.pool());
    match tokio::time::timeout(READY_TIMEOUT, ping).await {
        Ok(Ok(())) => Json(serde_json::json!({ "ready": true })).into_response(),
        Ok(Err(_)) | Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "ready": false })),
        )
            .into_response(),
    }
}

#[derive(Debug, Serialize)]
struct VersionBody<'a> {
    version: &'a str,
    commit: &'a str,
}

/// `GET /version`: the crate version and the deployed Git commit
/// (`unknown` without a valid `RAILWAY_GIT_COMMIT_SHA`).
pub(super) async fn version(State(state): State<AppState>) -> Response {
    Json(VersionBody {
        version: state.build.version,
        commit: &state.build.commit,
    })
    .into_response()
}
