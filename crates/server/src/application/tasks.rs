//! The task use cases (`server/calendar.ts` and `server/handlers/taskRoutes.ts`).

use caltodo_domain::event::{
    CalendarEvent, base_description, completion_properties, description_with_actions, format_title,
    strip_title_prefix, task_properties,
};
use caltodo_domain::ids::{CalendarId, EventId, UserId};
use caltodo_domain::instant::duration_minutes;
use caltodo_domain::reorder::{TaskLookup, plan_reorder};
use caltodo_domain::schedule::{
    RescheduleSummary, Slot, WorkSchedule, busy_intervals, find_slot, reschedule_order,
    slot_matches,
};
use caltodo_domain::settings::WorkHour;
use caltodo_domain::task::{Task, order_task_list};
use futures_util::{StreamExt as _, stream};
use jiff::Timestamp;
use jiff::tz::TimeZone;

use super::calendar_access::UserCalendar;
use super::ports::{EventPatch, EventTime, GoogleError, NewEvent};
use super::{AppError, Services, google_tag};
use crate::db::action_tokens::NewActionToken;
use crate::db::settings::SettingsRow;
use crate::security::action_tokens::{TOKEN_LIFETIME, action_link};

/// The days before now that `GET /api/tasks` reads.
const LIST_DAYS_BEFORE: i64 = 14;
/// The days after now that the task list and every slot search read.
const DAYS_AHEAD: i64 = 90;
/// The days before now that "Reschedule all" reads.
const RESCHEDULE_DAYS_BEFORE: i64 = 7;
/// The most parallel event reads of one reorder (the Node server read all
/// of them at once).
const PARALLEL_EVENT_READS: usize = 8;

/// The settings of a user with a configured calendar.
#[derive(Debug, Clone)]
pub struct CalendarSettings {
    pub row: SettingsRow,
    pub calendar: CalendarId,
}

impl CalendarSettings {
    /// The zone and hours of the free-slot search: the stored values, with
    /// UTC for an empty zone like the Node server.
    ///
    /// # Errors
    ///
    /// A stored value that the scheduler cannot use.
    pub fn schedule(&self) -> Result<WorkSchedule, AppError> {
        schedule_of(&self.row)
    }

    /// The zone name that Google Calendar receives with each time.
    #[must_use]
    pub fn time_zone(&self) -> &str {
        &self.row.timezone
    }
}

fn schedule_of(row: &SettingsRow) -> Result<WorkSchedule, AppError> {
    let zone = if row.timezone.is_empty() {
        TimeZone::UTC
    } else {
        TimeZone::get(&row.timezone).map_err(|_| AppError::InvalidStoredSettings)?
    };
    Ok(WorkSchedule {
        zone,
        start_hour: WorkHour::from_i64(i64::from(row.work_start_hour))
            .ok_or(AppError::InvalidStoredSettings)?,
        end_hour: WorkHour::from_i64(i64::from(row.work_end_hour))
            .ok_or(AppError::InvalidStoredSettings)?,
    })
}

/// The settings with a calendar (`requireCalendarSettings`).
///
/// # Errors
///
/// [`AppError::NoCalendar`] without settings or without a calendar.
pub async fn calendar_settings(
    services: &Services,
    user: &UserId,
) -> Result<CalendarSettings, AppError> {
    let row = services
        .store
        .settings(user)
        .await?
        .ok_or(AppError::NoCalendar)?;
    let calendar = row
        .calendar_id
        .clone()
        .and_then(CalendarId::new)
        .ok_or(AppError::NoCalendar)?;
    Ok(CalendarSettings { row, calendar })
}

async fn open_calendar<'s>(
    services: &'s Services,
    user: &UserId,
) -> Result<UserCalendar<'s>, AppError> {
    UserCalendar::open(services, user)
        .await?
        .ok_or(AppError::NoCalendarAccess)
}

/// `GET /api/tasks`: the tasks from 14 days ago to 90 days ahead, ordered.
/// No configured calendar gives an empty list.
///
/// # Errors
///
/// No calendar access, or Google fails (the Node server answered an empty
/// list on a Google failure).
pub async fn list_tasks(services: &Services, user: &UserId) -> Result<Vec<Task>, AppError> {
    let settings = match calendar_settings(services, user).await {
        Ok(settings) => settings,
        Err(AppError::NoCalendar) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let calendar = open_calendar(services, user).await?;
    let now = services.clock.now();
    let events = calendar
        .list_events(
            &settings.calendar,
            services.add_days(now, -LIST_DAYS_BEFORE),
            services.add_days(now, DAYS_AHEAD),
        )
        .await?;
    Ok(order_task_list(
        events.iter().filter_map(Task::from_event).collect(),
    ))
}

/// Events that a search can reuse instead of a new list call.
#[derive(Debug, Clone, Copy)]
struct Prefetched<'a> {
    events: &'a [CalendarEvent],
    time_min: Timestamp,
    time_max: Timestamp,
}

