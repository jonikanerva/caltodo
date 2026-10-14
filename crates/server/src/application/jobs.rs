//! The daily jobs of the web process (`server/cron.ts`).
//!
//! - 00:00: "Reschedule all" for each user with a calendar.
//! - 01:15: deletion of the expired and the old used action tokens, and of
//!   the expired sessions.
//!
//! The times are wall-clock times of the process time zone (`TZ`), like
//! node-cron without a time zone option. One owned task runs both jobs, one
//! step at a time; a stop signal ends it between steps.

use std::time::Duration;

use jiff::Timestamp;
use jiff::civil::Time;
use jiff::tz::TimeZone;
use tokio::sync::watch;

use super::Services;
use super::tasks::reschedule_all;
use crate::db::sessions::PgSessionStore;

/// The longest "Reschedule all" of one user in the midnight job.
const USER_RESCHEDULE_LIMIT: Duration = Duration::from_secs(120);
/// The longest sleep before the next time check. A wall-clock change (a
/// suspended host, a corrected clock) then delays a job by at most this.
const MAX_SLEEP: Duration = Duration::from_mins(15);
/// The age after which a used action token is deleted.
const USED_TOKEN_RETENTION_DAYS: i64 = 30;

/// A daily job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Job {
    MidnightReschedule,
    TokenCleanup,
}

impl Job {
    /// The local time of the job.
    #[must_use]
    pub fn time(self) -> Time {
        match self {
            Self::MidnightReschedule => Time::midnight(),
            Self::TokenCleanup => Time::constant(1, 15, 0, 0),
        }
    }

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::MidnightReschedule => "midnight_reschedule",
            Self::TokenCleanup => "token_cleanup",
        }
    }
}

/// The first run of a daily job after `now`. A local time in a daylight
/// saving gap runs at the first instant after the gap.
#[must_use]
pub fn next_run(now: Timestamp, zone: &TimeZone, time: Time) -> Timestamp {
    let local = now.to_zoned(zone.clone());
    let mut date = local.date();
    // Two days are enough: today, or tomorrow when today's run has passed.
    for _ in 0..3 {
        if let Ok(run) = date.to_datetime(time).to_zoned(zone.clone())
            && run.timestamp() > now
        {
            return run.timestamp();
        }
        match date.tomorrow() {
            Ok(next) => date = next,
            Err(_) => break,
        }
    }
    now.checked_add(jiff::SignedDuration::from_hours(24))
        .unwrap_or(now)
}

/// The next job and its time.
#[must_use]
pub fn next_job(now: Timestamp, zone: &TimeZone) -> (Job, Timestamp) {
    let midnight = next_run(now, zone, Job::MidnightReschedule.time());
    let cleanup = next_run(now, zone, Job::TokenCleanup.time());
    if midnight <= cleanup {
        (Job::MidnightReschedule, midnight)
    } else {
        (Job::TokenCleanup, cleanup)
    }
}

/// Runs the jobs until `stop` changes. Each job logs its outcome; a failure
/// never stops the loop.
pub async fn run(services: Services, sessions: PgSessionStore, mut stop: watch::Receiver<bool>) {
    loop {
        let now = services.clock.now();
        let (job, at) = next_job(now, &services.process_zone);
        let wait = Duration::try_from(at.duration_since(now))
            .unwrap_or(Duration::ZERO)
            .min(MAX_SLEEP);
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = stop.changed() => return,
        }
        if services.clock.now() < at {
            continue;
        }
        tokio::select! {
            () = run_job(&services, &sessions, job) => {}
            _ = stop.changed() => return,
        }
    }
}

/// Runs one job now.
pub async fn run_job(services: &Services, sessions: &PgSessionStore, job: Job) {
    match job {
        Job::MidnightReschedule => midnight_reschedule(services).await,
        Job::TokenCleanup => token_cleanup(services, sessions).await,
    }
}

