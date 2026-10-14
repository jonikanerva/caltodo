//! The process entry point.
//!
//! ```text
//! caltodo migrate   # apply the database migrations, then exit
//! caltodo serve     # serve HTTP and run the daily jobs
//! ```
//!
//! The release runs `caltodo migrate` and then `caltodo serve`
//! (`railpack.json`, STACK.md §15). `serve` refuses a database without
//! every migration of this build.

use std::net::{Ipv4Addr, SocketAddr};
use std::process::ExitCode;

use caltodo::config::{Config, MigrateConfig, ProcessEnv};
use caltodo::db::sessions::PgSessionStore;
use caltodo::http::static_files::{StaticSite, index_exists};
use caltodo::lifecycle::{self, SHUTDOWN_GRACE};
use caltodo::observability;
use caltodo::{application, db, http, wiring};
use tokio::sync::watch;

/// The longest wait for the jobs task after the server stopped.
const JOBS_STOP_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Migrate,
    Serve,
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let command = match (args.next().as_deref(), args.next()) {
        (Some("migrate"), None) => Command::Migrate,
        (Some("serve"), None) => Command::Serve,
        _ => {
            #[expect(clippy::print_stderr, reason = "a usage error comes before logging")]
            {
                eprintln!("usage: caltodo <migrate|serve>");
            }
            return ExitCode::from(2);
        }
    };
    let format = match command {
        Command::Migrate => MigrateConfig::read(&ProcessEnv).map(|config| config.log_format),
        Command::Serve => Config::read(&ProcessEnv).map(|config| config.log_format),
    }
    .unwrap_or_default();
    if observability::init(format).is_err() {
        #[expect(clippy::print_stderr, reason = "logging could not be set up")]
        {
            eprintln!("caltodo: logging could not be set up");
        }
        return ExitCode::FAILURE;
    }
    observability::install_panic_hook();

    // One thread: the work is I/O, and one thread keeps the memory low
    // (ADR 0001).
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        tracing::error!(stage = "runtime", "the async runtime could not start");
        return ExitCode::FAILURE;
    };
    let outcome = match command {
        Command::Migrate => runtime.block_on(migrate()),
        Command::Serve => runtime.block_on(serve()),
    };
    // Dropping a runtime waits for its blocking tasks without a limit. After
    // the grace period nothing may keep the process alive.
    runtime.shutdown_background();
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(stage) => {
            tracing::error!(stage, "caltodo stopped with an error");
            ExitCode::FAILURE
        }
    }
}

fn report_config_errors(errors: &[caltodo::config::ConfigError]) {
    for error in errors {
        tracing::error!(stage = "config", reason = %error, "invalid setting");
    }
}

async fn migrate() -> Result<(), &'static str> {
    let config = MigrateConfig::read(&ProcessEnv).map_err(|errors| {
        report_config_errors(&errors);
        "config"
    })?;
    let pool = db::connect(&config.database_url)
        .await
        .map_err(|_| "database")?;
    db::migrate(&pool).await.map_err(|_| "migrate")?;
    tracing::info!(
        applied = u64::try_from(db::MIGRATOR.iter().count()).unwrap_or(u64::MAX),
        "migrations are applied"
    );
    pool.close().await;
    Ok(())
}

async fn serve() -> Result<(), &'static str> {
    let config = Config::read(&ProcessEnv).map_err(|errors| {
        report_config_errors(&errors);
        "config"
    })?;
    if !config.production {
        tracing::warn!(
            origin = config.app_origin.as_str(),
            "PRODUCTION_APP_URL is not set: development mode"
        );
    }
    if !index_exists(&config.web_build) {
        tracing::warn!("client build missing; every page path answers 404");
    }
    let pool = db::connect(&config.database_url)
        .await
        .map_err(|_| "database")?;
    db::ensure_migrated(&pool).await.map_err(|_| "schema")?;

    let settings = wiring::ServiceSettings::from(&config);
    let adapters = wiring::google_adapters(&config).map_err(|_| "google_client")?;
    let services = wiring::services(pool.clone(), &settings, &adapters);
    let state = wiring::state(
        services.clone(),
        &settings,
        StaticSite::new(config.web_build.clone()),
        config.build_info(),
    )
    .map_err(|_| "session_secret")?;

    let (stop_jobs, jobs_stopped) = watch::channel(false);
    let jobs = tokio::spawn(application::jobs::run(
        services,
        PgSessionStore::new(pool.clone()),
        jobs_stopped,
    ));

    let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, config.port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|_| "bind")?;
    let bound = listener.local_addr().map_err(|_| "bind")?;
    tracing::info!(bind = %bound, "service started");

    let served = lifecycle::serve(
        listener,
        http::app(state),
        lifecycle::shutdown_signal(),
        SHUTDOWN_GRACE,
    )
    .await;

    // The jobs stop between steps; a step in progress gets a short limit.
    stop_jobs.send(true).ok();
    if tokio::time::timeout(JOBS_STOP_LIMIT, jobs).await.is_err() {
        tracing::warn!(stage = "jobs", "the jobs did not stop in time");
    }
    pool.close().await;
    served.map(|_stopped| ()).map_err(|_| "serve")
}
