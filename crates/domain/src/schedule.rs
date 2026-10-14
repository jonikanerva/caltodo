//! The free-slot search and the reschedule rules (`server/scheduler.ts` and
//! `server/calendar.ts`).
//!
//! A slot starts on a quarter hour, on a weekday, inside the work hours of
//! the user's time zone, and overlaps no busy calendar event. The search
//! returns the earliest such slot before the end of the search window.
//!
//! The Node server computed the local time with `Intl` and moved between
//! days with fixed 24-hour steps and a correction in the process time zone.
//! Across a daylight saving time change on a weekday, that code could choose
//! a slot an hour off, and in some inputs it never returned. This search
//! uses Jiff zoned arithmetic instead. `tests/find_slot_golden.rs` compares
//! both and lists every difference.

use jiff::civil::{Date, Weekday};
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};
use serde::Serialize;

use crate::event::CalendarEvent;
use crate::settings::WorkHour;

/// A busy period of the calendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusyInterval {
    pub start: Timestamp,
    pub end: Timestamp,
}

/// A free slot for a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    pub start: Timestamp,
    pub end: Timestamp,
}

/// The work hours of a user in the user's time zone.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkSchedule {
    pub zone: TimeZone,
    pub start_hour: WorkHour,
    /// A task must end at this hour at the latest.
    pub end_hour: WorkHour,
}

const QUARTER_HOUR_MS: i64 = 15 * 60 * 1000;

/// The start of the search: the time with its seconds removed and its
/// minutes rounded up to a multiple of 15 (`roundToNextQuarterHour`).
///
/// This keeps a quirk of the Node server: a time in the first minute of a
/// quarter hour rounds down, for example 10:00:30 to 10:00:00. Every time
/// zone offset in use is a multiple of 15 minutes, so the rounding of the
/// UTC time equals the rounding of the local time.
#[must_use]
pub fn round_to_quarter_hour(instant: Timestamp) -> Timestamp {
    let whole_minutes = instant.as_millisecond().div_euclid(60_000) * 60_000;
    let minutes_in_quarter = whole_minutes.rem_euclid(QUARTER_HOUR_MS);
    let rounded = if minutes_in_quarter == 0 {
        whole_minutes
    } else {
        whole_minutes - minutes_in_quarter + QUARTER_HOUR_MS
    };
    Timestamp::from_millisecond(rounded).unwrap_or(instant)
}

/// The first quarter hour at or after `instant`.
#[must_use]
pub fn quarter_hour_at_or_after(instant: Timestamp) -> Timestamp {
    let millis = instant.as_millisecond();
    let remainder = millis.rem_euclid(QUARTER_HOUR_MS);
    if remainder == 0 {
        return instant;
    }
    Timestamp::from_millisecond(millis - remainder + QUARTER_HOUR_MS).unwrap_or(instant)
}

/// The earliest free slot of `duration_minutes` that starts at or after the
/// rounded `start` and before `search_end`.
///
/// Intervals whose end is not after their start are ignored.
#[must_use]
pub fn find_slot(
    busy: &[BusyInterval],
    duration_minutes: u32,
    schedule: &WorkSchedule,
    start: Timestamp,
    search_end: Timestamp,
) -> Option<Slot> {
    if duration_minutes == 0 {
        return None;
    }
    let mut intervals: Vec<BusyInterval> = busy
        .iter()
        .copied()
        .filter(|interval| interval.end > interval.start)
        .collect();
    intervals.sort_by_key(|interval| interval.start);

    let duration = SignedDuration::from_mins(i64::from(duration_minutes));
    let work_start = i64::from(schedule.start_hour.get()) * 60;
    let work_end = i64::from(schedule.end_hour.get()) * 60;
    let mut index = 0;
    let mut current = round_to_quarter_hour(start);

    while current < search_end {
        let local = current.to_zoned(schedule.zone.clone());
        let date = local.date();
        let next = if matches!(local.weekday(), Weekday::Saturday | Weekday::Sunday) {
            work_start_on(date.tomorrow().ok()?, schedule)?
        } else {
            let minutes = i64::from(local.hour()) * 60 + i64::from(local.minute());
            if minutes < work_start {
                work_start_on(date, schedule)?
            } else if minutes + i64::from(duration_minutes) > work_end {
                work_start_on(date.tomorrow().ok()?, schedule)?
            } else {
                let slot_end = current.checked_add(duration).ok()?;
                while intervals
                    .get(index)
                    .is_some_and(|interval| interval.end <= current)
                {
                    index += 1;
                }
                match intervals.get(index) {
                    Some(interval) if interval.start < slot_end && interval.end > current => {
                        quarter_hour_at_or_after(interval.end)
                    }
                    _ => {
                        return Some(Slot {
                            start: current,
                            end: slot_end,
                        });
                    }
                }
            }
        };
        // Every step moves forward, so the loop ends at `search_end`. The
        // guard keeps that true even for a time zone rule that maps a later
        // wall-clock time to an earlier instant.
        current = if next > current {
            next
        } else {
            current.checked_add(SignedDuration::from_mins(15)).ok()?
        };
    }
    None
}

/// The start of the work day on `date`. A start hour inside a daylight
/// saving gap resolves to the first instant after the gap.
fn work_start_on(date: Date, schedule: &WorkSchedule) -> Option<Timestamp> {
    let start_hour = i8::try_from(schedule.start_hour.get()).ok()?;
    date.at(start_hour, 0, 0, 0)
        .to_zoned(schedule.zone.clone())
        .ok()
        .map(|zoned| zoned.timestamp())
}