/// The free-slot search (`findFreeSlot`): from `after` (or now) to 90 days
/// later.
async fn find_free_slot(
    services: &Services,
    calendar: &UserCalendar<'_>,
    settings: &CalendarSettings,
    duration: i64,
    after: Option<Timestamp>,
    ignore_all_tasks: bool,
    prefetched: Option<Prefetched<'_>>,
) -> Result<Option<Slot>, AppError> {
    let now = after.unwrap_or_else(|| services.clock.now());
    let search_end = services.add_days(now, DAYS_AHEAD);
    let schedule = settings.schedule()?;
    let listed;
    let events = match prefetched {
        Some(window) if now >= window.time_min && search_end <= window.time_max => window.events,
        _ => {
            listed = calendar
                .list_events(&settings.calendar, now, search_end)
                .await?;
            listed.as_slice()
        }
    };
    let busy = busy_intervals(events, ignore_all_tasks);
    let minutes = u32::try_from(duration).unwrap_or(0);
    Ok(find_slot(&busy, minutes, &schedule, now, search_end))
}

fn event_time(instant: Timestamp, zone: &str) -> EventTime {
    EventTime {
        date_time: instant,
        time_zone: zone.to_owned(),
    }
}

/// A new task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTask {
    pub title: String,
    pub details: Option<String>,
    pub urgent: bool,
    pub duration_minutes: Option<u32>,
}

/// `POST /api/tasks`: schedules a new task in the first free slot. An
/// urgent task then moves to the front of the schedule.
///
/// # Errors
///
/// No calendar, no free slot, or a Google failure.
pub async fn create_task(
    services: &Services,
    user: &UserId,
    input: &NewTask,
) -> Result<Task, AppError> {
    let settings = calendar_settings(services, user).await?;
    let calendar = open_calendar(services, user).await?;
    let duration = input
        .duration_minutes
        .map_or(i64::from(settings.row.default_duration), i64::from);
    let slot = find_free_slot(services, &calendar, &settings, duration, None, false, None)
        .await?
        .ok_or(AppError::NoFreeSlot)?;

    let zone = settings.time_zone();
    let new_event = NewEvent {
        summary: format_title(&input.title, false),
        description: base_description(input.details.as_deref()),
        start: event_time(slot.start, zone),
        end: event_time(slot.end, zone),
        color_id: settings.row.event_color.clone(),
        private_properties: task_properties(false),
    };
    let created = match calendar.insert_event(&settings.calendar, &new_event).await {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!(reason = google_tag(error), "calendar event not created");
            return Err(AppError::EventNotCreated);
        }
    };
    let Some(event_id) = created.task_id().and_then(EventId::new) else {
        return Err(AppError::EventNotCreated);
    };
    refresh_event_actions(
        services,
        &calendar,
        user,
        &settings.calendar,
        &event_id,
        input.details.as_deref(),
    )
    .await;

    if input.urgent {
        // The task exists now. A failed reprioritization must not report a
        // failed creation, or the user would create the task twice; the
        // Node server also kept the created task.
        if let Err(error) = reschedule_all(services, user, &[event_id.clone().into_string()]).await
        {
            tracing::warn!(
                reason = error.tag(),
                "urgent task was not moved to the front"
            );
        }
    }

    let loaded = match calendar.get_event(&settings.calendar, &event_id).await {
        Ok(event) if !event.is_cancelled() => event,
        Ok(_) | Err(_) => return Err(AppError::CreatedEventMissing),
    };
    Task::from_event(&loaded).ok_or(AppError::CreatedEventInvalid)
}

