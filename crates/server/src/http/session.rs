//! The session cookie and the session data (ADR 0002).
//!
//! The session lives in `app_sessions`. The cookie `caltodo.sid` holds only
//! the signed random session id: `HttpOnly`, `SameSite=Lax` (the Google
//! redirect back to the callback is a cross-site navigation), `Path=/`,
//! `Secure` in production, and a 7-day lifetime. The Node cookie
//! `connect.sid` is ignored, so every user signs in once after the change.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use caltodo_domain::ids::UserId;
use tower_sessions::cookie::{Key, SameSite};
use tower_sessions::service::SignedCookie;
use tower_sessions::{Expiry, Session, SessionManagerLayer};

use super::AppState;
use super::errors::{Problem, ProblemCode};
use crate::config::Secret;
use crate::db::sessions::{PgSessionStore, USER_ID_KEY};
use crate::db::users::User;
use crate::security::random_hex;

/// The session cookie name.
pub const COOKIE_NAME: &str = "caltodo.sid";
/// The session lifetime after the last change.
pub const LIFETIME_DAYS: i64 = 7;

/// The session data key of the CSRF token.
pub const CSRF_TOKEN_KEY: &str = "csrf_token";
/// The action token of a sign-in that started on an action page.
pub const PENDING_ACTION_KEY: &str = "pending_action_token";
/// The OAuth `state` of a started sign-in.
pub const OAUTH_STATE_KEY: &str = "oauth_state";
/// The PKCE verifier of a started sign-in.
pub const OAUTH_VERIFIER_KEY: &str = "oauth_pkce_verifier";

/// The CSRF token bytes, like `crypto.randomBytes(32).toString("hex")`.
const CSRF_TOKEN_BYTES: usize = 32;

/// The settings of the session layer.
#[derive(Clone)]
pub struct SessionSettings {
    pub store: PgSessionStore,
    pub key: Key,
    pub secure: bool,
}

impl std::fmt::Debug for SessionSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionSettings")
            .field("secure", &self.secure)
            .finish_non_exhaustive()
    }
}

/// The session secret is shorter than the 32 bytes of a signing key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("SESSION_SECRET is too short for a signing key")]
pub struct ShortSessionSecret;

impl SessionSettings {
    /// The settings with the cookie key derived from `SESSION_SECRET`.
    ///
    /// # Errors
    ///
    /// The secret has fewer than 32 bytes.
    pub fn new(
        store: PgSessionStore,
        secret: &Secret,
        secure: bool,
    ) -> Result<Self, ShortSessionSecret> {
        use sha2::{Digest, Sha512};
        let bytes = secret.expose().as_bytes();
        if bytes.len() < 32 {
            return Err(ShortSessionSecret);
        }
        // The cookie key needs 64 bytes. SHA-512 of the secret, with a label
        // that keeps this key apart from other uses of the secret, gives
        // them.
        let mut hasher = Sha512::new();
        hasher.update(b"caltodo session cookie key v1\0");
        hasher.update(bytes);
        let material = hasher.finalize();
        let key = Key::try_from(material.as_slice()).map_err(|_| ShortSessionSecret)?;
        Ok(Self { store, key, secure })
    }

    /// The tower-sessions layer.
    #[must_use]
    pub fn layer(&self) -> SessionManagerLayer<PgSessionStore, SignedCookie> {
        SessionManagerLayer::new(self.store.clone())
            .with_name(COOKIE_NAME)
            .with_http_only(true)
            .with_same_site(SameSite::Lax)
            .with_path("/")
            .with_secure(self.secure)
            .with_expiry(Expiry::OnInactivity(time::Duration::days(LIFETIME_DAYS)))
            .with_signed(self.key.clone())
    }
}

/// The session store failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("session store failed")]
pub struct SessionFailed;

impl IntoResponse for SessionFailed {
    fn into_response(self) -> Response {
        Problem::new(ProblemCode::InternalError).into_response()
    }
}

/// A text value of the session.
///
/// # Errors
///
/// The session store fails.
pub async fn get_text(session: &Session, key: &str) -> Result<Option<String>, SessionFailed> {
    session.get::<String>(key).await.map_err(|_| SessionFailed)
}

/// Sets a text value of the session.
///
/// # Errors
///
/// The session store fails.
pub async fn set_text(session: &Session, key: &str, value: &str) -> Result<(), SessionFailed> {
    session.insert(key, value).await.map_err(|_| SessionFailed)
}

/// Removes a text value and returns it.
///
/// # Errors
///
/// The session store fails.
pub async fn take_text(session: &Session, key: &str) -> Result<Option<String>, SessionFailed> {
    session
        .remove::<String>(key)
        .await
        .map_err(|_| SessionFailed)
}

/// The CSRF token of the session, made on first use (`ensureCsrfToken`).
///
/// # Errors
///
/// The session store or the random source fails.
pub async fn ensure_csrf_token(session: &Session) -> Result<String, SessionFailed> {
    if let Some(token) = get_text(session, CSRF_TOKEN_KEY).await? {
        return Ok(token);
    }
    let token = random_hex(CSRF_TOKEN_BYTES).map_err(|_| SessionFailed)?;
    set_text(session, CSRF_TOKEN_KEY, &token).await?;
    Ok(token)
}

/// Starts a signed-in session for `user`: a new session id against session
/// fixation, a new CSRF token, and no other data (`req.session.regenerate`).
///
/// # Errors
///
/// The session store or the random source fails.
pub async fn sign_in(session: &Session, user: &UserId) -> Result<(), SessionFailed> {
    session.clear().await;
    session.cycle_id().await.map_err(|_| SessionFailed)?;
    set_text(session, USER_ID_KEY, user.as_str()).await?;
    let token = random_hex(CSRF_TOKEN_BYTES).map_err(|_| SessionFailed)?;
    set_text(session, CSRF_TOKEN_KEY, &token).await
}

/// The signed-in user of the session, read from the database on every
/// request like Passport `deserializeUser`. A session of a deleted user is
/// no sign-in.
///
/// # Errors
///
/// The session store or the database fails.
pub async fn current_user(
    state: &AppState,
    session: &Session,
) -> Result<Option<User>, SessionFailed> {
    let Some(id) = get_text(session, USER_ID_KEY).await?.and_then(UserId::new) else {
        return Ok(None);
    };
    state
        .services
        .store
        .user(&id)
        .await
        .map_err(|_| SessionFailed)
}

/// The signed-in user of a protected route (`requireAuth`): 401 without one.
#[derive(Debug, Clone)]
pub struct SignedIn {
    pub user: User,
    pub session: Session,
}

impl FromRequestParts<AppState> for SignedIn {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        let session = parts
            .extensions
            .get::<Session>()
            .cloned()
            .ok_or_else(|| SessionFailed.into_response())?;
        match current_user(state, &session).await {
            Ok(Some(user)) => Ok(Self { user, session }),
            Ok(None) => Err(Problem::new(ProblemCode::Unauthenticated).into_response()),
            Err(failed) => Err(failed.into_response()),
        }
    }
}

/// The session of a request.
#[derive(Debug, Clone)]
pub struct RequestSession(pub Session);

impl FromRequestParts<AppState> for RequestSession {
    type Rejection = Response;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> impl Future<Output = Result<Self, Response>> + Send {
        let session = parts.extensions.get::<Session>().cloned();
        std::future::ready(
            session
                .map(Self)
                .ok_or_else(|| SessionFailed.into_response()),
        )
    }
}
