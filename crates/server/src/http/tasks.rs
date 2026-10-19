//! The task routes (`server/handlers/taskRoutes.ts`) and the settings routes
//! (`server/handlers/authRoutes.ts`).
//!
//! Each handler decodes its input, calls one use case, and maps the outcome.
//! A failure becomes a [`Problem`] with the text of the Node server.

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use caltodo_domain::ids::EventId;

use super::AppState;
use super::dto::{
    CalendarListItem, CalendarTask, CreateTaskRequest, CreateTaskResult, RescheduleAllResult,
    Success, TaskIdsRequest, UpdateSettingsRequest, UpdateTaskRequest, UserSettings,
};
use super::errors::{Problem, ProblemCode, app_problem};
use super::input::{self, Body};
use super::openapi::{
    BadRequest, Conflict, CsrfRejected, GoogleFailure, InternalError, NotFoundProblem,
    PayloadTooLarge, RateLimited, TaskPath, Unauthenticated,
};
use super::session::SignedIn;
use crate::application::{AppError, tasks};

fn failure(error: &AppError, fallback: &'static str) -> Response {
    if matches!(
        error,
        AppError::Store(_)
            | AppError::Random(_)
            | AppError::InvalidStoredSettings
            | AppError::Google(_)
    ) {
        tracing::warn!(reason = error.tag(), "request failed");
    }
    app_problem(error, fallback).into_response()
}

fn task_id(id: String) -> Result<EventId, Problem> {
    EventId::new(id).ok_or_else(|| Problem::new(ProblemCode::InvalidRequest))
}

/// The tasks from 14 days ago to 90 days ahead: incomplete tasks by start
/// time, then completed tasks, most recent first.
#[utoipa::path(
    get,
    path = "/api/tasks",
    operation_id = "listTasks",
    tag = "tasks",
    responses(
        (status = 200, description = "The task list; empty without a calendar.", body = [CalendarTask]),
        Unauthenticated,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn list(State(state): State<AppState>, signed_in: SignedIn) -> Response {
    match tasks::list_tasks(&state.services, &signed_in.user.id).await {
        Ok(list) => Json(list.iter().map(CalendarTask::from).collect::<Vec<_>>()).into_response(),
        Err(error) => failure(&error, "Failed to get tasks"),
    }
}

/// Creates a task in the first free slot. An urgent task then moves to the
/// front of the schedule; the answer reports a failed move.
#[utoipa::path(
    post,
    path = "/api/tasks",
    operation_id = "createTask",
    tag = "tasks",
    security(("csrfToken" = [])),
    request_body = CreateTaskRequest,
    responses(
        (status = 200, description = "The created task. `urgentMoveFailed` reports an urgent task that did not move to the front.", body = CreateTaskResult),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        Conflict,
        PayloadTooLarge,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn create(
    State(state): State<AppState>,
    signed_in: SignedIn,
    Extension(body): Extension<Body>,
) -> Response {
    let Ok(input) = input::new_task(&body) else {
        return Problem::new(ProblemCode::InvalidRequest).into_response();
    };
    match tasks::create_task(&state.services, &signed_in.user.id, &input).await {
        Ok(created) => Json(CreateTaskResult {
            task: CalendarTask::from(&created.task),
            urgent_move_failed: created.urgent_move_failed,
        })
        .into_response(),
        Err(error) => failure(&error, "Failed to create task"),
    }
}

/// Completes or reopens a task.
#[utoipa::path(
    patch,
    path = "/api/tasks/{id}",
    operation_id = "updateTask",
    tag = "tasks",
    security(("csrfToken" = [])),
    params(TaskPath),
    request_body = UpdateTaskRequest,
    responses(
        (status = 200, description = "The changed task.", body = CalendarTask),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        NotFoundProblem,
        PayloadTooLarge,
        RateLimited,
        InternalError
    )
)]
pub(super) async fn update(
    State(state): State<AppState>,
    signed_in: SignedIn,
    Path(id): Path<String>,
    Extension(body): Extension<Body>,
) -> Response {
    let id = match task_id(id) {
        Ok(id) => id,
        Err(problem) => return problem.into_response(),
    };
    let Ok(completed) = input::completion(&body) else {
        return Problem::new(ProblemCode::InvalidRequest).into_response();
    };
    match tasks::set_completion(&state.services, &signed_in.user.id, &id, completed).await {
        Ok(task) => Json(CalendarTask::from(&task)).into_response(),
        Err(error) => failure(&error, "Failed to update task"),
    }
}

