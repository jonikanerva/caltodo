//! The queries on PostgreSQL (`server/storage.test.ts` and new cases).

use caltodo::config::Secret;
use caltodo::db::Store;
use caltodo::db::action_tokens::NewActionToken;
use caltodo::db::sessions::PgSessionStore;
use caltodo::db::settings::SettingsChange;
use caltodo::db::users::NewUser;
use caltodo::domain::ids::{CalendarId, EventId, UserId};
use caltodo::security::token_cipher::TokenCipher;
use jiff::{SignedDuration, Timestamp};
use sqlx::PgPool;
use tower_sessions::SessionStore as _;
use tower_sessions::session::{Id, Record};

use crate::support::ts;

const KEY: &str = "storage-test-token-encryption-key-0123456789";

fn store(pool: &PgPool) -> Store {
    Store::new(pool.clone(), TokenCipher::new(&Secret::new(KEY)))
}

fn profile(sub: &str) -> NewUser {
    NewUser {
        google_id: sub.to_owned(),
        email: format!("{sub}@example.com"),
        display_name: format!("User {sub}"),
    }
}

async fn raw_tokens(pool: &PgPool, id: &UserId) -> (Option<String>, Option<String>) {
    sqlx::query_as("SELECT access_token, refresh_token FROM users WHERE id = $1")
        .bind(id.as_str())
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_new_user_gets_encrypted_tokens_and_default_settings(pool: PgPool) {
    let store = store(&pool);
    let user = store
        .record_sign_in(
            &profile("sub-1"),
            &Secret::new("access-1"),
            Some(&Secret::new("refresh-1")),
        )
        .await
        .unwrap();
    assert_eq!(user.google_id, "sub-1");
    assert_eq!(
        user.access_token.as_ref().map(Secret::expose),
        Some("access-1")
    );
    let (access, refresh) = raw_tokens(&pool, &user.id).await;
    assert!(access.unwrap().starts_with("enc:v1:"));
    assert!(refresh.unwrap().starts_with("enc:v1:"));

    let settings = store.settings(&user.id).await.unwrap().unwrap();
    assert_eq!(settings.calendar_id, None);
    assert_eq!((settings.work_start_hour, settings.work_end_hour), (9, 17));
    assert_eq!(settings.timezone, "America/New_York");
    assert_eq!(settings.default_duration, 60);
    assert_eq!(settings.event_color, "1");
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn a_returning_user_keeps_the_refresh_token_without_a_new_one(pool: PgPool) {
    let store = store(&pool);
    let first = store
        .record_sign_in(
            &profile("sub-1"),
            &Secret::new("access-1"),
            Some(&Secret::new("refresh-1")),
        )
        .await
        .unwrap();
    let second = store
        .record_sign_in(&profile("sub-1"), &Secret::new("access-2"), None)
        .await
        .unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(
        second.access_token.as_ref().map(Secret::expose),
        Some("access-2")
    );
    assert_eq!(
        second.refresh_token.as_ref().map(Secret::expose),
        Some("refresh-1")
    );
    // The profile fields stay as stored (the Node server updated tokens only).
    assert_eq!(second.email, "sub-1@example.com");
    let third = store
        .record_sign_in(
            &profile("sub-1"),
            &Secret::new("access-3"),
            Some(&Secret::new("refresh-3")),
        )
        .await
        .unwrap();
    assert_eq!(
        third.refresh_token.as_ref().map(Secret::expose),
        Some("refresh-3")
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_settings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn reads_legacy_plaintext_and_drops_damaged_tokens(pool: PgPool) {
    sqlx::query(
        "INSERT INTO users (id, google_id, email, display_name, access_token, refresh_token)
         VALUES ('u1', 'sub-1', '', 'User', 'ya29.legacy', 'enc:v1:bad:value:x')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let user = store(&pool)
        .user(&UserId::new("u1").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        user.access_token.as_ref().map(Secret::expose),
        Some("ya29.legacy")
    );
    assert_eq!(user.refresh_token, None);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn settings_upsert_keeps_the_calendar_without_a_new_one(pool: PgPool) {
    let store = store(&pool);
    let user = store
        .record_sign_in(&profile("sub-1"), &Secret::new("a"), None)
        .await
        .unwrap();
    let change = |calendar: Option<&str>| SettingsChange {
        calendar_id: calendar.map(str::to_owned),
        work_start_hour: 8,
        work_end_hour: 16,
        timezone: "Europe/Helsinki".to_owned(),
        default_duration: 45,
        event_color: "5".to_owned(),
    };
    let saved = store
        .save_settings(&user.id, &change(Some("primary")))
        .await
        .unwrap();
    assert_eq!(saved.calendar_id.as_deref(), Some("primary"));
    let kept = store.save_settings(&user.id, &change(None)).await.unwrap();
    assert_eq!(kept.calendar_id.as_deref(), Some("primary"));
    assert_eq!(kept.timezone, "Europe/Helsinki");
    assert_eq!(kept.default_duration, 45);
    assert_eq!(kept.id, saved.id);

    // Without a settings row the save creates one; no calendar then.
    sqlx::query("DELETE FROM user_settings")
        .execute(&pool)
        .await
        .unwrap();
    let created = store.save_settings(&user.id, &change(None)).await.unwrap();
    assert_eq!(created.calendar_id, None);
    assert_eq!(created.user_id, user.id.as_str());
}

async fn user(store: &Store, sub: &str) -> UserId {
    store
        .record_sign_in(&profile(sub), &Secret::new("a"), None)
        .await
        .unwrap()
        .id
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn action_tokens_work_once_and_retire_older_tokens(pool: PgPool) {
    let store = store(&pool);
    let user_id = user(&store, "sub-1").await;
    let event = EventId::new("e1").unwrap();
    let calendar = CalendarId::new("primary").unwrap();
    let now = ts("2026-03-02T10:00:00Z");
    let create = |hash: &'static str| {
        let store = store.clone();
        let user_id = user_id.clone();
        let event = event.clone();
        let calendar = calendar.clone();
        async move {
            store
                .create_action_token(&NewActionToken {
                    token_hash: hash,
                    user_id: &user_id,
                    event_id: &event,
                    calendar_id: &calendar,
                    expires_at: now + SignedDuration::from_hours(168),
                })
                .await
                .unwrap()
        }
    };
    let old = create("hash-old").await;
    let new = create("hash-new").await;
    store
        .invalidate_event_tokens(&user_id, &event, &calendar, "hash-new", now)
        .await
        .unwrap();
    let old_record = store
        .action_token_by_hash("hash-old")
        .await
        .unwrap()
        .unwrap();
    assert!(old_record.used);
    let new_record = store
        .action_token_by_hash("hash-new")
        .await
        .unwrap()
        .unwrap();
    assert!(!new_record.used);
    assert_eq!(new_record.expires_at, Some(ts("2026-03-09T10:00:00Z")));
    assert!(store.mark_action_token_used(&new, now).await.unwrap());
    assert!(!store.mark_action_token_used(&new, now).await.unwrap());
    assert!(!store.mark_action_token_used(&old, now).await.unwrap());
    assert!(
        store
            .action_token_by_hash("missing")
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn cleanup_deletes_expired_and_long_used_tokens(pool: PgPool) {
    sqlx::raw_sql(
        "INSERT INTO users (id, google_id, email, display_name) VALUES ('u1', 's', '', 'U');
         INSERT INTO action_tokens (token_hash, user_id, event_id, calendar_id, expires_at, used_at) VALUES
           ('expired', 'u1', 'e', 'c', '2026-03-01 00:00:00', NULL),
           ('live', 'u1', 'e', 'c', '2026-03-09 00:00:00', NULL),
           ('used-long-ago', 'u1', 'e', 'c', '2026-04-09 00:00:00', '2026-01-01 00:00:00'),
           ('used-recently', 'u1', 'e', 'c', '2026-04-09 00:00:00', '2026-02-20 00:00:00')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let deleted = store(&pool)
        .cleanup_action_tokens(ts("2026-03-02T00:00:00Z"), ts("2026-01-31T00:00:00Z"))
        .await
        .unwrap();
    assert_eq!(deleted, 2);
    let left: Vec<String> =
        sqlx::query_scalar("SELECT token_hash FROM action_tokens ORDER BY token_hash")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(left, ["live", "used-recently"]);
}

/// The naive `timestamp` columns hold UTC wall-clock time whatever the
/// process zone is, like the Node server (ADR 0003). The Node server wrote
/// them through drizzle-orm 0.45.1, which writes `Date.toISOString()` and
/// reads `value + "+0000"` (`pg-core/columns/timestamp.js`) and turns off the
/// pg TIMESTAMP parser (`node-postgres/session.js`).
/// `naive_timestamps.golden.json` records the real Node behaviour with
/// `TZ=Europe/Helsinki`. The services here have the same process zone.
#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn naive_timestamps_are_utc_like_the_node_server_in_any_zone(pool: PgPool) {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../fixtures/node/naive_timestamps.golden.json"
    ))
    .unwrap();
    assert_eq!(golden["tz"], "Europe/Helsinki");
    let clock = caltodo::fakes::FixedClock::new(ts("2026-01-01T00:00:00Z"));
    let adapters = caltodo::wiring::Adapters {
        calendar: std::sync::Arc::new(caltodo::fakes::FakeCalendar::new(std::sync::Arc::new(
            clock.clone(),
        ))),
        oauth: std::sync::Arc::new(caltodo::fakes::FakeOAuth::new("/cb")),
        clock: std::sync::Arc::new(clock),
    };
    let services = caltodo::wiring::services(
        pool.clone(),
        &crate::support::settings("Europe/Helsinki"),
        &adapters,
    );
    let helsinki = &services.store;
    let user_id = user(helsinki, "sub-1").await;
    let event = EventId::new("event").unwrap();
    let calendar = CalendarId::new("primary").unwrap();
    let text = |hash: String, column: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, Option<String>>(sqlx::AssertSqlSafe(format!(
                "SELECT {column}::text FROM action_tokens WHERE token_hash = $1"
            )))
            .bind(hash)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };

    // Write: the same stored text as the Node server.
    for write in golden["writes"].as_array().unwrap() {
        let hash = write["hash"].as_str().unwrap();
        helsinki
            .create_action_token(&NewActionToken {
                token_hash: hash,
                user_id: &user_id,
                event_id: &event,
                calendar_id: &calendar,
                expires_at: ts(write["expiresAt"].as_str().unwrap()),
            })
            .await
            .unwrap();
        assert_eq!(
            text(hash.to_owned(), "expires_at").await.as_deref(),
            write["stored"].as_str(),
            "{hash}"
        );
    }
    let used = &golden["used"];
    let used_hash = used["hash"].as_str().unwrap();
    let record = helsinki
        .action_token_by_hash(used_hash)
        .await
        .unwrap()
        .unwrap();
    assert!(
        helsinki
            .mark_action_token_used(&record.id, ts(used["usedAt"].as_str().unwrap()))
            .await
            .unwrap()
    );
    assert_eq!(
        text(used_hash.to_owned(), "used_at").await.as_deref(),
        used["stored"].as_str()
    );

    // Read: a value that the Node server stored is the same instant.
    for read in golden["reads"].as_array().unwrap() {
        let hash = read["hash"].as_str().unwrap();
        sqlx::query(
            "INSERT INTO action_tokens (token_hash, user_id, event_id, calendar_id, expires_at)
             VALUES ($1, $2, 'event', 'primary', $3::timestamp)",
        )
        .bind(hash)
        .bind(user_id.as_str())
        .bind(read["stored"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
        let record = helsinki.action_token_by_hash(hash).await.unwrap().unwrap();
        assert_eq!(
            record.expires_at,
            Some(ts(read["expiresAt"].as_str().unwrap())),
            "{hash}"
        );
    }

    // Cleanup: the same tokens stay.
    let cleanup = &golden["cleanup"];
    helsinki
        .cleanup_action_tokens(
            ts(cleanup["now"].as_str().unwrap()),
            ts(cleanup["usedBefore"].as_str().unwrap()),
        )
        .await
        .unwrap();
    let left: Vec<String> = sqlx::query_scalar(
        "SELECT token_hash FROM action_tokens WHERE token_hash IN ('winter', 'summer') ORDER BY token_hash",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let expected: Vec<String> = cleanup["left"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hash| hash.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(left, expected);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn deletes_all_data_of_one_user(pool: PgPool) {
    let store = store(&pool);
    let gone = user(&store, "sub-gone").await;
    let kept = user(&store, "sub-kept").await;
    for (owner, hash) in [(&gone, "h-gone"), (&kept, "h-kept")] {
        store
            .create_action_token(&NewActionToken {
                token_hash: hash,
                user_id: owner,
                event_id: &EventId::new("e").unwrap(),
                calendar_id: &CalendarId::new("c").unwrap(),
                expires_at: ts("2026-03-09T00:00:00Z"),
            })
            .await
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO app_sessions (id, user_id, data, expiry_date) VALUES
           ('s-gone', $1, '{}', now() + interval '1 day'),
           ('s-kept', $2, '{}', now() + interval '1 day'),
           ('s-anon', NULL, '{}', now() + interval '1 day')",
    )
    .bind(gone.as_str())
    .bind(kept.as_str())
    .execute(&pool)
    .await
    .unwrap();

    store.delete_user_data(&gone).await.unwrap();

    assert!(store.user(&gone).await.unwrap().is_none());
    assert!(store.settings(&gone).await.unwrap().is_none());
    assert!(store.user(&kept).await.unwrap().is_some());
    assert!(store.settings(&kept).await.unwrap().is_some());
    let tokens: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM action_tokens")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(tokens, ["h-kept"]);
    let rust: Vec<String> = sqlx::query_scalar("SELECT id FROM app_sessions ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(rust, ["s-anon", "s-kept"]);
}

fn record(expiry: Timestamp, user: Option<&str>) -> Record {
    let mut data = std::collections::HashMap::new();
    if let Some(user) = user {
        data.insert("user_id".to_owned(), serde_json::json!(user));
    }
    data.insert("csrf_token".to_owned(), serde_json::json!("abc"));
    Record {
        id: Id::default(),
        data,
        expiry_date: time::OffsetDateTime::from_unix_timestamp(expiry.as_second()).unwrap(),
    }
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_session_store_creates_loads_saves_and_deletes(pool: PgPool) {
    let sessions = PgSessionStore::new(pool.clone());
    let future = Timestamp::now() + SignedDuration::from_hours(24);
    let mut session = record(future, Some("u1"));
    sessions.create(&mut session).await.unwrap();
    let loaded = sessions.load(&session.id).await.unwrap().unwrap();
    assert_eq!(loaded.data, session.data);
    assert_eq!(loaded.expiry_date, session.expiry_date);
    let user_column: Option<String> = sqlx::query_scalar("SELECT user_id FROM app_sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(user_column.as_deref(), Some("u1"));

    session.data.remove("user_id");
    sessions.save(&session).await.unwrap();
    let user_column: Option<String> = sqlx::query_scalar("SELECT user_id FROM app_sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(user_column, None);

    // An id that exists makes `create` choose another one.
    let mut duplicate = record(future, None);
    duplicate.id = session.id;
    sessions.create(&mut duplicate).await.unwrap();
    assert_ne!(duplicate.id, session.id);

    sessions.delete(&session.id).await.unwrap();
    assert!(sessions.load(&session.id).await.unwrap().is_none());
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn an_expired_session_does_not_load_and_the_job_deletes_it(pool: PgPool) {
    let sessions = PgSessionStore::new(pool.clone());
    let mut expired = record(Timestamp::now() - SignedDuration::from_hours(1), Some("u1"));
    sessions.create(&mut expired).await.unwrap();
    let mut live = record(Timestamp::now() + SignedDuration::from_hours(1), Some("u2"));
    sessions.create(&mut live).await.unwrap();
    assert!(sessions.load(&expired.id).await.unwrap().is_none());
    assert_eq!(sessions.delete_expired(Timestamp::now()).await.unwrap(), 1);
    assert!(sessions.load(&live.id).await.unwrap().is_some());
}