/// Creates a new action token, writes its link into the event description,
/// and retires the older tokens of the event (`updateCalendarEventActions`).
/// A failure is logged and ignored, like on the Node server.
async fn refresh_event_actions(
    services: &Services,
    calendar: &UserCalendar<'_>,
    user: &UserId,
    calendar_id: &CalendarId,
    event: &EventId,
    details: Option<&str>,
) {
    let Ok(token) = services.tokens.generate() else {
        tracing::warn!(reason = "random_unavailable", "action token not created");
        return;
    };
    let now = services.clock.now();
    let expires_at = now.checked_add(TOKEN_LIFETIME).unwrap_or(now);
    let Ok(token_id) = services
        .store
        .create_action_token(&NewActionToken {
            token_hash: &token.hash,
            user_id: user,
            event_id: event,
            calendar_id,
            expires_at,
        })
        .await
    else {
        tracing::warn!(reason = "database", "action token not created");
        return;
    };
    let patch = EventPatch {
        description: Some(description_with_actions(
            details,
            &action_link(&services.app_origin, &token.raw),
        )),
        ..EventPatch::default()
    };
    if let Err(error) = calendar.patch_event(calendar_id, event, &patch).await {
        tracing::warn!(reason = google_tag(error), "event action link not updated");
        if services
            .store
            .mark_action_token_used(&token_id, services.clock.now())
            .await
            .is_err()
        {
            tracing::warn!(reason = "database", "unused action token not retired");
        }
        return;
    }
    if services
        .store
        .invalidate_event_tokens(user, event, calendar_id, &token.hash, services.clock.now())
        .await
        .is_err()
    {
        tracing::warn!(reason = "database", "older action tokens not retired");
    }
}

/// Sets the completion state of a task event (`updateCalendarEventCompletion`).
/// `None` for a deleted, cancelled, or foreign event, and for any Google
/// failure, like on the Node server.
async fn update_event_completion(
    calendar: &UserCalendar<'_>,
    calendar_id: &CalendarId,
    event_id: &EventId,
    completed: bool,
) -> Option<CalendarEvent> {
    let current = match calendar.get_event(calendar_id, event_id).await {
        Ok(event) => event,
        Err(error) => {
            log_lookup_failure(error, "task completion not updated");
            return None;
        }
    };
    if current.is_cancelled() || !current.is_task() {
        return None;
    }
    let title = strip_title_prefix(current.summary.as_deref().unwrap_or_default());
    let patch = EventPatch {
        summary: Some(format_title(title, completed)),
        transparency: Some(if completed { "transparent" } else { "opaque" }),
        private_properties: Some(completion_properties(
            &current.private_properties,
            completed,
        )),
        ..EventPatch::default()
    };
    match calendar.patch_event(calendar_id, event_id, &patch).await {
        Ok(updated) => Some(updated),
        Err(error) => {
            log_lookup_failure(error, "task completion not updated");
            None
        }
    }
}

fn log_lookup_failure(error: GoogleError, message: &'static str) {
    if error != GoogleError::NotFound {
        tracing::warn!(reason = google_tag(error), "{message}");
    }
}

/// Moves a task event (`updateCalendarEventTime`). `false` for a cancelled
/// or foreign event and for any Google failure.
async fn update_event_time(
    calendar: &UserCalendar<'_>,
    calendar_id: &CalendarId,
    time_zone: &str,
    event_id: &EventId,
    slot: Slot,
) -> bool {
    let current = match calendar.get_event(calendar_id, event_id).await {
        Ok(event) => event,
        Err(error) => {
            log_lookup_failure(error, "task time not updated");
            return false;
        }
    };
    if current.is_cancelled() || !current.is_task() {
        return false;
    }
    let patch = EventPatch {
        start: Some(event_time(slot.start, time_zone)),
        end: Some(event_time(slot.end, time_zone)),
        ..EventPatch::default()
    };
    match calendar.patch_event(calendar_id, event_id, &patch).await {
        Ok(_) => true,
        Err(error) => {
            log_lookup_failure(error, "task time not updated");
            false
        }
    }
}

/// `PATCH /api/tasks/{id}`: completes or reopens a task.
///
/// # Errors
///
/// No calendar, or [`AppError::TaskNotFound`] when the change fails.
pub async fn set_completion(
    services: &Services,
    user: &UserId,
    event_id: &EventId,
    completed: bool,
) -> Result<Task, AppError> {
    let settings = calendar_settings(services, user).await?;
    let Some(calendar) = UserCalendar::open(services, user).await? else {
        return Err(AppError::TaskNotFound);
    };
    let updated = update_event_completion(&calendar, &settings.calendar, event_id, completed)
        .await
        .ok_or(AppError::TaskNotFound)?;
    Task::from_event(&updated).ok_or(AppError::UpdatedEventInvalid)
}

/// `POST /api/tasks/{id}/complete`.
///
/// # Errors
///
/// No calendar, or [`AppError::TaskNotFound`].
pub async fn complete_task(
    services: &Services,
    user: &UserId,
    event_id: &EventId,
) -> Result<(), AppError> {
    let settings = calendar_settings(services, user).await?;
    let Some(calendar) = UserCalendar::open(services, user).await? else {
        return Err(AppError::TaskNotFound);
    };
    update_event_completion(&calendar, &settings.calendar, event_id, true)
        .await
        .map(|_| ())
        .ok_or(AppError::TaskNotFound)
}

