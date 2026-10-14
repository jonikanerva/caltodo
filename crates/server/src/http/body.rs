//! Request bodies and CSRF protection for every unsafe method
//! (`express.json`, `express.urlencoded`, and `server/csrf.ts`).
//!
//! For POST, PUT, PATCH, and DELETE the middleware:
//!
//! 1. reads the body under its limit: 100 KiB for JSON, 50 KiB for a form,
//!    100 KiB otherwise (413 above it);
//! 2. parses JSON (an object or an array at the top, like `express.json`;
//!    400 otherwise; an empty JSON body is `{}`) and forms;
//! 3. checks the CSRF token: the `X-CSRF-Token` header, or else the
//!    `csrfToken` text field of the body, must equal the token of the
//!    session (403 otherwise), compared in constant time.
//!
//! The decoded body goes to the handler as an [`input::Body`] extension.

use axum::body::Body as HttpBody;
use axum::extract::Request;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use tower_sessions::Session;

use super::errors::{Problem, ProblemCode};
use super::input::Body;
use super::session::{CSRF_TOKEN_KEY, get_text};
use crate::security::constant_time_eq;

/// The JSON body limit (`express.json({ limit: "100kb" })`).
pub const JSON_LIMIT: usize = 100 * 1024;
/// The form body limit (`express.urlencoded({ limit: "50kb" })`).
pub const FORM_LIMIT: usize = 50 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Media {
    Json,
    Form,
    Other,
}

fn media(headers: &HeaderMap) -> Media {
    let Some(value) = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()) else {
        return Media::Other;
    };
    let essence = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match essence.as_str() {
        "application/json" => Media::Json,
        "application/x-www-form-urlencoded" => Media::Form,
        _ => Media::Other,
    }
}

/// True for the methods that need no CSRF token.
fn is_safe(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// The JSON of a body: `{}` for an empty body, and only an object or an
/// array at the top (the `strict` mode of `express.json`).
fn parse_json(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?;
    let trimmed = text.trim_start_matches([' ', '\t', '\n', '\r']);
    if trimmed.is_empty() {
        return Some(Value::Object(serde_json::Map::new()));
    }
    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str(text).ok()
}

/// The middleware.
pub async fn body_and_csrf(request: Request, next: Next) -> Response {
    if is_safe(request.method()) {
        let mut request = request;
        request.extensions_mut().insert(Body::None);
        return next.run(request).await;
    }
    let (mut parts, body) = request.into_parts();
    let media = media(&parts.headers);
    let limit = match media {
        Media::Form => FORM_LIMIT,
        Media::Json | Media::Other => JSON_LIMIT,
    };
    let Ok(bytes) = axum::body::to_bytes(body, limit).await else {
        return Problem::new(ProblemCode::PayloadTooLarge).into_response();
    };
    let decoded = match media {
        Media::Json => match parse_json(&bytes) {
            Some(value) => Body::Json(value),
            None => return Problem::new(ProblemCode::InvalidRequest).into_response(),
        },
        Media::Form => Body::Form(form_urlencoded::parse(&bytes).into_owned().collect()),
        Media::Other => Body::None,
    };

    let Some(session) = parts.extensions.get::<Session>().cloned() else {
        return Problem::new(ProblemCode::InternalError).into_response();
    };
    let expected = match get_text(&session, CSRF_TOKEN_KEY).await {
        Ok(token) => token,
        Err(failed) => return failed.into_response(),
    };
    let header = parts
        .headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty());
    let presented = header.or_else(|| decoded.text_field("csrfToken"));
    let valid = matches!(
        (presented, expected.as_deref()),
        (Some(presented), Some(expected)) if !presented.is_empty() && constant_time_eq(presented, expected)
    );
    if !valid {
        return Problem::new(ProblemCode::CsrfRejected).into_response();
    }
    parts.extensions.insert(decoded);
    next.run(Request::from_parts(parts, HttpBody::empty()))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_like_express_strict_mode() {
        assert_eq!(parse_json(b""), Some(serde_json::json!({})));
        assert_eq!(parse_json(b"  \n"), Some(serde_json::json!({})));
        assert_eq!(parse_json(br#"{"a":1}"#), Some(serde_json::json!({"a": 1})));
        assert_eq!(parse_json(b"[1]"), Some(serde_json::json!([1])));
        assert_eq!(parse_json(b"\"text\""), None);
        assert_eq!(parse_json(b"12"), None);
        assert_eq!(parse_json(b"{bad"), None);
    }

    #[test]
    fn reads_the_media_type() {
        let mut headers = HeaderMap::new();
        assert_eq!(media(&headers), Media::Other);
        headers.insert(
            CONTENT_TYPE,
            "Application/JSON; charset=utf-8".parse().unwrap(),
        );
        assert_eq!(media(&headers), Media::Json);
        headers.insert(
            CONTENT_TYPE,
            "application/x-www-form-urlencoded".parse().unwrap(),
        );
        assert_eq!(media(&headers), Media::Form);
    }
}
