//! Google OAuth 2.0 with the oauth2 crate, and the userinfo endpoint (ADR 0002).
//!
//! The request matches passport-google-oauth20 of the Node server: the
//! scopes `profile email calendar.readonly calendar.events.owned`,
//! `access_type=offline`, `prompt=consent`, and a `state` value. PKCE is new.
//! The client secret goes in the request body, like passport-oauth2. The
//! user id is the `sub` of the userinfo response, which Passport used as
//! `profile.id`.

use oauth2::basic::{BasicClient, BasicErrorResponseType};
use oauth2::{
    AuthType, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet,
    EndpointSet, HttpRequest, HttpResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl,
    RefreshToken, RequestTokenError, Scope, TokenResponse, TokenUrl,
};
use serde::Deserialize;

use super::{decode_object, send, status_error};
use crate::application::ports::{
    Authorization, BoxFuture, GoogleError, GoogleProfile, OAuthApi, TokenGrant,
};
use crate::config::{GoogleClient, Secret};
use crate::security::random_base64url;

/// The authorization endpoint of passport-google-oauth20.
pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// The token endpoint of passport-google-oauth20.
pub const TOKEN_URL: &str = "https://www.googleapis.com/oauth2/v4/token";
/// The userinfo endpoint of passport-google-oauth20 2.0.
pub const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

/// The scopes of `GOOGLE_OAUTH_SCOPES`.
pub const SCOPES: [&str; 4] = [
    "profile",
    "email",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events.owned",
];

/// The random bytes of the `state` value and of the PKCE verifier.
const RANDOM_BYTES: usize = 32;

type ConfiguredClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

/// The endpoints of the OAuth adapter; tests point them at a fake server.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub auth: String,
    pub token: String,
    pub userinfo: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            auth: AUTH_URL.to_owned(),
            token: TOKEN_URL.to_owned(),
            userinfo: USERINFO_URL.to_owned(),
        }
    }
}

/// The OAuth client.
#[derive(Debug, Clone)]
pub struct GoogleOAuth {
    oauth: ConfiguredClient,
    http: OAuthHttp,
    userinfo: reqwest::Url,
}

/// The oauth2 HTTP client: the shared client with its limits.
#[derive(Debug, Clone)]
struct OAuthHttp(reqwest::Client);

impl<'c> oauth2::AsyncHttpClient<'c> for OAuthHttp {
    type Error = OAuthHttpError;
    type Future = BoxFuture<'c, Result<HttpResponse, OAuthHttpError>>;

    fn call(&'c self, request: HttpRequest) -> Self::Future {
        Box::pin(async move {
            let (parts, body) = request.into_parts();
            let builder = self
                .0
                .request(parts.method, parts.uri.to_string())
                .headers(parts.headers)
                .body(body);
            let (status, bytes) = send(builder).await.map_err(|_| OAuthHttpError)?;
            http::Response::builder()
                .status(status)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(bytes)
                .map_err(|_| OAuthHttpError)
        })
    }
}

/// A transport failure of the OAuth client. The text is fixed.
#[derive(Debug, thiserror::Error)]
#[error("the Google request failed")]
pub struct OAuthHttpError;

#[derive(Debug, Deserialize)]
struct UserInfo {
    sub: String,
    email: Option<String>,
    name: Option<String>,
}

impl GoogleOAuth {
    /// The client of the configured Google OAuth application.
    ///
    /// # Errors
    ///
    /// An endpoint or the callback URL is no valid URL.
    pub fn new(
        http: reqwest::Client,
        google: &GoogleClient,
        callback_url: &str,
        endpoints: &Endpoints,
    ) -> Result<Self, GoogleError> {
        let invalid = |_| GoogleError::Transport;
        let oauth = BasicClient::new(ClientId::new(google.client_id.clone()))
            .set_client_secret(ClientSecret::new(google.client_secret.expose().to_owned()))
            .set_auth_type(AuthType::RequestBody)
            .set_auth_uri(AuthUrl::new(endpoints.auth.clone()).map_err(invalid)?)
            .set_token_uri(TokenUrl::new(endpoints.token.clone()).map_err(invalid)?)
            .set_redirect_uri(RedirectUrl::new(callback_url.to_owned()).map_err(invalid)?);
        let userinfo = reqwest::Url::parse(&endpoints.userinfo).map_err(invalid)?;
        Ok(Self {
            oauth,
            http: OAuthHttp(http),
            userinfo,
        })
    }
}

