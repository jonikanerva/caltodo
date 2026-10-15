//! The process lifecycle: the serve loop with its shutdown deadline, and the
//! compiled binary on a real socket and a real database with `migrate`,
//! `serve`, SIGTERM, and SIGINT.
//!
//! The binary tests create their own database on the server of
//! `DATABASE_URL` and drop it at the end. They use synthetic secrets and call
//! only the operational routes, so the server sends no Google request.

#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "the helpers of this test binary fail a check by panicking"
)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use axum::Router;
use axum::routing::get;
use caltodo::lifecycle::{self, Stopped};
use serde_json::Value;
use sqlx::Connection as _;
use tokio::sync::oneshot;

// ---- The serve loop ----------------------------------------------------------

struct Loop {
    port: u16,
    stop: Option<oneshot::Sender<()>>,
    served: tokio::task::JoinHandle<std::io::Result<Stopped>>,
}

impl Loop {
    async fn start(router: Router, grace: Duration) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, stopped) = oneshot::channel::<()>();
        let shutdown = async move {
            stopped.await.ok();
        };
        let served = tokio::spawn(lifecycle::serve(listener, router, shutdown, grace));
        Self {
            port,
            stop: Some(stop),
            served,
        }
    }

    async fn stop_within(mut self, limit: Duration) -> (Stopped, Duration) {
        let signalled = Instant::now();
        self.stop.take().unwrap().send(()).unwrap();
        let outcome = tokio::time::timeout(limit, self.served)
            .await
            .expect("the serve loop ends within the limit")
            .unwrap()
            .unwrap();
        (outcome, signalled.elapsed())
    }
}

fn send_request(port: u16, path: &str, keep_alive: bool) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let connection = if keep_alive { "keep-alive" } else { "close" };
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: {connection}\r\n\r\n"
    )
    .unwrap();
    stream
}

fn read_response(stream: &mut TcpStream) -> String {
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    let mut length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap();
        }
        head.push_str(&line);
        if line == "\r\n" || line.is_empty() {
            break;
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    head + &String::from_utf8(body).unwrap()
}

#[tokio::test]
async fn an_idle_server_stops_promptly_on_the_shutdown_signal() {
    let router = Router::new().route("/ok", get(|| async { "ok" }));
    let served = Loop::start(router, Duration::from_secs(30)).await;
    let port = served.port;
    let idle_connection = tokio::task::spawn_blocking(move || {
        let mut stream = send_request(port, "/ok", true);
        let reply = read_response(&mut stream);
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).unwrap();
        rest
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (outcome, waited) = served.stop_within(Duration::from_secs(5)).await;
    assert_eq!(outcome, Stopped::Drained);
    assert!(waited < Duration::from_secs(2), "{waited:?}");
    assert_eq!(idle_connection.await.unwrap(), Vec::<u8>::new());
}

#[tokio::test]
async fn an_active_request_finishes_within_the_grace_period() {
    let router = Router::new().route(
        "/slow",
        get(|| async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            "done"
        }),
    );
    let served = Loop::start(router, Duration::from_secs(10)).await;
    let port = served.port;
    let request = tokio::task::spawn_blocking(move || {
        let mut stream = send_request(port, "/slow", false);
        read_response(&mut stream)
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (outcome, waited) = served.stop_within(Duration::from_secs(5)).await;
    assert_eq!(outcome, Stopped::Drained);
    assert!(waited < Duration::from_secs(2), "{waited:?}");
    let reply = request.await.unwrap();
    assert!(reply.ends_with("done"), "{reply}");
}

#[tokio::test]
async fn an_active_request_does_not_outlive_the_deadline() {
    let (started, request_started) = oneshot::channel::<()>();
    let started = std::sync::Arc::new(std::sync::Mutex::new(Some(started)));
    let router = Router::new().route(
        "/never",
        get(move || {
            if let Some(started) = started.lock().unwrap().take() {
                started.send(()).ok();
            }
            std::future::pending::<&'static str>()
        }),
    );
    let grace = Duration::from_millis(500);
    let served = Loop::start(router, grace).await;
    let port = served.port;
    std::thread::spawn(move || {
        let mut stream = send_request(port, "/never", false);
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).ok();
    });
    tokio::time::timeout(Duration::from_secs(5), request_started)
        .await
        .expect("the request reaches the handler")
        .unwrap();
    let (outcome, waited) = served.stop_within(Duration::from_secs(5)).await;
    assert_eq!(outcome, Stopped::DeadlineReached);
    assert!(waited >= grace, "{waited:?}");
    assert!(waited < grace + Duration::from_secs(2), "{waited:?}");
}

// ---- The binary ----------------------------------------------------------------

const LIMIT: Duration = Duration::from_secs(20);
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

/// A database of its own on the server of `DATABASE_URL`, dropped at the end.
struct Database {
    admin_url: String,
    name: String,
}

impl Database {
    async fn create() -> Self {
        let admin_url = std::env::var("DATABASE_URL").expect("DATABASE_URL of the test server");
        let name = format!("caltodo_lifecycle_{}", uuid::Uuid::new_v4().simple());
        let mut admin = sqlx::PgConnection::connect(&admin_url).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&mut admin)
            .await
            .unwrap();
        Self { admin_url, name }
    }

    fn url(&self) -> String {
        let (base, _) = self.admin_url.rsplit_once('/').unwrap();
        format!("{base}/{}", self.name)
    }

    async fn drop_now(self) {
        let mut admin = sqlx::PgConnection::connect(&self.admin_url).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        )))
        .execute(&mut admin)
        .await
        .unwrap();
    }
}

