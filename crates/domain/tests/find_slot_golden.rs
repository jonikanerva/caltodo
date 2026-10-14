//! The free-slot search against the Node server (golden differential test).
//!
//! `fixtures/find_slot.golden.json` holds 640 inputs and the result of the
//! Node `findSlotFromBusyIntervals` for each one, generated with the process
//! time zone UTC (`script/node-fixtures/core.fixtures.ts` at the commit that
//! adds the fixture). Half of the inputs fall in weeks with a daylight saving
//! time change.
//!
//! Each case checks two things:
//!
//! 1. The Rust search equals an independent brute-force reading of the rule:
//!    the first quarter hour on the 15-minute grid from the rounded start
//!    that is on a weekday, inside the work hours of the local wall clock,
//!    and free of busy events.
//! 2. The Rust search equals the Node result, except for the cases in
//!    [`DOCUMENTED_DIFFERENCES`]. In each listed case the Node result breaks
//!    the rule of check 1, so the difference is the fix of a Node defect.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers of this test binary fail a check by panicking"
)]

use caltodo_domain::schedule::{
    BusyInterval, Slot, WorkSchedule, find_slot, round_to_quarter_hour,
};
use caltodo_domain::settings::WorkHour;
use jiff::civil::Weekday;
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    process_time_zone: String,
    cases: Vec<Case>,
    durations: Vec<DurationCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: u32,
    timezone: String,
    work_start_hour: u8,
    work_end_hour: u8,
    duration_minutes: u32,
    start_ms: i64,
    search_end_ms: i64,
    busy: Vec<(i64, i64)>,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Expected {
    Slot(i64, i64),
    NoSlot(()),
    /// The Node search did not return (`no_progress`).
    NoProgress(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DurationCase {
    start_ms: i64,
    end_ms: i64,
    minutes: Option<i64>,
}

/// The cases where the Rust result differs from the Node result, and why.
/// The test fails when this list and the actual differences disagree.
const DOCUMENTED_DIFFERENCES: &[(u32, &str)] = &[
    (
        389,
        "Node never returns: Africa/Cairo, work hours 00-00, the start hour falls into the DST gap \
         and the day step does not move forward. Rust: no slot, because 180 minutes never fit.",
    ),
    (
        555,
        "Node never returns: Australia/Lord_Howe, work hours 00-04, a 479-minute task never fits \
         and the day step across the 30-minute DST change does not move forward. Rust: no slot.",
    ),
    (
        1000,
        "DST fix: Asia/Jerusalem starts DST on Friday 27 March 2026 at 02:00. Node adds 8 hours \
         to 01:00 and schedules 10:00 local (07:00Z). Rust: 09:00 local (06:00Z).",
    ),
    (
        1001,
        "DST fix: the same change with work start 03:00. Node: 04:00 local. Rust: 03:00 local.",
    ),
    (
        1003,
        "Node never returns: a busy event ends 20 seconds into a quarter hour, and the Node \
         rounding moves the search back to the start of that quarter hour. Rust: the next \
         quarter hour after the busy end.",
    ),
    (
        1007,
        "Node never returns: the regression input of case 389 with a fixed start. Rust: no slot.",
    ),
];

fn ts(millis: i64) -> Timestamp {
    Timestamp::from_millisecond(millis).unwrap()
}

fn schedule(case: &Case) -> WorkSchedule {
    WorkSchedule {
        zone: TimeZone::get(&case.timezone).unwrap(),
        start_hour: WorkHour::new(case.work_start_hour).unwrap(),
        end_hour: WorkHour::new(case.work_end_hour).unwrap(),
    }
}

fn busy(case: &Case) -> Vec<BusyInterval> {
    case.busy
        .iter()
        .map(|(start, end)| BusyInterval {
            start: ts(*start),
            end: ts(*end),
        })
        .collect()
}

/// The brute-force reading of the slot rule.
fn oracle(case: &Case) -> Option<Slot> {
    let schedule = schedule(case);
    let busy = busy(case);
    let duration = SignedDuration::from_mins(i64::from(case.duration_minutes));
    let work_start = i64::from(case.work_start_hour) * 60;
    let work_end = i64::from(case.work_end_hour) * 60;
    let search_end = ts(case.search_end_ms);
    let mut candidate = round_to_quarter_hour(ts(case.start_ms));
    while candidate < search_end {
        let local = candidate.to_zoned(schedule.zone.clone());
        let minutes = i64::from(local.hour()) * 60 + i64::from(local.minute());
        let weekday = !matches!(local.weekday(), Weekday::Saturday | Weekday::Sunday);
        let end = candidate + duration;
        let free = busy
            .iter()
            .filter(|interval| interval.end > interval.start)
            .all(|interval| !(interval.start < end && interval.end > candidate));
        if weekday
            && minutes >= work_start
            && minutes + i64::from(case.duration_minutes) <= work_end
            && free
        {
            return Some(Slot {
                start: candidate,
                end,
            });
        }
        candidate += SignedDuration::from_mins(15);
    }
    None
}

/// The Node outcome of a case.
#[derive(Debug, PartialEq, Eq)]
enum NodeOutcome {
    Returned(Option<Slot>),
    NoProgress,
}

fn node_result(case: &Case) -> NodeOutcome {
    match &case.expected {
        Expected::Slot(start, end) => NodeOutcome::Returned(Some(Slot {
            start: ts(*start),
            end: ts(*end),
        })),
        Expected::NoSlot(()) => NodeOutcome::Returned(None),
        Expected::NoProgress(text) => {
            assert_eq!(text, "no_progress");
            NodeOutcome::NoProgress
        }
    }
}

fn load() -> Golden {
    serde_json::from_str(include_str!("fixtures/find_slot.golden.json")).unwrap()
}

#[test]
fn the_fixture_comes_from_a_utc_process() {
    let golden = load();
    assert_eq!(golden.process_time_zone, "UTC");
    assert_eq!(golden.cases.len(), 648);
}

#[test]
fn the_search_follows_the_slot_rule_in_every_case() {
    let mut wrong = Vec::new();
    for case in load().cases {
        let actual = find_slot(
            &busy(&case),
            case.duration_minutes,
            &schedule(&case),
            ts(case.start_ms),
            ts(case.search_end_ms),
        );
        if actual != oracle(&case) {
            wrong.push(case.id);
        }
    }
    assert_eq!(wrong, Vec::<u32>::new());
}

#[test]
fn the_search_equals_the_node_search_except_documented_fixes() {
    let mut differences = Vec::new();
    for case in load().cases {
        let actual = find_slot(
            &busy(&case),
            case.duration_minutes,
            &schedule(&case),
            ts(case.start_ms),
            ts(case.search_end_ms),
        );
        let node = node_result(&case);
        if node != NodeOutcome::Returned(actual) {
            // A difference is only acceptable where the Node result breaks
            // the rule.
            assert_ne!(
                node,
                NodeOutcome::Returned(oracle(&case)),
                "case {}",
                case.id
            );
            differences.push((case.id, case.timezone.clone(), node, actual));
        }
    }
    let ids: Vec<u32> = differences.iter().map(|(id, ..)| *id).collect();
    let documented: Vec<u32> = DOCUMENTED_DIFFERENCES.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, documented, "{differences:#?}");
}

#[test]
fn durations_round_like_the_node_server() {
    for case in load().durations {
        assert_eq!(
            caltodo_domain::instant::duration_minutes(ts(case.start_ms), ts(case.end_ms)),
            case.minutes,
            "{case:?}"
        );
    }
}
