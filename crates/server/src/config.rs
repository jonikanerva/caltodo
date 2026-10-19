//! The environment settings, read and validated once at startup.
//!
//! The variable names are the names of the Node server, so the change to the
//! Rust server needed no change of the Railway variables. An error names the
//! setting and the rule. It never contains the value.

use std::fmt;
use std::path::PathBuf;

use jiff::tz::TimeZone;

use crate::observability::LogFormat;

/// The setting names.
pub mod names {
    pub const DATABASE_URL: &str = "DATABASE_URL";
    pub const GOOGLE_CLIENT_ID: &str = "GOOGLE_CLIENT_ID";
    pub const GOOGLE_CLIENT_SECRET: &str = "GOOGLE_CLIENT_SECRET";
    pub const SESSION_SECRET: &str = "SESSION_SECRET";
    pub const ACTION_TOKEN_SECRET: &str = "ACTION_TOKEN_SECRET";
    pub const TOKEN_ENCRYPTION_KEY: &str = "TOKEN_ENCRYPTION_KEY";
    pub const PRODUCTION_APP_URL: &str = "PRODUCTION_APP_URL";
    pub const TZ: &str = "TZ";
    pub const PORT: &str = "PORT";
    /// Railway sets both names on a deployment.
    pub const RAILWAY_ENVIRONMENT: &str = "RAILWAY_ENVIRONMENT";
    pub const RAILWAY_ENVIRONMENT_NAME: &str = "RAILWAY_ENVIRONMENT_NAME";
    pub const RAILWAY_GIT_COMMIT_SHA: &str = "RAILWAY_GIT_COMMIT_SHA";
    pub const LOG_FORMAT: &str = "CALTODO_LOG_FORMAT";
}

/// The port without `PORT`. The Vite dev server proxies to the server in
/// development, so `mise run dev` sets another port.
pub const DEFAULT_PORT: u16 = 5000;

/// The origin of the OAuth callback and the action links without
/// `PRODUCTION_APP_URL` (local development).
pub const DEVELOPMENT_ORIGIN: &str = "http://localhost:5000";

/// The shortest accepted secret, in characters.
pub const MIN_SECRET_CHARS: usize = 32;

/// The web build directory, relative to the working directory.
pub const WEB_BUILD_DIR: &str = "web/build";

/// A credential. `Debug` and `Display` never print the value.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value, only for an outbound header, a key derivation, or a
    /// comparison.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// The Google OAuth client.
#[derive(Debug, Clone)]
pub struct GoogleClient {
    pub client_id: String,
    pub client_secret: Secret,
}

/// The validated settings of `caltodo serve`.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: Secret,
    pub google: GoogleClient,
    /// The key of the signed session cookie.
    pub session_secret: Secret,
    /// The HMAC key of the action token hashes.
    pub action_token_secret: Secret,
    /// The key source of the stored OAuth token encryption.
    pub token_encryption_key: Secret,
    /// The origin of the OAuth callback and the action links, without a
    /// trailing slash.
    pub app_origin: String,
    /// True with `PRODUCTION_APP_URL`: the session cookie is `Secure` and
    /// responses carry HSTS.
    pub production: bool,
    /// The process time zone (`TZ`, UTC when unset). It converts the naive
    /// `action_tokens` timestamps and sets the job times (ADR 0003).
    pub process_zone: TimeZone,
    pub log_format: LogFormat,
    pub commit: Option<String>,
    pub web_build: PathBuf,
}

/// The validated settings of `caltodo migrate`.
#[derive(Debug, Clone)]
pub struct MigrateConfig {
    pub database_url: Secret,
    pub log_format: LogFormat,
}

/// One invalid setting. The text names the setting and the rule only.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} must be set")]
    Missing(&'static str),
    #[error("{0} must be at least 32 characters long")]
    TooShort(&'static str),
    #[error("SESSION_SECRET and ACTION_TOKEN_SECRET must be different values")]
    SameSecrets,
    #[error("{0} has an invalid value")]
    Invalid(&'static str),
    #[error("PRODUCTION_APP_URL must be set in production to build trusted action links")]
    MissingProductionUrl,
}

/// The build identity for `GET /version`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildInfo {
    pub version: &'static str,
    pub commit: String,
}

impl Default for BuildInfo {
    fn default() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION"),
            commit: "unknown".to_owned(),
        }
    }
}

