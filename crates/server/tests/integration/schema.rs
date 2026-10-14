//! The SQLx baseline against the Drizzle schema of the Node server (ADR 0003).
//!
//! `fixtures/schema/drizzle_schema.snapshot.json` is the catalog snapshot of
//! an empty database after the real Node Drizzle migrator ran its four
//! migrations. `fixtures/drizzle/` holds those four migration files.
//!
//! - An empty database with the SQLx migrations has the same schema.
//! - A database that the Drizzle migrator set up, with data, takes the SQLx
//!   migrations without a change to its tables, rows, or Drizzle ledger. The
//!   only new objects are `_sqlx_migrations` and `app_sessions`.

use caltodo::db::MIGRATOR;
use serde_json::Value;
use sqlx::{PgPool, Row as _};

/// The SQL files are compile-time constants, so SQLx accepts them as safe
/// query text.
const SNAPSHOT_SQL: &str = include_str!("../fixtures/schema/schema_snapshot.sql");
const DRIZZLE_MIGRATIONS: [&str; 4] = [
    include_str!("../fixtures/drizzle/0000_gifted_zemo.sql"),
    include_str!("../fixtures/drizzle/0001_task_indexes.sql"),
    include_str!("../fixtures/drizzle/0002_drop_tasks.sql"),
    include_str!("../fixtures/drizzle/0003_action_tokens.sql"),
];
const BASELINE_SQL: &str = include_str!("../../../../migrations/0001_baseline.sql");

fn drizzle_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../fixtures/schema/drizzle_schema.snapshot.json"
    ))
    .unwrap()
}

async fn snapshot(pool: &PgPool) -> Value {
    let text: String = sqlx::query_scalar(SNAPSHOT_SQL)
        .fetch_one(pool)
        .await
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

/// Runs the Drizzle migrations like drizzle-orm's PostgreSQL migrator: the
/// ledger table, then each file split at `--> statement-breakpoint` in one
/// transaction, then the ledger rows of the Node run.
async fn run_drizzle(pool: &PgPool) {
    let fixture = drizzle_fixture();
    let mut transaction = pool.begin().await.unwrap();
    sqlx::raw_sql(
        r#"CREATE SCHEMA IF NOT EXISTS "drizzle";
           CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
             id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)"#,
    )
    .execute(&mut *transaction)
    .await
    .unwrap();
    for migration in DRIZZLE_MIGRATIONS {
        for statement in migration.split("--> statement-breakpoint") {
            if !statement.trim().is_empty() {
                sqlx::raw_sql(statement)
                    .execute(&mut *transaction)
                    .await
                    .unwrap();
            }
        }
    }
    for row in fixture["drizzleLedger"].as_array().unwrap() {
        sqlx::query(
            r#"INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)"#,
        )
        .bind(row["hash"].as_str().unwrap())
        .bind(row["created_at"].as_str().unwrap().parse::<i64>().unwrap())
        .execute(&mut *transaction)
        .await
        .unwrap();
    }
    transaction.commit().await.unwrap();
}

async fn table_names(pool: &PgPool, schema: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// Rows of every application table as JSON, for before/after comparison.
async fn data(pool: &PgPool) -> Value {
    let mut tables = serde_json::Map::new();
    for (table, query) in [
        (
            "users",
            "SELECT coalesce(json_agg(t ORDER BY t::text), '[]'::json)::text FROM users t",
        ),
        (
            "user_settings",
            "SELECT coalesce(json_agg(t ORDER BY t::text), '[]'::json)::text FROM user_settings t",
        ),
        (
            "action_tokens",
            "SELECT coalesce(json_agg(t ORDER BY t::text), '[]'::json)::text FROM action_tokens t",
        ),
        (
            "user_sessions",
            "SELECT coalesce(json_agg(t ORDER BY t::text), '[]'::json)::text FROM user_sessions t",
        ),
    ] {
        let rows: Vec<Value> = sqlx::query(query)
            .fetch_one(pool)
            .await
            .map(|row| serde_json::from_str(&row.get::<String, _>(0)).unwrap())
            .unwrap();
        tables.insert(table.to_owned(), Value::from(rows));
    }
    Value::Object(tables)
}

#[sqlx::test(migrations = false)]
async fn the_baseline_builds_the_drizzle_schema_on_an_empty_database(pool: PgPool) {
    MIGRATOR.run(&pool).await.unwrap();
    assert_eq!(snapshot(&pool).await, drizzle_fixture()["snapshot"]);
    assert_eq!(
        table_names(&pool, "public").await,
        [
            "_sqlx_migrations",
            "action_tokens",
            "app_sessions",
            "user_sessions",
            "user_settings",
            "users"
        ]
    );
    // A second run applies nothing.
    MIGRATOR.run(&pool).await.unwrap();
    caltodo::db::ensure_migrated(&pool).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn the_drizzle_emulation_equals_the_node_run(pool: PgPool) {
    run_drizzle(&pool).await;
    assert_eq!(snapshot(&pool).await, drizzle_fixture()["snapshot"]);
}

#[sqlx::test(migrations = false)]
async fn a_drizzle_database_takes_the_migrations_without_changes(pool: PgPool) {
    run_drizzle(&pool).await;
    sqlx::raw_sql(
        r#"
        INSERT INTO users (id, google_id, email, display_name, access_token, refresh_token)
          VALUES ('u1', 'sub-1', 'a@example.com', 'Ann', 'enc:v1:a:b:c', NULL);
        INSERT INTO user_settings (id, user_id, calendar_id) VALUES ('s1', 'u1', 'primary');
        INSERT INTO action_tokens (id, token_hash, user_id, event_id, calendar_id, expires_at, created_at)
          VALUES ('t1', 'hash-1', 'u1', 'e1', 'primary', '2026-03-09 10:00:00', '2026-03-02 10:00:00');
        INSERT INTO user_sessions (sid, sess, expire)
          VALUES ('sid-1', '{"passport":{"user":"u1"},"csrfToken":"x"}', '2026-03-09 10:00:00');
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let before = data(&pool).await;
    let ledger_before = table_names(&pool, "drizzle").await;
    let ledger_rows_before: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM "drizzle"."__drizzle_migrations""#)
            .fetch_one(&pool)
            .await
            .unwrap();

    MIGRATOR.run(&pool).await.unwrap();

    assert_eq!(snapshot(&pool).await, drizzle_fixture()["snapshot"]);
    assert_eq!(data(&pool).await, before);
    assert_eq!(table_names(&pool, "drizzle").await, ledger_before);
    let ledger_rows_after: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM "drizzle"."__drizzle_migrations""#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ledger_rows_after, ledger_rows_before);
    assert_eq!(ledger_rows_after, 4);
    caltodo::db::ensure_migrated(&pool).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn the_baseline_statements_are_idempotent(pool: PgPool) {
    sqlx::raw_sql(BASELINE_SQL).execute(&pool).await.unwrap();
    sqlx::raw_sql(BASELINE_SQL).execute(&pool).await.unwrap();
    assert_eq!(snapshot(&pool).await, drizzle_fixture()["snapshot"]);
}

#[sqlx::test(migrations = false)]
async fn serve_refuses_an_unmigrated_database(pool: PgPool) {
    assert!(caltodo::db::ensure_migrated(&pool).await.is_err());
}
