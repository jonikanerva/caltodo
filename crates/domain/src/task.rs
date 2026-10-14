//! A task: a calendar event of this app, read as a list item.

use jiff::Timestamp;

use crate::event::{CalendarEvent, extract_details, strip_title_prefix};
use crate::ids::EventId;
use crate::instant::duration_minutes;

/// A task (`mapCalendarEventToTask`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: EventId,
    /// The event title without the task prefix.
    pub title: String,
    pub details: Option<String>,
    /// Whole minutes; `None` when the end is not after the start.
    pub duration_minutes: Option<i64>,
    pub scheduled_start: Timestamp,
    pub scheduled_end: Timestamp,
    pub completed: bool,
    /// The last change of the event, or its end without one. `None` for an
    /// incomplete task.
    pub completed_at: Option<Timestamp>,
    /// The position in the list of incomplete tasks; 0 until the list is
    /// ordered.
    pub priority: usize,
}

impl Task {
    /// The task of an event: `None` for an event of another app, an event
    /// without an id, and an event without a start and end time.
    #[must_use]
    pub fn from_event(event: &CalendarEvent) -> Option<Self> {
        let id = EventId::new(event.task_id()?)?;
        let (start, end) = event.time_range()?;
        if !event.is_task() {
            return None;
        }
        let completed = event.completion() == Some(true);
        Some(Self {
            id,
            title: strip_title_prefix(event.summary.as_deref().unwrap_or_default()).to_owned(),
            details: extract_details(event.description.as_deref()),
            duration_minutes: duration_minutes(start, end),
            scheduled_start: start,
            scheduled_end: end,
            completed,
            completed_at: completed.then(|| event.updated.unwrap_or(end)),
            priority: 0,
        })
    }
}

/// The order of `GET /api/tasks`: the incomplete tasks by start time with
/// their index as the priority, then the completed tasks, most recent first.
/// Tasks with equal keys keep their calendar order.
#[must_use]
pub fn order_task_list(tasks: Vec<Task>) -> Vec<Task> {
    let (mut completed, mut open): (Vec<Task>, Vec<Task>) =
        tasks.into_iter().partition(|task| task.completed);
    open.sort_by_key(|task| task.scheduled_start);
    for (index, task) in open.iter_mut().enumerate() {
        task.priority = index;
    }
    completed.sort_by_key(|task| std::cmp::Reverse(completion_key(task)));
    open.extend(completed);
    open
}

fn completion_key(task: &Task) -> Timestamp {
    task.completed_at.unwrap_or(task.scheduled_end)
}