/// Gives the tasks the order of `taskIds` by swapping their time slots.
///
/// Every task is read before the first move: a missing task changes
/// nothing. A failed move stops the request; the moves before it stay.
#[utoipa::path(
    post,
    path = "/api/tasks/reorder",
    operation_id = "reorderTasks",
    tag = "tasks",
    security(("csrfToken" = [])),
    request_body = TaskIdsRequest,
    responses(
        (status = 200, description = "Every task moved to its slot of the requested order.", body = Success),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        NotFoundProblem,
        PayloadTooLarge,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn reorder(
    State(state): State<AppState>,
    signed_in: SignedIn,
    Extension(body): Extension<Body>,
) -> Response {
    let Ok(ids) = input::task_ids(&body) else {
        return Problem::new(ProblemCode::InvalidTaskIds).into_response();
    };
    match tasks::reorder(&state.services, &signed_in.user.id, &ids).await {
        Ok(()) => Json(Success::OK).into_response(),
        Err(error) => failure(&error, "Failed to reorder tasks"),
    }
}

/// Completes each task.
///
/// Every task is read before the first change: a missing task changes
/// nothing. A failed change stops the request; the changes before it stay.
#[utoipa::path(
    post,
    path = "/api/tasks/bulk-complete",
    operation_id = "bulkCompleteTasks",
    tag = "tasks",
    security(("csrfToken" = [])),
    request_body = TaskIdsRequest,
    responses(
        (status = 200, description = "Every task is complete.", body = Success),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        NotFoundProblem,
        PayloadTooLarge,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn bulk_complete(
    State(state): State<AppState>,
    signed_in: SignedIn,
    Extension(body): Extension<Body>,
) -> Response {
    let Ok(ids) = input::task_ids(&body) else {
        return Problem::new(ProblemCode::InvalidTaskIds).into_response();
    };
    match tasks::bulk_complete(&state.services, &signed_in.user.id, &ids).await {
        Ok(()) => Json(Success::OK).into_response(),
        Err(error) => failure(&error, "Failed to complete tasks"),
    }
}

/// Moves every incomplete task into the earliest free slots.
#[utoipa::path(
    post,
    path = "/api/tasks/reschedule-all",
    operation_id = "rescheduleAllTasks",
    tag = "tasks",
    security(("csrfToken" = [])),
    responses(
        (status = 200, description = "The counts of moved, unchanged, skipped, and failed tasks.", body = RescheduleAllResult),
        Unauthenticated,
        CsrfRejected,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn reschedule_all(State(state): State<AppState>, signed_in: SignedIn) -> Response {
    match tasks::reschedule_all(&state.services, &signed_in.user.id, &[]).await {
        Ok(summary) => Json(RescheduleAllResult {
            success: true,
            summary: summary.into(),
        })
        .into_response(),
        Err(error) => failure(&error, "Failed to reschedule tasks"),
    }
}

/// Reads the tasks from Google Calendar; the client then reloads the list.
#[utoipa::path(
    post,
    path = "/api/tasks/reload",
    operation_id = "reloadTasks",
    tag = "tasks",
    security(("csrfToken" = [])),
    responses(
        (status = 200, description = "Google Calendar answered the task read.", body = Success),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn reload(State(state): State<AppState>, signed_in: SignedIn) -> Response {
    match tasks::reload(&state.services, &signed_in.user.id).await {
        Ok(()) => Json(Success::OK).into_response(),
        Err(error) => failure(&error, "Failed to reload calendar data"),
    }
}

/// Completes one task.
#[utoipa::path(
    post,
    path = "/api/tasks/{id}/complete",
    operation_id = "completeTask",
    tag = "tasks",
    security(("csrfToken" = [])),
    params(TaskPath),
    responses(
        (status = 200, description = "The task is complete.", body = Success),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        NotFoundProblem,
        RateLimited,
        InternalError
    )
)]
pub(super) async fn complete(
    State(state): State<AppState>,
    signed_in: SignedIn,
    Path(id): Path<String>,
) -> Response {
    let id = match task_id(id) {
        Ok(id) => id,
        Err(problem) => return problem.into_response(),
    };
    match tasks::complete_task(&state.services, &signed_in.user.id, &id).await {
        Ok(()) => Json(Success::OK).into_response(),
        Err(error) => failure(&error, "Failed to complete task"),
    }
}

/// Moves one task to the first free slot.
#[utoipa::path(
    post,
    path = "/api/tasks/{id}/reschedule",
    operation_id = "rescheduleTask",
    tag = "tasks",
    security(("csrfToken" = [])),
    params(TaskPath),
    responses(
        (status = 200, description = "The task is moved.", body = Success),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        NotFoundProblem,
        Conflict,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn reschedule(
    State(state): State<AppState>,
    signed_in: SignedIn,
    Path(id): Path<String>,
) -> Response {
    let id = match task_id(id) {
        Ok(id) => id,
        Err(problem) => return problem.into_response(),
    };
    match tasks::reschedule_task(&state.services, &signed_in.user.id, &id).await {
        Ok(()) => Json(Success::OK).into_response(),
        Err(error) => failure(&error, "Failed to reschedule task"),
    }
}

/// The settings of the user, or `null` without settings.
#[utoipa::path(
    get,
    path = "/api/settings",
    operation_id = "getSettings",
    tag = "settings",
    responses(
        (status = 200, description = "The settings, or `null`.", body = Option<UserSettings>),
        Unauthenticated,
        RateLimited,
        InternalError
    )
)]
pub(super) async fn get_settings(State(state): State<AppState>, signed_in: SignedIn) -> Response {
    match state.services.store.settings(&signed_in.user.id).await {
        Ok(settings) => Json(settings.map(UserSettings::from)).into_response(),
        Err(_) => Problem::with_detail(ProblemCode::InternalError, "Failed to get settings")
            .into_response(),
    }
}

/// Saves the settings. Without `calendarId` the stored calendar stays.
#[utoipa::path(
    patch,
    path = "/api/settings",
    operation_id = "updateSettings",
    tag = "settings",
    security(("csrfToken" = [])),
    request_body = UpdateSettingsRequest,
    responses(
        (status = 200, description = "The saved settings.", body = UserSettings),
        BadRequest,
        Unauthenticated,
        CsrfRejected,
        PayloadTooLarge,
        RateLimited,
        InternalError
    )
)]
pub(super) async fn update_settings(
    State(state): State<AppState>,
    signed_in: SignedIn,
    Extension(body): Extension<Body>,
) -> Response {
    let Ok(change) = input::settings_change(&body) else {
        return Problem::new(ProblemCode::InvalidSettings).into_response();
    };
    let saved = state
        .services
        .store
        .save_settings(&signed_in.user.id, &change)
        .await;
    if let Ok(saved) = saved {
        Json(UserSettings::from(saved)).into_response()
    } else {
        // The Node server answered every failure of this route with 400.
        tracing::warn!(reason = "database", "settings not saved");
        Problem::new(ProblemCode::InvalidSettings).into_response()
    }
}

/// The calendars of the user's Google account.
#[utoipa::path(
    get,
    path = "/api/calendars",
    operation_id = "listCalendars",
    tag = "settings",
    responses(
        (status = 200, description = "The calendar list.", body = [CalendarListItem]),
        Unauthenticated,
        RateLimited,
        InternalError,
        GoogleFailure
    )
)]
pub(super) async fn calendars(State(state): State<AppState>, signed_in: SignedIn) -> Response {
    match tasks::list_calendars(&state.services, &signed_in.user.id).await {
        Ok(list) => Json(
            list.into_iter()
                .map(CalendarListItem::from)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => failure(&error, "Failed to list calendars"),
    }
}