/// `POST /api/tasks/bulk-complete`: completes each task. A task that fails
/// does not stop the others, and the answer is a success, like on the Node
/// server.
///
/// # Errors
///
/// No calendar.
pub async fn bulk_complete(
    services: &Services,
    user: &UserId,
    ids: &[EventId],
) -> Result<(), AppError> {
    let settings = calendar_settings(services, user).await?;
    let Some(calendar) = UserCalendar::open(services, user).await? else {
        return Ok(());
    };
    for id in ids {
        update_event_completion(&calendar, &settings.calendar, id, true).await;
    }
    Ok(())
}

/// `POST /api/tasks/reload`: checks the calendar setting only. The Node
/// server did nothing else either; the client then reloads the task list.
///
/// # Errors
///
/// No calendar.
pub async fn reload(services: &Services, user: &UserId) -> Result<(), AppError> {
    calendar_settings(services, user).await.map(|_| ())
}

/// `POST /api/tasks/reorder`: gives the tasks the slots of the requested
/// order (`domain::reorder`). A failed move is ignored, like on the Node
/// server.
///
/// # Errors
///
/// No calendar, or no requested task was found.
pub async fn reorder(services: &Services, user: &UserId, ids: &[EventId]) -> Result<(), AppError> {
    let settings = calendar_settings(services, user).await?;
    let calendar = UserCalendar::open(services, user).await?;
    let lookups: Vec<(EventId, TaskLookup)> = match &calendar {
        None => ids
            .iter()
            .map(|id| (id.clone(), TaskLookup::Unavailable))
            .collect(),
        Some(calendar) => {
            stream::iter(ids.iter().cloned())
                .map(|id| {
                    let calendar_id = &settings.calendar;
                    async move {
                        let lookup = match calendar.get_event(calendar_id, &id).await {
                            Ok(event) if event.is_cancelled() => TaskLookup::Deleted,
                            Ok(event) => event
                                .time_range()
                                .map_or(TaskLookup::Unavailable, |(start, end)| {
                                    TaskLookup::Found { start, end }
                                }),
                            Err(GoogleError::NotFound) => TaskLookup::Deleted,
                            Err(error) => {
                                tracing::warn!(reason = google_tag(error), "task event not read");
                                TaskLookup::Unavailable
                            }
                        };
                        (id, lookup)
                    }
                })
                .buffered(PARALLEL_EVENT_READS)
                .collect()
                .await
        }
    };
    let default_duration = u32::try_from(settings.row.default_duration).unwrap_or(0);
    let changes =
        plan_reorder(&lookups, default_duration).map_err(|_| AppError::NoTasksToReorder)?;
    if let Some(calendar) = &calendar {
        for change in changes {
            update_event_time(
                calendar,
                &settings.calendar,
                settings.time_zone(),
                &change.id,
                Slot {
                    start: change.start,
                    end: change.end,
                },
            )
            .await;
        }
    }
    Ok(())
}

/// `POST /api/tasks/{id}/reschedule`: moves one task to the first free slot.
///
/// # Errors
///
/// No calendar, a missing task, no free slot, or a Google failure in the
/// slot search.
pub async fn reschedule_task(
    services: &Services,
    user: &UserId,
    event_id: &EventId,
) -> Result<(), AppError> {
    let settings = calendar_settings(services, user).await?;
    reschedule_event(services, user, &settings, event_id).await
}

/// Moves one task event of `settings.calendar` to the first free slot.
pub(super) async fn reschedule_event(
    services: &Services,
    user: &UserId,
    settings: &CalendarSettings,
    event_id: &EventId,
) -> Result<(), AppError> {
    // Without calendar access the Node lookup gave null: "Task not found".
    let Some(calendar) = UserCalendar::open(services, user).await? else {
        return Err(AppError::TaskNotFound);
    };
    let event = match calendar.get_event(&settings.calendar, event_id).await {
        Ok(event) if !event.is_cancelled() => event,
        Ok(_) => return Err(AppError::TaskNotFound),
        Err(error) => {
            log_lookup_failure(error, "task to reschedule not read");
            return Err(AppError::TaskNotFound);
        }
    };
    let (start, end) = event.time_range().ok_or(AppError::TaskNotFound)?;
    let minutes =
        caltodo_domain::instant::round_minutes(end.as_millisecond() - start.as_millisecond())
            .max(1);
    let slot = find_free_slot(services, &calendar, settings, minutes, None, false, None)
        .await?
        .ok_or(AppError::NoFreeSlot)?;
    if update_event_time(
        &calendar,
        &settings.calendar,
        settings.time_zone(),
        event_id,
        slot,
    )
    .await
    {
        Ok(())
    } else {
        Err(AppError::TaskNotFound)
    }
}