/// A setting lookup: the process environment or a test table.
pub trait Lookup {
    /// The value, or `None` when the variable is missing or empty.
    fn get(&self, name: &str) -> Option<String>;
}

/// The process environment.
#[derive(Debug, Clone, Copy)]
pub struct ProcessEnv;

impl Lookup for ProcessEnv {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }
}

impl<F: Fn(&str) -> Option<String>> Lookup for F {
    fn get(&self, name: &str) -> Option<String> {
        self(name).filter(|value| !value.is_empty())
    }
}

impl Config {
    /// Reads and validates every setting.
    ///
    /// # Errors
    ///
    /// Every invalid setting, in a fixed order.
    pub fn read(env: &impl Lookup) -> Result<Self, Vec<ConfigError>> {
        let mut errors = Vec::new();
        let database_url = required(env, names::DATABASE_URL, &mut errors);
        let client_id = required(env, names::GOOGLE_CLIENT_ID, &mut errors);
        let client_secret = required(env, names::GOOGLE_CLIENT_SECRET, &mut errors);
        let session_secret = secret(env, names::SESSION_SECRET, &mut errors);
        let action_token_secret = secret(env, names::ACTION_TOKEN_SECRET, &mut errors);
        let token_encryption_key = secret(env, names::TOKEN_ENCRYPTION_KEY, &mut errors);
        if let (Some(session), Some(action)) = (&session_secret, &action_token_secret)
            && session == action
        {
            errors.push(ConfigError::SameSecrets);
        }
        let production_url = env.get(names::PRODUCTION_APP_URL);
        let app_origin = match production_url.as_deref() {
            Some(url) => origin_of(url).ok_or(ConfigError::Invalid(names::PRODUCTION_APP_URL)),
            None if env.get(names::RAILWAY_ENVIRONMENT).is_some()
                || env.get(names::RAILWAY_ENVIRONMENT_NAME).is_some() =>
            {
                Err(ConfigError::MissingProductionUrl)
            }
            None => Ok(DEVELOPMENT_ORIGIN.to_owned()),
        }
        .map_err(|error| errors.push(error))
        .ok();
        let process_zone = process_zone(env.get(names::TZ).as_deref())
            .map_err(|error| errors.push(error))
            .ok();
        let port = port(env.get(names::PORT).as_deref())
            .map_err(|error| errors.push(error))
            .ok();
        let log_format = log_format(env, &mut errors);
        let commit = env
            .get(names::RAILWAY_GIT_COMMIT_SHA)
            .and_then(|value| parse_commit(&value));

        match (
            database_url,
            client_id,
            client_secret,
            session_secret,
            action_token_secret,
            token_encryption_key,
            app_origin,
            process_zone,
            port,
        ) {
            (
                Some(database_url),
                Some(client_id),
                Some(client_secret),
                Some(session_secret),
                Some(action_token_secret),
                Some(token_encryption_key),
                Some(app_origin),
                Some(process_zone),
                Some(port),
            ) if errors.is_empty() => Ok(Self {
                port,
                database_url: Secret::new(database_url),
                google: GoogleClient {
                    client_id,
                    client_secret: Secret::new(client_secret),
                },
                session_secret,
                action_token_secret,
                token_encryption_key,
                app_origin,
                production: production_url.is_some(),
                process_zone,
                log_format,
                commit,
                web_build: PathBuf::from(WEB_BUILD_DIR),
            }),
            _ => Err(errors),
        }
    }

    /// The build identity that `GET /version` shows.
    #[must_use]
    pub fn build_info(&self) -> BuildInfo {
        BuildInfo {
            commit: self.commit.clone().unwrap_or_else(|| "unknown".to_owned()),
            ..BuildInfo::default()
        }
    }

