//! The deterministic server of the browser journeys (`e2e/`).
//!
//! ```text
//! e2e_server --port <port> --web-build <dir> --database-url <url>
//! ```
//!
//! The server runs the migrations on the given database and mounts the real
//! router, the real middleware, and the built client (`caltodo::http::app`)
//! over the fake Google services of `caltodo::fakes`. It sends no network
//! request, reads no environment variable, and listens on `127.0.0.1` only.
//!
//! - The fake Google sign-in signs in the synthetic account `e2e-user`
//!   without leaving the server: the authorization URL is the callback.
//! - The fake calendar list has `primary` ("E2E Calendar") and `work`.
//! - `GET /__e2e/action-link?title=<title>` answers the action link of the
//!   newest task event with that title, so a journey can open the link that
//!   a user finds in Google Calendar. This route exists only here.

#![expect(
    clippy::print_stderr,
    reason = "a command-line tool reports a usage error before logging starts"
)]

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use caltodo::application::ports::{CalendarSummary, GoogleProfile, SystemClock};
use caltodo::config::{BuildInfo, Secret};
use caltodo::fakes::{FakeCalendar, FakeOAuth};
use caltodo::http::static_files::{StaticSite, index_exists};
use caltodo::observability::{self, LogFormat};
use caltodo::wiring::{self, Adapters, ServiceSettings};
use caltodo::{db, http, lifecycle};
use jiff::tz::TimeZone;

/// The grace period after a stop signal.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
/// The authorization code of the fake sign-in (see `FakeOAuth::begin`).
const FAKE_CODE: &str = "fake-code";

#[derive(Debug)]
struct Options {
    port: u16,
    web_build: PathBuf,
    database_url: String,
}

impl Options {
    fn parse(args: &[String]) -> Option<Self> {
        let mut port = None;
        let mut web_build = None;
        let mut database_url = None;
        let mut rest = args.iter();
        while let Some(flag) = rest.next() {
            let value = rest.next()?;
            match flag.as_str() {
                "--port" => port = value.parse::<u16>().ok().filter(|p| *p != 0),
                "--web-build" => web_build = Some(PathBuf::from(value)),
                "--database-url" => database_url = Some(value.clone()),
                _ => return None,
            }
        }
        Some(Self {
            port: port?,
            web_build: web_build?,
            database_url: database_url?,
        })
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(options) = Options::parse(&args) else {
        eprintln!("usage: e2e_server --port <port> --web-build <dir> --database-url <url>");
        return ExitCode::from(2);
    };
    if !index_exists(&options.web_build) {
        eprintln!("e2e_server: the client build has no index.html; run the web build first");
        return ExitCode::FAILURE;
    }
    if observability::init(LogFormat::Text).is_err() {
        eprintln!("e2e_server: logging could not be set up");
        return ExitCode::FAILURE;
    }
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return ExitCode::FAILURE;
    };
    let served = runtime.block_on(serve(options));
    runtime.shutdown_background();
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(stage) => {
            eprintln!("e2e_server: {stage} failed");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct LinkQuery {
    title: String,
}

/// The action link of the newest task event with the title.
async fn action_link(
    State(calendar): State<FakeCalendar>,
    Query(query): Query<LinkQuery>,
) -> Response {
    let summary = format!("☑️ {}", query.title);
    let link = calendar
        .events("primary")
        .into_iter()
        .filter(|event| event.summary.as_deref() == Some(summary.as_str()))
        .filter_map(|event| event.description)
        .filter_map(|description| {
            description
                .split("- Manage: ")
                .nth(1)
                .and_then(|rest| rest.split('\n').next())
                .map(str::to_owned)
        })
        .next_back();
    match link {
        Some(link) => link.into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn serve(options: Options) -> Result<(), &'static str> {
    let pool = db::connect(&Secret::new(options.database_url))
        .await
        .map_err(|_| "database")?;
    db::migrate(&pool).await.map_err(|_| "migrate")?;

    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, options.port));
    let origin = format!("http://127.0.0.1:{}", options.port);
    let clock = Arc::new(SystemClock);
    let calendar = FakeCalendar::new(clock.clone());
    calendar.set_calendars(vec![
        CalendarSummary {
            id: "primary".to_owned(),
            summary: "E2E Calendar".to_owned(),
            primary: true,
        },
        CalendarSummary {
            id: "work".to_owned(),
            summary: "Work".to_owned(),
            primary: false,
        },
    ]);
    let oauth = FakeOAuth::new("/api/auth/google/callback");
    oauth.code_for(
        FAKE_CODE,
        GoogleProfile {
            sub: "e2e-user".to_owned(),
            email: Some("e2e@example.com".to_owned()),
            name: Some("E2E User".to_owned()),
        },
    );
    let adapters = Adapters {
        calendar: Arc::new(calendar.clone()),
        oauth: Arc::new(oauth),
        clock,
    };
    let settings = ServiceSettings {
        token_encryption_key: Secret::new("e2e-synthetic-token-encryption-key-000000"),
        action_token_secret: Secret::new("e2e-synthetic-action-token-secret-0000000"),
        session_secret: Secret::new("e2e-synthetic-session-secret-000000000000"),
        app_origin: origin,
        process_zone: TimeZone::UTC,
        production: false,
    };
    let services = wiring::services(pool, &settings, &adapters);
    let state = wiring::state(
        services,
        &settings,
        StaticSite::new(options.web_build),
        BuildInfo::default(),
    )
    .map_err(|_| "state")?;
    let hooks = Router::new()
        .route("/__e2e/action-link", get(action_link))
        .with_state(calendar);
    let app = http::app(state).merge(hooks);

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|_| "bind")?;
    tracing::info!(bind = %address, "e2e server started");
    lifecycle::serve(listener, app, lifecycle::shutdown_signal(), SHUTDOWN_GRACE)
        .await
        .map(|_| ())
        .map_err(|_| "serve")
}