async fn midnight_reschedule(services: &Services) {
    let Ok(users) = services.store.users_with_calendar().await else {
        tracing::error!(
            job = "midnight_reschedule",
            reason = "database",
            "job failed"
        );
        return;
    };
    let mut failed = 0_u64;
    for user in &users {
        match tokio::time::timeout(USER_RESCHEDULE_LIMIT, reschedule_all(services, user, &[])).await
        {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                failed += 1;
                tracing::warn!(
                    job = "midnight_reschedule",
                    reason = error.tag(),
                    "reschedule of one user failed"
                );
            }
            Err(_) => {
                failed += 1;
                tracing::warn!(
                    job = "midnight_reschedule",
                    reason = "timeout",
                    "reschedule of one user failed"
                );
            }
        }
    }
    tracing::info!(
        job = "midnight_reschedule",
        users = users.len() as u64,
        failed,
        "job completed"
    );
}

async fn token_cleanup(services: &Services, sessions: &PgSessionStore) {
    let now = services.clock.now();
    let used_before = services.add_days(now, -USED_TOKEN_RETENTION_DAYS);
    if let Ok(deleted) = services.store.cleanup_action_tokens(now, used_before).await {
        tracing::info!(job = "token_cleanup", deleted, "action tokens deleted");
    } else {
        tracing::error!(job = "token_cleanup", reason = "database", "job failed");
    }
    if let Ok(deleted) = sessions.delete_expired(now).await {
        tracing::info!(job = "token_cleanup", deleted, "expired sessions deleted");
    } else {
        tracing::error!(job = "token_cleanup", reason = "database", "job failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn runs_at_local_midnight_and_one_fifteen() {
        let helsinki = TimeZone::get("Europe/Helsinki").unwrap();
        // 21:30 UTC is 23:30 in Helsinki (EET, UTC+2).
        let now = ts("2026-02-09T21:30:00Z");
        assert_eq!(
            next_run(now, &helsinki, Job::MidnightReschedule.time()),
            ts("2026-02-09T22:00:00Z")
        );
        assert_eq!(
            next_run(now, &helsinki, Job::TokenCleanup.time()),
            ts("2026-02-09T23:15:00Z")
        );
        assert_eq!(
            next_job(now, &helsinki),
            (Job::MidnightReschedule, ts("2026-02-09T22:00:00Z"))
        );
        // Just after midnight the next job is the cleanup.
        let after = ts("2026-02-09T22:00:00Z");
        assert_eq!(
            next_job(after, &helsinki),
            (Job::TokenCleanup, ts("2026-02-09T23:15:00Z"))
        );
    }

    #[test]
    fn follows_daylight_saving_time() {
        let new_york = TimeZone::get("America/New_York").unwrap();
        // Saturday 7 March 2026 12:00 EST; DST starts on Sunday at 02:00.
        let now = ts("2026-03-07T17:00:00Z");
        assert_eq!(
            next_run(now, &new_york, Job::MidnightReschedule.time()),
            ts("2026-03-08T05:00:00Z")
        );
        // Monday 00:00 EDT is 04:00 UTC.
        assert_eq!(
            next_run(
                ts("2026-03-08T06:00:00Z"),
                &new_york,
                Job::MidnightReschedule.time()
            ),
            ts("2026-03-09T04:00:00Z")
        );
    }

    #[test]
    fn a_job_time_in_a_gap_runs_after_the_gap() {
        // Cairo moves from 00:00 to 01:00 on Friday 24 April 2026.
        let cairo = TimeZone::get("Africa/Cairo").unwrap();
        let run = next_run(
            ts("2026-04-23T12:00:00Z"),
            &cairo,
            Job::MidnightReschedule.time(),
        );
        assert_eq!(run, ts("2026-04-23T22:00:00Z"));
    }

    #[test]
    fn uses_utc_without_a_zone() {
        assert_eq!(
            next_run(
                ts("2026-02-09T00:00:00Z"),
                &TimeZone::UTC,
                Job::MidnightReschedule.time()
            ),
            ts("2026-02-10T00:00:00Z")
        );
    }
}