    /// The OAuth callback URL that Google redirects to.
    #[must_use]
    pub fn oauth_callback_url(&self) -> String {
        format!("{}/api/auth/google/callback", self.app_origin)
    }
}

impl MigrateConfig {
    /// Reads `DATABASE_URL` and the log format.
    ///
    /// # Errors
    ///
    /// A missing `DATABASE_URL` or an invalid log format.
    pub fn read(env: &impl Lookup) -> Result<Self, Vec<ConfigError>> {
        let mut errors = Vec::new();
        let database_url = required(env, names::DATABASE_URL, &mut errors);
        let log_format = log_format(env, &mut errors);
        match database_url {
            Some(url) if errors.is_empty() => Ok(Self {
                database_url: Secret::new(url),
                log_format,
            }),
            _ => Err(errors),
        }
    }
}

fn required(
    env: &impl Lookup,
    name: &'static str,
    errors: &mut Vec<ConfigError>,
) -> Option<String> {
    let value = env.get(name);
    if value.is_none() {
        errors.push(ConfigError::Missing(name));
    }
    value
}

/// A secret of at least 32 characters (`server/config.ts`).
fn secret(env: &impl Lookup, name: &'static str, errors: &mut Vec<ConfigError>) -> Option<Secret> {
    let value = required(env, name, errors)?;
    // JavaScript counts UTF-16 code units.
    if caltodo_domain::text::utf16_len(&value) < MIN_SECRET_CHARS {
        errors.push(ConfigError::TooShort(name));
        return None;
    }
    Some(Secret::new(value))
}

fn log_format(env: &impl Lookup, errors: &mut Vec<ConfigError>) -> LogFormat {
    match env.get(names::LOG_FORMAT) {
        None => LogFormat::default(),
        Some(value) => LogFormat::parse(&value).unwrap_or_else(|| {
            errors.push(ConfigError::Invalid(names::LOG_FORMAT));
            LogFormat::default()
        }),
    }
}

