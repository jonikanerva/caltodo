//! The composition root: the one place that selects the concrete services.

use std::sync::Arc;

use jiff::tz::TimeZone;
use sqlx::PgPool;

use crate::application::Services;
use crate::application::ports::{CalendarApi, Clock, GoogleError, OAuthApi, SystemClock};
use crate::config::{BuildInfo, Config, Secret};
use crate::db::Store;
use crate::db::sessions::PgSessionStore;
use crate::google::calendar::{API_BASE, GoogleCalendar};
use crate::google::oauth::{Endpoints, GoogleOAuth};
use crate::google::{ClientSettings, build_client};
use crate::http::AppState;
use crate::http::rate_limit::RateLimits;
use crate::http::session::{SessionSettings, ShortSessionSecret};
use crate::http::static_files::StaticSite;
use crate::security::action_tokens::TokenHasher;
use crate::security::token_cipher::TokenCipher;

/// A failure while the services are built.
#[derive(Debug, thiserror::Error)]
pub enum WiringError {
    #[error("the Google client could not start")]
    Google(#[from] GoogleError),
    #[error(transparent)]
    SessionSecret(#[from] ShortSessionSecret),
}

/// The values of the services that do not come from the environment of a
/// production run: the Google adapters and the clock. Tests and the e2e
/// server put fakes here.
#[derive(Debug, Clone)]
pub struct Adapters {
    pub calendar: Arc<dyn CalendarApi>,
    pub oauth: Arc<dyn OAuthApi>,
    pub clock: Arc<dyn Clock>,
}

/// The production adapters: Google over HTTPS and the system clock.
///
/// # Errors
///
/// The HTTP client or an endpoint URL is invalid.
pub fn google_adapters(config: &Config) -> Result<Adapters, WiringError> {
    let client = build_client(ClientSettings::default())?;
    Ok(Adapters {
        calendar: Arc::new(GoogleCalendar::new(client.clone(), API_BASE)?),
        oauth: Arc::new(GoogleOAuth::new(
            client,
            &config.google,
            &config.oauth_callback_url(),
            &Endpoints::default(),
        )?),
        clock: Arc::new(SystemClock),
    })
}

/// The secrets and settings of the services.
#[derive(Debug, Clone)]
pub struct ServiceSettings {
    pub token_encryption_key: Secret,
    pub action_token_secret: Secret,
    pub session_secret: Secret,
    pub app_origin: String,
    pub process_zone: TimeZone,
    pub production: bool,
}

impl From<&Config> for ServiceSettings {
    fn from(config: &Config) -> Self {
        Self {
            token_encryption_key: config.token_encryption_key.clone(),
            action_token_secret: config.action_token_secret.clone(),
            session_secret: config.session_secret.clone(),
            app_origin: config.app_origin.clone(),
            process_zone: config.process_zone.clone(),
            production: config.production,
        }
    }
}

/// The use-case services.
#[must_use]
pub fn services(pool: PgPool, settings: &ServiceSettings, adapters: &Adapters) -> Services {
    Services {
        store: Store::new(pool, TokenCipher::new(&settings.token_encryption_key)),
        calendar: Arc::clone(&adapters.calendar),
        oauth: Arc::clone(&adapters.oauth),
        clock: Arc::clone(&adapters.clock),
        tokens: TokenHasher::new(settings.action_token_secret.clone()),
        app_origin: Arc::from(settings.app_origin.as_str()),
        process_zone: settings.process_zone.clone(),
    }
}

/// The state of the HTTP handlers.
///
/// # Errors
///
/// The session secret is too short for a signing key.
pub fn state(
    services: Services,
    settings: &ServiceSettings,
    site: StaticSite,
    build: BuildInfo,
) -> Result<AppState, WiringError> {
    let sessions = SessionSettings::new(
        PgSessionStore::new(services.store.pool().clone()),
        &settings.session_secret,
        settings.production,
    )?;
    Ok(AppState {
        services,
        site: Arc::new(site),
        build: Arc::new(build),
        limits: Arc::new(RateLimits::default()),
        sessions,
        production: settings.production,
    })
}