/// The busy intervals for a search (`findFreeSlot`): the timed busy events.
///
/// A reschedule ignores every task event, because it moves them. A new task
/// ignores only the completed task events.
#[must_use]
pub fn busy_intervals(events: &[CalendarEvent], ignore_all_tasks: bool) -> Vec<BusyInterval> {
    events
        .iter()
        .filter(|event| {
            if ignore_all_tasks {
                !event.is_task()
            } else {
                !event.is_completed_task()
            }
        })
        .filter(|event| event.is_busy())
        .filter_map(|event| {
            event
                .time_range()
                .map(|(start, end)| BusyInterval { start, end })
        })
        .collect()
}

/// The tasks that "Reschedule all" moves, in their order: the incomplete
/// timed task events, first the `priority` ids in the given order, then the
/// others by start time (`rescheduleAllUserTasks`).
#[must_use]
pub fn reschedule_order<'a>(
    events: &'a [CalendarEvent],
    priority: &[String],
) -> Vec<&'a CalendarEvent> {
    let tasks: Vec<&CalendarEvent> = events
        .iter()
        .filter(|event| event.is_task())
        .filter(|event| event.completion() != Some(true))
        .filter(|event| event.task_id().is_some() && event.time_range().is_some())
        .collect();
    let mut ordered: Vec<&CalendarEvent> = priority
        .iter()
        .filter_map(|id| {
            tasks
                .iter()
                .copied()
                .find(|event| event.task_id() == Some(id.as_str()))
        })
        .collect();
    let mut remaining: Vec<&CalendarEvent> = tasks
        .into_iter()
        .filter(|event| {
            !priority
                .iter()
                .any(|id| event.task_id() == Some(id.as_str()))
        })
        .collect();
    remaining.sort_by_key(|event| event.start);
    ordered.extend(remaining);
    ordered
}

/// True when the found slot is the current position of the task: the starts
/// differ by less than one minute.
#[must_use]
pub fn slot_matches(current_start: Timestamp, slot: &Slot) -> bool {
    (current_start.as_millisecond() - slot.start.as_millisecond()).abs() < 60_000
}

/// The outcome counters of "Reschedule all".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescheduleSummary {
    pub moved: u32,
    pub unchanged: u32,
    pub skipped_no_slot: u32,
    pub skipped_invalid: u32,
    pub failed: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    fn utc_schedule(start: u8, end: u8) -> WorkSchedule {
        WorkSchedule {
            zone: TimeZone::UTC,
            start_hour: WorkHour::new(start).unwrap(),
            end_hour: WorkHour::new(end).unwrap(),
        }
    }

    #[test]
    fn rounds_like_the_node_server() {
        assert_eq!(
            round_to_quarter_hour(ts("2026-03-02T10:00:30Z")),
            ts("2026-03-02T10:00:00Z")
        );
        assert_eq!(
            round_to_quarter_hour(ts("2026-03-02T10:01:00Z")),
            ts("2026-03-02T10:15:00Z")
        );
        assert_eq!(
            round_to_quarter_hour(ts("2026-03-02T10:46:59.999Z")),
            ts("2026-03-02T11:00:00Z")
        );
        assert_eq!(
            quarter_hour_at_or_after(ts("2026-03-02T10:00:30Z")),
            ts("2026-03-02T10:15:00Z")
        );
    }

    #[test]
    fn finds_the_next_slot_after_a_busy_window() {
        let busy = [BusyInterval {
            start: ts("2026-03-02T09:00:00Z"),
            end: ts("2026-03-02T09:30:00Z"),
        }];
        let slot = find_slot(
            &busy,
            30,
            &utc_schedule(9, 17),
            ts("2026-03-02T09:00:00Z"),
            ts("2026-03-03T09:00:00Z"),
        )
        .unwrap();
        assert_eq!(slot.start, ts("2026-03-02T09:30:00Z"));
        assert_eq!(slot.end, ts("2026-03-02T10:00:00Z"));
    }

    #[test]
    fn skips_the_weekend() {
        let slot = find_slot(
            &[],
            30,
            &utc_schedule(9, 17),
            ts("2026-03-01T12:00:00Z"),
            ts("2026-03-10T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(slot.start, ts("2026-03-02T09:00:00Z"));
    }

    /// The Node search never returned when a busy event ended within the
    /// first minute of a quarter hour, because it rounded that end down.
    #[test]
    fn a_busy_end_with_seconds_moves_to_the_next_quarter_hour() {
        let busy = [BusyInterval {
            start: ts("2026-03-02T09:00:00Z"),
            end: ts("2026-03-02T09:30:20Z"),
        }];
        let slot = find_slot(
            &busy,
            15,
            &utc_schedule(9, 17),
            ts("2026-03-02T09:00:00Z"),
            ts("2026-03-03T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(slot.start, ts("2026-03-02T09:45:00Z"));
    }

    #[test]
    fn uses_the_wall_clock_across_a_dst_change() {
        // Cairo starts DST on Friday 24 April 2026 at 00:00 (to 01:00).
        let cairo = WorkSchedule {
            zone: TimeZone::get("Africa/Cairo").unwrap(),
            start_hour: WorkHour::new(9).unwrap(),
            end_hour: WorkHour::new(17).unwrap(),
        };
        let slot = find_slot(
            &[],
            60,
            &cairo,
            ts("2026-04-23T15:30:00Z"),
            ts("2026-04-30T00:00:00Z"),
        )
        .unwrap();
        // Friday 09:00 EEST is 06:00 UTC.
        assert_eq!(slot.start, ts("2026-04-24T06:00:00Z"));
    }

    #[test]
    fn a_zero_duration_has_no_slot() {
        assert_eq!(
            find_slot(
                &[],
                0,
                &utc_schedule(9, 17),
                ts("2026-03-02T09:00:00Z"),
                ts("2026-03-03T00:00:00Z")
            ),
            None
        );
    }
}
