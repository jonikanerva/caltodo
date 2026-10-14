//! The daily jobs task (`server/cron.ts`): it runs each job at its local time
//! in the process zone and stops on the stop signal.
//!
//! The clock of these tests starts just before a job time and runs at real
//! speed, so each job runs within a second.

use std::sync::Arc;
use std::time::Duration;

use caltodo::application::jobs;
use caltodo::application::ports::Clock;
use caltodo::config::Secret;
use caltodo::db::sessions::PgSessionStore;
use caltodo::db::settings::SettingsChange;
use caltodo::db::users::NewUser;
use caltodo::fakes::{CalendarCall, FakeCalendar, FakeOAuth};
use caltodo::wiring::{self, Adapters};
use jiff::{SignedDuration, Timestamp};
use sqlx::PgPool;
use tokio::sync::watch;

use crate::support::{settings, task_event, ts};

/// A clock that starts at `base` and runs with the real time.
#[derive(Debug)]
struct RunningClock {
    base: Timestamp,
    start: std::time::Instant,
}

impl Clock for RunningClock {
    fn now(&self) -> Timestamp {
        let elapsed = SignedDuration::try_from(self.start.elapsed()).unwrap();
        self.base + elapsed
    }
}

async fn setup(pool: &PgPool, base: &str) -> (caltodo::application::Services, FakeCalendar) {
    let clock: Arc<dyn Clock> = Arc::new(RunningClock {
        base: ts(base),
        start: std::time::Instant::now(),
    });
    let calendar = FakeCalendar::new(Arc::clone(&clock));
    let adapters = Adapters {
        calendar: Arc::new(calendar.clone()),
        oauth: Arc::new(FakeOAuth::new("/cb")),
        clock,
    };
    // Helsinki: midnight is 22:00 UTC in winter.
    let services = wiring::services(pool.clone(), &settings("Europe/Helsinki"), &adapters);
    let user = services
        .store
        .record_sign_in(
            &NewUser {
                google_id: "sub-job".into(),
                email: String::new(),
                display_name: "J".into(),
            },
            &Secret::new("access"),
            None,
        )
        .await
        .unwrap();
    services
        .store
        .save_settings(
            &user.id,
            &SettingsChange {
                calendar_id: Some("primary".into()),
                work_start_hour: 9,
                work_end_hour: 17,
                timezone: "UTC".into(),
                default_duration: 30,
                event_color: "1".into(),
            },
        )
        .await
        .unwrap();
    (services, calendar)
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_midnight_job_reschedules_and_stops_on_signal(pool: PgPool) {
    let (services, calendar) = setup(&pool, "2026-02-09T21:59:59.300Z").await;
    calendar.put_event(
        "primary",
        task_event(
            "late",
            "Late",
            "2026-02-13T15:00:00Z",
            "2026-02-13T15:30:00Z",
            Some(false),
        ),
    );
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(jobs::run(
        services,
        PgSessionStore::new(pool.clone()),
        stopped,
    ));
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let moved = calendar
        .calls()
        .iter()
        .any(|call| matches!(call, CalendarCall::Patch { event, .. } if event == "late"));
    assert!(moved, "{:?}", calendar.calls());
    // Midnight in Helsinki is Tuesday 00:00 local = 22:00Z; the first slot
    // is Tuesday 09:00 UTC.
    assert_eq!(
        calendar.event("primary", "late").unwrap().start,
        Some(ts("2026-02-10T09:00:00Z"))
    );
    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("the jobs task stops on the signal")
        .unwrap();
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_cleanup_job_deletes_old_tokens_and_sessions(pool: PgPool) {
    let (services, _calendar) = setup(&pool, "2026-02-09T23:14:59.300Z").await;
    sqlx::raw_sql(
        "INSERT INTO action_tokens (token_hash, user_id, event_id, calendar_id, expires_at)
           SELECT 'expired', id, 'e', 'c', '2026-02-01 00:00:00' FROM users;
         INSERT INTO action_tokens (token_hash, user_id, event_id, calendar_id, expires_at)
           SELECT 'live', id, 'e', 'c', '2026-03-01 00:00:00' FROM users;
         INSERT INTO app_sessions (id, data, expiry_date) VALUES
           ('old', '{}', '2026-01-01T00:00:00Z'), ('new', '{}', now() + interval '1 day');",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(jobs::run(
        services,
        PgSessionStore::new(pool.clone()),
        stopped,
    ));
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let tokens: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM action_tokens")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(tokens, ["live"]);
    let sessions: Vec<String> = sqlx::query_scalar("SELECT id FROM app_sessions")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, ["new"]);
    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
}
