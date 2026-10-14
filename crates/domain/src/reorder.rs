//! The slot swap of `POST /api/tasks/reorder` (`createReorderTasksHandler`).
//!
//! The requested tasks keep the set of time slots that they hold. The first
//! requested task moves to the earliest slot, the second to the next one,
//! and so on. Each task keeps its own duration.

use jiff::{SignedDuration, Timestamp};

use crate::ids::EventId;
use crate::instant::{duration_minutes, round_minutes};

/// What the calendar returned for one requested task id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLookup {
    /// The event is deleted (404, 410, or status `cancelled`).
    Deleted,
    /// The lookup failed, or the event has no start and end time. The task
    /// is skipped.
    Unavailable,
    Found {
        start: Timestamp,
        end: Timestamp,
    },
}

/// One time change of the reorder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotChange {
    pub id: EventId,
    pub start: Timestamp,
    pub end: Timestamp,
}

/// No requested task has a start and end time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("No tasks found to reorder")]
pub struct NoTasksToReorder;

/// The time changes that give the tasks the requested order.
///
/// # Errors
///
/// [`NoTasksToReorder`] when no requested task was found.
pub fn plan_reorder(
    requested: &[(EventId, TaskLookup)],
    default_duration_minutes: u32,
) -> Result<Vec<SlotChange>, NoTasksToReorder> {
    let found: Vec<(&EventId, Timestamp, Timestamp)> = requested
        .iter()
        .filter_map(|(id, lookup)| match lookup {
            TaskLookup::Found { start, end } => Some((id, *start, *end)),
            TaskLookup::Deleted | TaskLookup::Unavailable => None,
        })
        .collect();
    if found.is_empty() {
        return Err(NoTasksToReorder);
    }
    let mut slots: Vec<Timestamp> = found.iter().map(|(_, start, _)| *start).collect();
    slots.sort();

    Ok(found
        .iter()
        .zip(slots)
        .filter(|((_, start, _), slot_start)| start != slot_start)
        .map(|((id, start, end), slot_start)| {
            // `durationMinutes || Math.round(diff / 60000) || defaultDuration`:
            // a negative rounded difference is truthy in JavaScript.
            let minutes = duration_minutes(*start, *end)
                .or_else(|| {
                    Some(round_minutes(end.as_millisecond() - start.as_millisecond()))
                        .filter(|minutes| *minutes != 0)
                })
                .unwrap_or_else(|| i64::from(default_duration_minutes));
            SlotChange {
                id: (*id).clone(),
                start: slot_start,
                end: slot_start
                    .checked_add(SignedDuration::from_mins(minutes))
                    .unwrap_or(slot_start),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    fn id(text: &str) -> EventId {
        EventId::new(text).unwrap()
    }

    #[test]
    fn swaps_two_slots() {
        let changes = plan_reorder(
            &[
                (
                    id("t1"),
                    TaskLookup::Found {
                        start: ts("2026-02-10T10:00:00Z"),
                        end: ts("2026-02-10T10:30:00Z"),
                    },
                ),
                (
                    id("t2"),
                    TaskLookup::Found {
                        start: ts("2026-02-10T09:00:00Z"),
                        end: ts("2026-02-10T09:30:00Z"),
                    },
                ),
            ],
            30,
        )
        .unwrap();
        assert_eq!(
            changes,
            vec![
                SlotChange {
                    id: id("t1"),
                    start: ts("2026-02-10T09:00:00Z"),
                    end: ts("2026-02-10T09:30:00Z"),
                },
                SlotChange {
                    id: id("t2"),
                    start: ts("2026-02-10T10:00:00Z"),
                    end: ts("2026-02-10T10:30:00Z"),
                },
            ]
        );
    }

    #[test]
    fn fails_without_found_tasks() {
        assert_eq!(
            plan_reorder(&[(id("t1"), TaskLookup::Deleted)], 30),
            Err(NoTasksToReorder)
        );
        assert_eq!(plan_reorder(&[], 30), Err(NoTasksToReorder));
    }

    #[test]
    fn a_zero_length_task_takes_the_default_duration() {
        let start = ts("2026-02-10T10:00:00Z");
        let changes = plan_reorder(
            &[
                (id("a"), TaskLookup::Found { start, end: start }),
                (
                    id("b"),
                    TaskLookup::Found {
                        start: ts("2026-02-10T09:00:00Z"),
                        end: ts("2026-02-10T09:30:00Z"),
                    },
                ),
            ],
            45,
        )
        .unwrap();
        assert_eq!(changes[0].end, ts("2026-02-10T09:45:00Z"));
    }
}
