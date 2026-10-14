//! The shared harness of the HTTP tests: the real router on a real
//! PostgreSQL database (`#[sqlx::test]`), with the fake Google services and
//! a fixed clock.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::header::{ACCEPT, CONTENT_TYPE, COOKIE, LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use caltodo::application::Services;
use caltodo::application::ports::{CalendarSummary, GoogleProfile};
use caltodo::config::{BuildInfo, Secret};
use caltodo::domain::event::{CalendarEvent, task_properties};
use caltodo::fakes::{FakeCalendar, FakeOAuth, FixedClock};
use caltodo::http::static_files::StaticSite;
use caltodo::wiring::{self, Adapters, ServiceSettings};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt as _;

pub const ORIGIN: &str = "https://todo.example";
pub const CALLBACK: &str = "/api/auth/google/callback";

pub fn ts(text: &str) -> Timestamp {
    text.parse().unwrap()
}

pub fn settings(zone: &str) -> ServiceSettings {
    ServiceSettings {
        token_encryption_key: Secret::new("test-token-encryption-key-0123456789abcdef"),
        action_token_secret: Secret::new("test-action-token-secret-0123456789abcdef"),
        session_secret: Secret::new("test-session-secret-0123456789abcdef-xyz"),
        app_origin: ORIGIN.to_owned(),
        process_zone: TimeZone::get(zone).unwrap(),
        production: false,
    }
}

/// The router with fakes on a migrated test database.
pub struct TestApp {
    pub router: Router,
    pub services: Services,
    pub calendar: FakeCalendar,
    pub oauth: FakeOAuth,
    pub clock: FixedClock,
    pub pool: PgPool,
}

impl TestApp {
    pub fn new(pool: PgPool) -> Self {
        Self::with(pool, &settings("UTC"), None)
    }

    pub fn with(
        pool: PgPool,
        settings: &ServiceSettings,
        web_build: Option<&std::path::Path>,
    ) -> Self {
        let clock = FixedClock::new(ts("2026-03-02T09:00:00Z"));
        let calendar = FakeCalendar::new(Arc::new(clock.clone()));
        let oauth = FakeOAuth::new(CALLBACK);
        let adapters = Adapters {
            calendar: Arc::new(calendar.clone()),
            oauth: Arc::new(oauth.clone()),
            clock: Arc::new(clock.clone()),
        };
        let services = wiring::services(pool.clone(), settings, &adapters);
        let site = StaticSite::new(web_build.map_or_else(
            || std::path::PathBuf::from("/nonexistent"),
            ToOwned::to_owned,
        ));
        let state = wiring::state(services.clone(), settings, site, BuildInfo::default()).unwrap();
        Self {
            router: caltodo::http::app(state),
            services,
            calendar,
            oauth,
            clock,
            pool,
        }
    }

    pub async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        Reply {
            status,
            headers,
            body: bytes.to_vec(),
        }
    }

    /// Signs in through the OAuth routes as the given Google account.
    pub async fn sign_in(&self, sub: &str, email: &str, name: &str) -> Client {
        self.sign_in_with(sub, email, name, None).await
    }

    pub async fn sign_in_with(
        &self,
        sub: &str,
        email: &str,
        name: &str,
        action_token: Option<&str>,
    ) -> Client {
        let code = format!("code-{sub}");
        self.oauth.code_for(
            &code,
            GoogleProfile {
                sub: sub.to_owned(),
                email: Some(email.to_owned()),
                name: Some(name.to_owned()),
            },
        );
        let start_path = action_token.map_or_else(
            || "/api/auth/google".to_owned(),
            |token| format!("/api/auth/google?actionToken={token}"),
        );
        let start = self.send(request(Method::GET, &start_path).build()).await;
        assert_eq!(start.status, StatusCode::FOUND);
        let mut client = Client::default();
        client.absorb(&start);
        let location = start.header(LOCATION.as_str()).unwrap();
        let state = location.split("state=").nth(1).unwrap().to_owned();
        let callback = self
            .send(
                client
                    .request(
                        Method::GET,
                        &format!("{CALLBACK}?code={code}&state={state}"),
                    )
                    .build(),
            )
            .await;
        assert_eq!(callback.status, StatusCode::FOUND, "{}", callback.text());
        client.absorb(&callback);
        client.last_location = callback.header(LOCATION.as_str()).map(str::to_owned);
        let user = self
            .send(client.request(Method::GET, "/api/auth/user").build())
            .await;
        assert_eq!(user.status, StatusCode::OK, "{}", user.text());
        let json = user.json();
        client.csrf = json["csrfToken"].as_str().map(str::to_owned);
        client.user_id = json["id"].as_str().map(str::to_owned);
        client
    }

    /// Settings with a calendar for the user of `client`.
    pub async fn configure_calendar(&self, client: &Client, zone: &str) {
        let reply = self
            .send(
                client
                    .request(Method::PATCH, "/api/settings")
                    .json(&serde_json::json!({
                        "calendarId": "primary",
                        "workStartHour": 9,
                        "workEndHour": 17,
                        "timezone": zone,
                        "defaultDuration": 30,
                        "eventColor": "2",
                    }))
                    .build(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    }

    pub fn calendars(&self, calendars: &[(&str, &str, bool)]) {
        self.calendar.set_calendars(
            calendars
                .iter()
                .map(|(id, summary, primary)| CalendarSummary {
                    id: (*id).to_owned(),
                    summary: (*summary).to_owned(),
                    primary: *primary,
                })
                .collect(),
        );
    }
}

/// A browser: the session cookie and the CSRF token.
#[derive(Debug, Clone, Default)]
pub struct Client {
    pub cookie: Option<String>,
    pub csrf: Option<String>,
    pub user_id: Option<String>,
    pub last_location: Option<String>,
}

impl Client {
    /// Takes the session cookie of a response, or drops it when the response
    /// removes it.
    pub fn absorb(&mut self, reply: &Reply) {
        for value in reply.headers.get_all(SET_COOKIE) {
            let text = value.to_str().unwrap();
            let pair = text.split(';').next().unwrap();
            if let Some(value) = pair.strip_prefix("caltodo.sid=") {
                if value.is_empty() || text.contains("Max-Age=0") {
                    self.cookie = None;
                } else {
                    self.cookie = Some(pair.to_owned());
                }
            }
        }
    }

    pub fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let safe = method == Method::GET;
        let mut builder = request(method, path);
        if let Some(cookie) = &self.cookie {
            builder = builder.header(COOKIE.as_str(), cookie);
        }
        if !safe && let Some(csrf) = &self.csrf {
            builder = builder.header("x-csrf-token", csrf);
        }
        builder
    }
}