fn token_error<RE: std::error::Error + 'static>(
    error: &RequestTokenError<RE, oauth2::basic::BasicErrorResponse>,
) -> GoogleError {
    match error {
        RequestTokenError::ServerResponse(response)
            if *response.error() == BasicErrorResponseType::InvalidGrant =>
        {
            GoogleError::RefreshRejected
        }
        RequestTokenError::ServerResponse(_) => GoogleError::Status(400),
        RequestTokenError::Request(_) => GoogleError::Transport,
        RequestTokenError::Parse(..) | RequestTokenError::Other(_) => GoogleError::InvalidResponse,
    }
}

fn grant(token: &oauth2::basic::BasicTokenResponse) -> TokenGrant {
    TokenGrant {
        access_token: Secret::new(token.access_token().secret().clone()),
        refresh_token: token
            .refresh_token()
            .map(|refresh| Secret::new(refresh.secret().clone())),
    }
}

impl OAuthApi for GoogleOAuth {
    fn begin(&self) -> Result<Authorization, GoogleError> {
        let state = random_base64url(RANDOM_BYTES).map_err(|_| GoogleError::Transport)?;
        let verifier = random_base64url(RANDOM_BYTES).map_err(|_| GoogleError::Transport)?;
        let challenge =
            PkceCodeChallenge::from_code_verifier_sha256(&PkceCodeVerifier::new(verifier.clone()));
        let state_value = state.clone();
        let (url, _) = self
            .oauth
            .authorize_url(move || CsrfToken::new(state_value))
            .add_scopes(SCOPES.iter().map(|scope| Scope::new((*scope).to_owned())))
            .add_extra_param("access_type", "offline")
            .add_extra_param("prompt", "consent")
            .set_pkce_challenge(challenge)
            .url();
        Ok(Authorization {
            url: url.to_string(),
            state: Secret::new(state),
            pkce_verifier: Secret::new(verifier),
        })
    }

    fn exchange_code<'a>(
        &'a self,
        code: &'a str,
        pkce_verifier: &'a Secret,
    ) -> BoxFuture<'a, Result<TokenGrant, GoogleError>> {
        Box::pin(async move {
            let token = self
                .oauth
                .exchange_code(AuthorizationCode::new(code.to_owned()))
                .set_pkce_verifier(PkceCodeVerifier::new(pkce_verifier.expose().to_owned()))
                .request_async(&self.http)
                .await
                .map_err(|error| token_error(&error))?;
            Ok(grant(&token))
        })
    }

    fn refresh<'a>(
        &'a self,
        refresh_token: &'a Secret,
    ) -> BoxFuture<'a, Result<TokenGrant, GoogleError>> {
        Box::pin(async move {
            let refresh = RefreshToken::new(refresh_token.expose().to_owned());
            let token = self
                .oauth
                .exchange_refresh_token(&refresh)
                .request_async(&self.http)
                .await
                .map_err(|error| token_error(&error))?;
            Ok(grant(&token))
        })
    }

    fn profile<'a>(
        &'a self,
        access_token: &'a Secret,
    ) -> BoxFuture<'a, Result<GoogleProfile, GoogleError>> {
        Box::pin(async move {
            let request = self
                .http
                .0
                .get(self.userinfo.clone())
                .bearer_auth(access_token.expose());
            let (status, body) = send(request).await?;
            if !(200..300).contains(&status) {
                return Err(status_error(status));
            }
            let info: UserInfo = decode_object(&body)?;
            if info.sub.is_empty() {
                return Err(GoogleError::InvalidResponse);
            }
            Ok(GoogleProfile {
                sub: info.sub,
                email: info.email,
                name: info.name,
            })
        })
    }
}