/// "Reschedule all" (`rescheduleAllUserTasks`): moves every incomplete task
/// from 7 days ago to 90 days ahead into the earliest free slots, the
/// `priority` ids first. No settings or no calendar access is an empty
/// summary, like on the Node server.
///
/// # Errors
///
/// Google fails to list the events (the Node server then reported an empty
/// summary, or scheduled over busy events when a later search failed).
pub async fn reschedule_all(
    services: &Services,
    user: &UserId,
    priority: &[String],
) -> Result<RescheduleSummary, AppError> {
    let mut summary = RescheduleSummary::default();
    let settings = match calendar_settings(services, user).await {
        Ok(settings) => settings,
        Err(AppError::NoCalendar) => return Ok(summary),
        Err(error) => return Err(error),
    };
    let Some(calendar) = UserCalendar::open(services, user).await? else {
        return Ok(summary);
    };
    let now = services.clock.now();
    let window_start = services.add_days(now, -RESCHEDULE_DAYS_BEFORE);
    let window_end = services.add_days(now, DAYS_AHEAD);
    let window_events = calendar
        .list_events(&settings.calendar, window_start, window_end)
        .await?;
    let prefetched = Prefetched {
        events: &window_events,
        time_min: window_start,
        time_max: window_end,
    };

    let mut last_slot_end: Option<Timestamp> = None;
    for event in reschedule_order(&window_events, priority) {
        let (Some(id), Some((start, end))) =
            (event.task_id().and_then(EventId::new), event.time_range())
        else {
            summary.skipped_invalid += 1;
            continue;
        };
        let duration = duration_minutes(start, end)
            .filter(|minutes| *minutes != 0)
            .unwrap_or_else(|| i64::from(settings.row.default_duration));
        let Some(slot) = find_free_slot(
            services,
            &calendar,
            &settings,
            duration,
            last_slot_end,
            true,
            Some(prefetched),
        )
        .await?
        else {
            summary.skipped_no_slot += 1;
            continue;
        };
        if slot_matches(start, &slot) {
            last_slot_end = Some(end);
            summary.unchanged += 1;
            continue;
        }
        if !update_event_time(
            &calendar,
            &settings.calendar,
            settings.time_zone(),
            &id,
            slot,
        )
        .await
        {
            summary.failed += 1;
            continue;
        }
        summary.moved += 1;
        last_slot_end = Some(slot.end);
    }
    Ok(summary)
}

/// The calendars of the user (`GET /api/calendars`).
///
/// # Errors
///
/// No calendar access, or Google fails (the Node server answered an empty
/// list in both cases).
pub async fn list_calendars(
    services: &Services,
    user: &UserId,
) -> Result<Vec<super::ports::CalendarSummary>, AppError> {
    let calendar = open_calendar(services, user).await?;
    Ok(calendar.list_calendars().await?)
}

/// The parts of the action routes that reuse the task rules.
pub(super) mod action_support {
    use super::{
        AppError, CalendarId, CalendarSettings, EventId, Services, UserCalendar, UserId,
        refresh_event_actions, update_event_completion,
    };

    /// Completes the event; [`AppError::TaskNotFound`] when that fails.
    pub async fn complete(
        calendar: &UserCalendar<'_>,
        calendar_id: &CalendarId,
        event: &EventId,
    ) -> Result<(), AppError> {
        update_event_completion(calendar, calendar_id, event, true)
            .await
            .map(|_| ())
            .ok_or(AppError::TaskNotFound)
    }

    /// Moves the event to the first free slot.
    pub async fn reschedule(
        services: &Services,
        user: &UserId,
        settings: &CalendarSettings,
        event: &EventId,
    ) -> Result<(), AppError> {
        super::reschedule_event(services, user, settings, event).await
    }

    /// Writes a new action link into the event.
    pub async fn refresh_actions(
        services: &Services,
        calendar: &UserCalendar<'_>,
        user: &UserId,
        calendar_id: &CalendarId,
        event: &EventId,
        details: Option<&str>,
    ) {
        refresh_event_actions(services, calendar, user, calendar_id, event, details).await;
    }
}