pub struct RequestBuilder {
    method: Method,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

pub fn request(method: Method, path: &str) -> RequestBuilder {
    RequestBuilder {
        method,
        path: path.to_owned(),
        headers: Vec::new(),
        body: Vec::new(),
    }
}

impl RequestBuilder {
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.retain(|(n, _)| n != name);
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn without_header(mut self, name: &str) -> Self {
        self.headers.retain(|(n, _)| n != name);
        self
    }

    pub fn json(self, value: &Value) -> Self {
        self.raw(
            CONTENT_TYPE.as_str(),
            "application/json",
            value.to_string().into_bytes(),
        )
    }

    pub fn form(self, pairs: &[(&str, &str)]) -> Self {
        let body = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        self.raw(
            CONTENT_TYPE.as_str(),
            "application/x-www-form-urlencoded",
            body.into_bytes(),
        )
    }

    pub fn raw(mut self, name: &str, content_type: &str, body: Vec<u8>) -> Self {
        self = self.header(name, content_type);
        self.body = body;
        self
    }

    pub fn accept_html(self) -> Self {
        self.header(ACCEPT.as_str(), "text/html,application/xhtml+xml")
    }

    pub fn build(self) -> Request<Body> {
        let mut builder = Request::builder().method(self.method).uri(self.path);
        for (name, value) in self.headers {
            builder = builder.header(name, value);
        }
        builder.body(Body::from(self.body)).unwrap()
    }
}

/// A finished response.
#[derive(Debug)]
pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.text()))
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// Asserts a Problem Details answer and returns its code.
    pub fn problem(&self, status: StatusCode) -> String {
        assert_eq!(self.status, status, "{}", self.text());
        assert_eq!(
            self.header("content-type"),
            Some("application/problem+json")
        );
        let json = self.json();
        assert_eq!(json["type"], "about:blank");
        assert_eq!(json["status"], status.as_u16());
        json["code"].as_str().unwrap().to_owned()
    }
}

/// A task event with the format of this app.
pub fn task_event(
    id: &str,
    title: &str,
    start: &str,
    end: &str,
    completed: Option<bool>,
) -> CalendarEvent {
    let mut properties = task_properties(completed.unwrap_or(false));
    if completed.is_none() {
        properties.remove("caltodoCompleted");
    }
    CalendarEvent {
        id: Some(id.to_owned()),
        status: Some("confirmed".to_owned()),
        summary: Some(format!(
            "{}{title}",
            if completed == Some(true) {
                "✅ "
            } else {
                "☑️ "
            }
        )),
        description: Some(format!("Details of {title}\n\n---\nCreated by Todo")),
        start: Some(ts(start)),
        end: Some(ts(end)),
        updated: Some(ts("2026-03-01T08:00:00Z")),
        transparency: None,
        private_properties: properties,
    }
}

/// A busy event of another app.
pub fn busy_event(id: &str, start: &str, end: &str) -> CalendarEvent {
    CalendarEvent {
        id: Some(id.to_owned()),
        status: Some("confirmed".to_owned()),
        summary: Some("Meeting".to_owned()),
        start: Some(ts(start)),
        end: Some(ts(end)),
        ..CalendarEvent::default()
    }
}
