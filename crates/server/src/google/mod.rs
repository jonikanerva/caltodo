//! The Google adapters over HTTP: Calendar API v3 and OAuth 2.0.
//!
//! Every call uses one shared client with the rules of STACK.md §2.3:
//! Rustls, an explicit `User-Agent`, a deadline that includes the response
//! body, a body size limit, no redirects (the requests carry a bearer token
//! or a client secret), and fixed error texts without URLs.

pub mod calendar;
pub mod oauth;
mod wire;

use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::application::ports::GoogleError;

/// The `User-Agent` of every outbound request.
pub const USER_AGENT: &str = concat!("caltodo/", env!("CARGO_PKG_VERSION"));
/// The connection deadline.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The deadline of one request, including the response body.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// The largest accepted response body. One event page of 250 events with
/// long descriptions stays far below it.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// The settings of the outbound client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientSettings {
    /// Refuse plain HTTP. Tests turn it off for a local fake server.
    pub https_only: bool,
}

impl Default for ClientSettings {
    fn default() -> Self {
        Self { https_only: true }
    }
}

/// Builds the outbound client.
///
/// # Errors
///
/// The TLS setup fails.
pub fn build_client(settings: ClientSettings) -> Result<reqwest::Client, GoogleError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .https_only(settings.https_only)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| GoogleError::Transport)
}

/// Sends a request and reads the body up to [`MAX_BODY_BYTES`]. A transport
/// failure becomes [`GoogleError::Transport`]; the error text, which can
/// contain the URL, is dropped.
async fn send(request: reqwest::RequestBuilder) -> Result<(u16, Vec<u8>), GoogleError> {
    let mut response = request.send().await.map_err(|_| GoogleError::Transport)?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return Err(GoogleError::Transport);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| GoogleError::Transport)? {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(GoogleError::Transport);
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

/// The error of a failure status.
fn status_error(status: u16) -> GoogleError {
    match status {
        401 => GoogleError::Unauthorized,
        404 | 410 => GoogleError::NotFound,
        other => GoogleError::Status(other),
    }
}

/// Decodes a JSON object. The check of the JSON type comes first: a derived
/// `Deserialize` of a struct also accepts an array in field order. Through
/// `serde_json::Value`, a repeated key keeps its last value (STACK.md §2.3).
fn decode_object<T: DeserializeOwned>(body: &[u8]) -> Result<T, GoogleError> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| GoogleError::InvalidResponse)?;
    if !value.is_object() {
        return Err(GoogleError::InvalidResponse);
    }
    serde_json::from_value(value).map_err(|_| GoogleError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Pair {
        a: u32,
        b: u32,
    }

    #[test]
    fn decodes_objects_only_and_keeps_the_last_repeated_key() {
        assert_eq!(
            decode_object::<Pair>(br#"{"a":1,"b":2,"a":3}"#),
            Ok(Pair { a: 3, b: 2 })
        );
        assert_eq!(
            decode_object::<Pair>(b"[1,2]"),
            Err(GoogleError::InvalidResponse)
        );
        assert_eq!(
            decode_object::<Pair>(b"not json"),
            Err(GoogleError::InvalidResponse)
        );
    }

    #[test]
    fn maps_failure_statuses() {
        assert_eq!(status_error(401), GoogleError::Unauthorized);
        assert_eq!(status_error(404), GoogleError::NotFound);
        assert_eq!(status_error(410), GoogleError::NotFound);
        assert_eq!(status_error(503), GoogleError::Status(503));
    }
}