struct Process {
    child: Child,
    lines: Receiver<Value>,
}

impl Drop for Process {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
    }
}

impl Process {
    fn start(arguments: &[&str], database_url: &str, port: u16) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_caltodo"))
            .args(arguments)
            .env_clear()
            .env("DATABASE_URL", database_url)
            .env("GOOGLE_CLIENT_ID", "synthetic-client-id")
            .env("GOOGLE_CLIENT_SECRET", "synthetic-client-secret")
            .env(
                "SESSION_SECRET",
                "synthetic-session-secret-0123456789abcdef",
            )
            .env(
                "ACTION_TOKEN_SECRET",
                "synthetic-action-secret-0123456789abcdef",
            )
            .env(
                "TOKEN_ENCRYPTION_KEY",
                "synthetic-encryption-key-0123456789abcd",
            )
            .env("TZ", "Europe/Helsinki")
            .env("PORT", port.to_string())
            .env("RAILWAY_GIT_COMMIT_SHA", COMMIT)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let value = serde_json::from_str(&line).expect("each log line is JSON");
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        Self { child, lines }
    }

    fn wait_for(&self, message: &str) -> Value {
        let deadline = Instant::now() + LIMIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(line) if line["message"] == message => return line,
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => panic!("no {message:?} log line"),
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("the process ended before {message:?}")
                }
            }
        }
    }

    fn signal(&self, name: &str) {
        let status = Command::new("kill")
            .args([format!("-{name}"), self.child.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn wait_exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + LIMIT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "the process did not stop");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn free_port() -> u16 {
    TcpListener::bind("0.0.0.0:0")
        .and_then(|listener| listener.local_addr())
        .unwrap()
        .port()
}

fn http_get(port: u16, path: &str) -> String {
    let mut stream = send_request(port, path, false);
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    reply
}

async fn migrated_database() -> Database {
    let database = Database::create().await;
    let mut migrate = Process::start(&["migrate"], &database.url(), free_port());
    let line = migrate.wait_for("migrations are applied");
    assert_eq!(line["applied"], 2);
    assert!(migrate.wait_exit().success());
    database
}

async fn starts_and_stops_on(signal: &str) {
    let database = migrated_database().await;
    let port = free_port();
    let mut server = Process::start(&["serve"], &database.url(), port);
    let started = server.wait_for("service started");
    assert_eq!(started["bind"], format!("0.0.0.0:{port}"));

    let health = http_get(port, "/healthz");
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    assert!(health.ends_with(r#"{"ok":true}"#), "{health}");
    assert!(
        health
            .to_ascii_lowercase()
            .contains("x-content-type-options: nosniff"),
        "{health}"
    );
    let ready = http_get(port, "/readyz");
    assert!(ready.ends_with(r#"{"ready":true}"#), "{ready}");
    let version = http_get(port, "/version");
    let expected = format!(
        r#"{{"version":"{}","commit":"{COMMIT}"}}"#,
        env!("CARGO_PKG_VERSION")
    );
    assert!(version.ends_with(&expected), "{version}");
    let completed = server.wait_for("request completed");
    assert_eq!(completed["route"], "/healthz");
    assert!(completed["request_id"].is_string(), "{completed}");

    server.signal(signal);
    server.wait_for("shutdown started");
    let status = server.wait_exit();
    assert!(status.success(), "{status}");
    drop(server);
    database.drop_now().await;
}

#[tokio::test]
async fn the_binary_migrates_serves_and_stops_on_sigterm() {
    starts_and_stops_on("TERM").await;
}

#[tokio::test]
async fn the_binary_stops_on_sigint() {
    starts_and_stops_on("INT").await;
}

#[tokio::test]
async fn serve_refuses_a_database_without_the_migrations() {
    let database = Database::create().await;
    let mut server = Process::start(&["serve"], &database.url(), free_port());
    let line = server.wait_for("caltodo stopped with an error");
    assert_eq!(line["stage"], "schema");
    assert!(!server.wait_exit().success());
    drop(server);
    database.drop_now().await;
}

#[tokio::test]
async fn an_invalid_setting_stops_the_start_without_its_value() {
    let mut server = Command::new(env!("CARGO_BIN_EXE_caltodo"))
        .arg("serve")
        .env_clear()
        .env("SESSION_SECRET", "short-synthetic-value")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = String::new();
    server
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(!server.wait().unwrap().success());
    assert!(
        output.contains("SESSION_SECRET must be at least 32 characters long"),
        "{output}"
    );
    assert!(output.contains("DATABASE_URL must be set"), "{output}");
    assert!(!output.contains("short-synthetic-value"), "{output}");
}

/// A peer that accepts the PostgreSQL `SSLRequest` and then closes the
/// connection. The local test server has no TLS and refuses the request, so
/// SQLx would stop before it builds the certificate verifier.
fn tls_accepting_peer() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut ssl_request = [0_u8; 8];
            if stream.read_exact(&mut ssl_request).is_ok() {
                stream.write_all(b"S").ok();
            }
        }
    });
    port
}

/// `sslmode=verify-ca` makes SQLx build a certificate verifier with the
/// process-default rustls crypto provider. With two providers in the binary,
/// rustls has no default and panics (exit code 101). The start must fail with
/// the mapped database error instead.
#[test]
fn migrate_fails_without_a_panic_when_the_url_requires_certificate_verification() {
    let port = tls_accepting_peer();
    let url = format!("postgres://caltodo:synthetic@127.0.0.1:{port}/caltodo?sslmode=verify-ca");
    let mut migrate = Process::start(&["migrate"], &url, free_port());
    let line = migrate.wait_for("caltodo stopped with an error");
    assert_eq!(line["stage"], "database");
    assert_eq!(migrate.wait_exit().code(), Some(1));
}

#[test]
fn an_unknown_command_is_a_usage_error() {
    let status = Command::new(env!("CARGO_BIN_EXE_caltodo"))
        .arg("bogus")
        .env_clear()
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));
}