/// The origin of an absolute `http` or `https` URL, like `new URL(url).origin`.
fn origin_of(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

/// The process time zone of `TZ`: an IANA name, an optional leading `:`
/// (the glibc form), or UTC when unset.
fn process_zone(value: Option<&str>) -> Result<TimeZone, ConfigError> {
    let Some(value) = value else {
        return Ok(TimeZone::UTC);
    };
    let name = value.strip_prefix(':').unwrap_or(value);
    TimeZone::get(name).map_err(|_| ConfigError::Invalid(names::TZ))
}

fn port(value: Option<&str>) -> Result<u16, ConfigError> {
    match value {
        None => Ok(DEFAULT_PORT),
        Some(text) => text
            .trim()
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or(ConfigError::Invalid(names::PORT)),
    }
}

/// A Git commit id: 7 to 64 hexadecimal digits. Another value is ignored, so
/// no path or text reaches `GET /version`.
fn parse_commit(value: &str) -> Option<String> {
    let valid = (7..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit());
    valid.then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "session-secret-0123456789abcdef-0123";
    const ACTION: &str = "action-secret-0123456789abcdef-01234";
    const KEY: &str = "encryption-key-0123456789abcdef-0123";

    fn table(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        }
    }

    fn valid() -> Vec<(&'static str, &'static str)> {
        vec![
            ("DATABASE_URL", "postgres://user:synthetic@localhost/db"),
            ("GOOGLE_CLIENT_ID", "client-id"),
            ("GOOGLE_CLIENT_SECRET", "synthetic-client-secret"),
            ("SESSION_SECRET", SESSION),
            ("ACTION_TOKEN_SECRET", ACTION),
            ("TOKEN_ENCRYPTION_KEY", KEY),
        ]
    }

    fn with(extra: &[(&'static str, &'static str)]) -> Result<Config, Vec<ConfigError>> {
        let mut pairs = valid();
        for (name, value) in extra {
            pairs.retain(|(n, _)| n != name);
            pairs.push((name, value));
        }
        Config::read(&table(&pairs))
    }

    #[test]
    fn reads_the_development_defaults() {
        let config = with(&[]).unwrap();
        assert_eq!(config.port, 5000);
        assert_eq!(config.app_origin, "http://localhost:5000");
        assert!(!config.production);
        assert_eq!(config.process_zone, TimeZone::UTC);
        assert_eq!(
            config.oauth_callback_url(),
            "http://localhost:5000/api/auth/google/callback"
        );
        assert_eq!(config.build_info().commit, "unknown");
    }

    #[test]
    fn production_uses_the_origin_of_the_app_url() {
        let config = with(&[
            (
                "PRODUCTION_APP_URL",
                "https://todo.example.com/some/path?x=1",
            ),
            ("PORT", "8080"),
            ("TZ", "Europe/Helsinki"),
            ("RAILWAY_ENVIRONMENT", "production"),
            (
                "RAILWAY_GIT_COMMIT_SHA",
                "0123456789abcdef0123456789abcdef01234567",
            ),
        ])
        .unwrap();
        assert!(config.production);
        assert_eq!(config.app_origin, "https://todo.example.com");
        assert_eq!(config.port, 8080);
        assert_eq!(
            config.process_zone,
            TimeZone::get("Europe/Helsinki").unwrap()
        );
        assert_eq!(
            config.build_info().commit,
            "0123456789abcdef0123456789abcdef01234567"
        );
    }

    #[test]
    fn railway_requires_the_production_url() {
        for name in ["RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME"] {
            assert_eq!(
                with(&[(name, "production")]).unwrap_err(),
                vec![ConfigError::MissingProductionUrl]
            );
        }
    }

    #[test]
    fn rejects_missing_short_and_equal_secrets() {
        assert_eq!(
            Config::read(&table(&[])).unwrap_err(),
            vec![
                ConfigError::Missing("DATABASE_URL"),
                ConfigError::Missing("GOOGLE_CLIENT_ID"),
                ConfigError::Missing("GOOGLE_CLIENT_SECRET"),
                ConfigError::Missing("SESSION_SECRET"),
                ConfigError::Missing("ACTION_TOKEN_SECRET"),
                ConfigError::Missing("TOKEN_ENCRYPTION_KEY"),
            ]
        );
        assert_eq!(
            with(&[("SESSION_SECRET", "short")]).unwrap_err(),
            vec![ConfigError::TooShort("SESSION_SECRET")]
        );
        assert_eq!(
            with(&[("ACTION_TOKEN_SECRET", SESSION)]).unwrap_err(),
            vec![ConfigError::SameSecrets]
        );
    }

    #[test]
    fn rejects_invalid_values_without_printing_them() {
        let errors = with(&[
            ("PRODUCTION_APP_URL", "not a url"),
            ("TZ", "Mars/Olympus"),
            ("PORT", "0"),
            ("CALTODO_LOG_FORMAT", "xml"),
        ])
        .unwrap_err();
        assert_eq!(
            errors,
            vec![
                ConfigError::Invalid("PRODUCTION_APP_URL"),
                ConfigError::Invalid("TZ"),
                ConfigError::Invalid("PORT"),
                ConfigError::Invalid("CALTODO_LOG_FORMAT"),
            ]
        );
        let text = errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!text.contains("Mars"), "{text}");
        assert!(!text.contains("not a url"), "{text}");
    }

    #[test]
    fn accepts_the_glibc_time_zone_form_and_ignores_an_invalid_commit() {
        let config = with(&[
            ("TZ", ":America/New_York"),
            ("RAILWAY_GIT_COMMIT_SHA", "main"),
        ])
        .unwrap();
        assert_eq!(
            config.process_zone,
            TimeZone::get("America/New_York").unwrap()
        );
        assert_eq!(config.commit, None);
    }

    #[test]
    fn secrets_never_print() {
        let config = with(&[]).unwrap();
        let debug = format!("{config:?}");
        for value in [
            SESSION,
            ACTION,
            KEY,
            "synthetic-client-secret",
            "synthetic@localhost",
        ] {
            assert!(!debug.contains(value), "{debug}");
        }
    }
}
