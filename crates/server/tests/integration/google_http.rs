//! The Google adapters over HTTP against a local fake Google server: the
//! request URLs, headers, and bodies, the paging, the failure mapping, the
//! body limit, the redirect policy, and the OAuth requests. The request
//! bodies of the task use cases must equal the bodies that the Node server
//! sent (`crates/domain/tests/fixtures/calendar.golden.json`).

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use caltodo::application::ports::{CalendarApi, GoogleError, OAuthApi};
use caltodo::application::{Services, tasks};
use caltodo::config::{GoogleClient, Secret};
use caltodo::domain::ids::{CalendarId, EventId, UserId};
use caltodo::fakes::{FakeOAuth, FixedClock};
use caltodo::google::calendar::GoogleCalendar;
use caltodo::google::oauth::{Endpoints, GoogleOAuth};
use caltodo::google::{ClientSettings, build_client};
use caltodo::wiring::{self, Adapters};
use serde_json::{Value, json};
use sha2::Digest as _;
use sqlx::PgPool;

use crate::support::{settings, ts};

/// One request that the fake server received.
#[derive(Debug, Clone)]
struct Seen {
    method: Method,
    path: String,
    query: Option<String>,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Seen {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

type Responder = Arc<dyn Fn(&Seen, usize) -> Response + Send + Sync>;

#[derive(Clone)]
struct Fake {
    seen: Arc<Mutex<Vec<Seen>>>,
    respond: Responder,
}

async fn record(State(fake): State<Fake>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body: Bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    let seen = Seen {
        method: parts.method,
        path: parts.uri.path().to_owned(),
        query: parts.uri.query().map(str::to_owned),
        headers: parts.headers,
        body: body.to_vec(),
    };
    let index = {
        let mut list = fake.seen.lock().unwrap();
        list.push(seen.clone());
        list.len() - 1
    };
    (fake.respond)(&seen, index)
}

/// Starts the fake server; returns its base URL and the request log.
async fn serve(
    respond: impl Fn(&Seen, usize) -> Response + Send + Sync + 'static,
) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let fake = Fake {
        seen: Arc::clone(&seen),
        respond: Arc::new(respond),
    };
    let router = Router::new().fallback(record).with_state(fake);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.ok() });
    (format!("http://{address}"), seen)
}

fn client() -> reqwest::Client {
    build_client(ClientSettings { https_only: false }).unwrap()
}

fn json_reply(status: u16, body: &Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn token() -> Secret {
    Secret::new("access-token-1")
}

#[tokio::test]
async fn lists_every_page_with_the_node_query() {
    let (base, seen) = serve(|request, _| {
        let page2 = request.query.as_deref().unwrap_or_default().contains("pageToken=p2");
        let items = if page2 {
            json!([{"id": "b", "start": {"dateTime": "2026-03-02T11:00:00+02:00"}, "end": {"dateTime": "2026-03-02T11:30:00+02:00"}}])
        } else {
            json!([{"id": "a", "start": {"dateTime": "2026-03-02T09:00:00Z"}, "end": {"dateTime": "2026-03-02T09:30:00Z"}}])
        };
        let mut body = json!({"items": items});
        if !page2 {
            body["nextPageToken"] = json!("p2");
        }
        json_reply(200, &body)
    })
    .await;
    let calendar = GoogleCalendar::new(client(), &format!("{base}/calendar/v3")).unwrap();
    let id = CalendarId::new("me@example.com/x").unwrap();
    let events = calendar
        .list_events(
            &token(),
            &id,
            ts("2026-03-01T00:00:00Z"),
            ts("2026-05-30T00:00:00Z"),
        )
        .await
        .unwrap();
    assert_eq!(
        events
            .iter()
            .map(|e| e.id.clone().unwrap())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(events[1].start, Some(ts("2026-03-02T09:00:00Z")));
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen[0].path,
        "/calendar/v3/calendars/me@example.com%2Fx/events"
    );
    assert_eq!(
        seen[0].query.as_deref(),
        Some(
            "timeMin=2026-03-01T00%3A00%3A00.000Z&timeMax=2026-05-30T00%3A00%3A00.000Z&singleEvents=true&orderBy=startTime"
        )
    );
    assert!(seen[1].query.as_deref().unwrap().ends_with("&pageToken=p2"));
    assert_eq!(seen[0].headers["authorization"], "Bearer access-token-1");
    assert!(
        seen[0].headers["user-agent"]
            .to_str()
            .unwrap()
            .starts_with("caltodo/")
    );
}

#[tokio::test]
async fn an_endless_list_fails_instead_of_stopping_silently() {
    let (base, seen) = serve(|_, index| {
        json_reply(
            200,
            &json!({"items": [], "nextPageToken": format!("p{index}")}),
        )
    })
    .await;
    let calendar = GoogleCalendar::new(client(), &base).unwrap();
    let result = calendar
        .list_events(
            &token(),
            &CalendarId::new("primary").unwrap(),
            ts("2026-03-01T00:00:00Z"),
            ts("2026-03-02T00:00:00Z"),
        )
        .await;
    assert_eq!(result, Err(GoogleError::TooManyPages));
    assert_eq!(
        seen.lock().unwrap().len(),
        caltodo::google::calendar::MAX_EVENT_PAGES
    );
}

#[tokio::test]
async fn maps_failures_without_their_text() {
    for (status, expected) in [
        (401, GoogleError::Unauthorized),
        (404, GoogleError::NotFound),
        (410, GoogleError::NotFound),
        (403, GoogleError::Status(403)),
        (500, GoogleError::Status(500)),
    ] {
        let (base, _) =
            serve(move |_, _| json_reply(status, &json!({"error": {"message": "secret detail"}})))
                .await;
        let calendar = GoogleCalendar::new(client(), &base).unwrap();
        let result = calendar
            .get_event(
                &token(),
                &CalendarId::new("primary").unwrap(),
                &EventId::new("e1").unwrap(),
            )
            .await;
        assert_eq!(result, Err(expected), "{status}");
    }
    for body in ["[1,2]", "not json", r#"{"items": "wrong"}"#] {
        let (base, _) = serve(move |_, _| (StatusCode::OK, body).into_response()).await;
        let calendar = GoogleCalendar::new(client(), &base).unwrap();
        let result = calendar
            .list_events(
                &token(),
                &CalendarId::new("primary").unwrap(),
                ts("2026-03-01T00:00:00Z"),
                ts("2026-03-02T00:00:00Z"),
            )
            .await;
        assert_eq!(result, Err(GoogleError::InvalidResponse), "{body}");
    }
}

#[tokio::test]
async fn refuses_a_large_body_and_does_not_follow_redirects() {
    let (base, _) = serve(|_, _| {
        (
            StatusCode::OK,
            "x".repeat(caltodo::google::MAX_BODY_BYTES + 1),
        )
            .into_response()
    })
    .await;
    let calendar = GoogleCalendar::new(client(), &base).unwrap();
    let large = calendar.list_calendars(&token()).await;
    assert_eq!(large, Err(GoogleError::Transport));

    let (target, target_seen) = serve(|_, _| json_reply(200, &json!({"items": []}))).await;
    let location = format!("{target}/stolen");
    let (base, _) = serve(move |_, _| {
        (StatusCode::FOUND, [("location", location.clone())], "").into_response()
    })
    .await;
    let calendar = GoogleCalendar::new(client(), &base).unwrap();
    assert_eq!(
        calendar.list_calendars(&token()).await,
        Err(GoogleError::Status(302))
    );
    assert!(
        target_seen.lock().unwrap().is_empty(),
        "the token must not follow a redirect"
    );
}

#[tokio::test]
async fn an_unreachable_server_is_a_transport_failure() {
    let calendar = GoogleCalendar::new(client(), "http://127.0.0.1:9").unwrap();
    assert_eq!(
        calendar.list_calendars(&token()).await,
        Err(GoogleError::Transport)
    );
    let https_only = GoogleCalendar::new(
        build_client(ClientSettings::default()).unwrap(),
        "http://127.0.0.1:9",
    )
    .unwrap();
    assert_eq!(
        https_only.list_calendars(&token()).await,
        Err(GoogleError::Transport)
    );
}

fn golden() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../domain/tests/fixtures/calendar.golden.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A fake Google that stores events, for the use cases.
async fn stateful_google() -> (String, Arc<Mutex<Vec<Seen>>>) {
    let events: Arc<Mutex<serde_json::Map<String, Value>>> = Arc::default();
    serve(move |request, _| {
        let mut events = events.lock().unwrap();
        let segments: Vec<&str> = request.path.split('/').collect();
        match (request.method.as_str(), segments.as_slice()) {
            ("POST", [_, "calendars", _, "events"]) => {
                let mut event = request.json();
                event["id"] = json!("evt-1");
                event["updated"] = json!("2026-03-02T09:00:00.000Z");
                events.insert("evt-1".into(), event.clone());
                json_reply(200, &event)
            }
            ("GET", [_, "calendars", _, "events"]) => json_reply(
                200,
                &json!({"items": events.values().cloned().collect::<Vec<_>>()}),
            ),
            ("GET", [_, "calendars", _, "events", id]) => match events.get(*id) {
                Some(event) => json_reply(200, event),
                None => json_reply(404, &json!({})),
            },
            ("PATCH", [_, "calendars", _, "events", id]) => {
                let Some(event) = events.get_mut(*id) else {
                    return json_reply(404, &json!({}));
                };
                for (key, value) in request.json().as_object().unwrap() {
                    event[key] = value.clone();
                }
                json_reply(200, event)
            }
            _ => json_reply(404, &json!({})),
        }
    })
    .await
}

async fn services_with(pool: PgPool, base: &str, zone_setting: &str) -> (Services, UserId) {
    let clock = FixedClock::new(ts("2026-03-02T09:00:00Z"));
    let adapters = Adapters {
        calendar: Arc::new(GoogleCalendar::new(client(), base).unwrap()),
        oauth: Arc::new(FakeOAuth::new("/cb")),
        clock: Arc::new(clock),
    };
    let services = wiring::services(pool, &settings("UTC"), &adapters);
    let user = services
        .store
        .record_sign_in(
            &caltodo::db::users::NewUser {
                google_id: "sub".into(),
                email: String::new(),
                display_name: "U".into(),
            },
            &Secret::new("access"),
            None,
        )
        .await
        .unwrap();
    services
        .store
        .save_settings(
            &user.id,
            &caltodo::db::settings::SettingsChange {
                calendar_id: Some("primary".into()),
                work_start_hour: 9,
                work_end_hour: 17,
                timezone: zone_setting.into(),
                default_duration: 30,
                event_color: "7".into(),
            },
        )
        .await
        .unwrap();
    (services, user.id)
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_task_requests_have_the_node_bodies(pool: PgPool) {
    let golden = golden();
    let requests = &golden["requests"];
    let (base, seen) = stateful_google().await;
    let (services, user) = services_with(pool, &base, "Europe/Helsinki").await;

    let created = tasks::create_task(
        &services,
        &user,
        &tasks::NewTask {
            title: "Write tests".into(),
            details: Some("Cover boundary\nSecond line".into()),
            urgent: false,
            duration_minutes: Some(30),
        },
    )
    .await
    .unwrap();
    assert_eq!(created.task.id.as_str(), "evt-1");
    assert!(!created.urgent_move_failed);
    let log = seen.lock().unwrap().clone();
    let insert = log.iter().find(|r| r.method == Method::POST).unwrap();
    let mut expected_insert = requests["createWithDetails"]["insert"]["requestBody"].clone();
    // The Node golden ran at 15:00Z; here the first free slot is 09:00Z.
    expected_insert["start"]["dateTime"] = json!("2026-03-02T09:00:00.000Z");
    expected_insert["end"]["dateTime"] = json!("2026-03-02T09:30:00.000Z");
    assert_eq!(insert.json(), expected_insert);
    let actions = log
        .iter()
        .find(|r| r.method == Method::PATCH)
        .unwrap()
        .json();
    let description = actions["description"].as_str().unwrap();
    let expected = requests["createWithDetails"]["actionsPatch"]["requestBody"]["description"]
        .as_str()
        .unwrap();
    let (prefix, suffix) = expected.split_once("tok-raw").unwrap();
    assert!(description.starts_with(prefix), "{description}");
    assert!(description.ends_with(suffix), "{description}");
    assert_eq!(
        actions.as_object().unwrap().len(),
        1,
        "only the description changes"
    );

    seen.lock().unwrap().clear();
    tasks::set_completion(&services, &user, &EventId::new("evt-1").unwrap(), true)
        .await
        .unwrap();
    let patch = seen
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.method == Method::PATCH)
        .unwrap()
        .json();
    let mut expected_complete = requests["completePatch"]["requestBody"].clone();
    // The golden event had an extra private property; this one has none.
    expected_complete["extendedProperties"]["private"]
        .as_object_mut()
        .unwrap()
        .remove("oldField");
    assert_eq!(patch, expected_complete);

    seen.lock().unwrap().clear();
    tasks::set_completion(&services, &user, &EventId::new("evt-1").unwrap(), false)
        .await
        .unwrap();
    let patch = seen
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.method == Method::PATCH)
        .unwrap()
        .json();
    let mut expected_redo = requests["redoPatch"]["requestBody"].clone();
    expected_redo["extendedProperties"]["private"]
        .as_object_mut()
        .unwrap()
        .remove("oldField");
    assert_eq!(patch, expected_redo);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn the_time_patch_has_the_node_body(pool: PgPool) {
    let golden = golden();
    let (base, seen) = stateful_google().await;
    let (services, user) = services_with(pool, &base, "America/New_York").await;
    tasks::create_task(
        &services,
        &user,
        &tasks::NewTask {
            title: "T".into(),
            details: None,
            urgent: false,
            duration_minutes: Some(45),
        },
    )
    .await
    .unwrap();
    // Move the event so that the reschedule patches its time.
    seen.lock().unwrap().clear();
    tasks::reschedule_task(&services, &user, &EventId::new("evt-1").unwrap())
        .await
        .unwrap();
    let patch = seen
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.method == Method::PATCH)
        .unwrap()
        .json();
    let expected = &golden["requests"]["timePatch"]["requestBody"];
    assert_eq!(
        patch.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["end", "start"]
    );
    assert_eq!(patch["start"]["timeZone"], expected["start"]["timeZone"]);
    assert_eq!(patch["end"]["timeZone"], expected["end"]["timeZone"]);
    let start = patch["start"]["dateTime"].as_str().unwrap();
    assert_eq!(start.len(), 24, "{start}");
    assert_eq!(start.get(19..), Some(".000Z"), "{start}");
}

fn oauth(base: &str) -> GoogleOAuth {
    GoogleOAuth::new(
        client(),
        &GoogleClient {
            client_id: "client-1.apps.googleusercontent.com".into(),
            client_secret: Secret::new("client-secret-1"),
        },
        "https://todo.example/api/auth/google/callback",
        &Endpoints {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: format!("{base}/token"),
            userinfo: format!("{base}/userinfo"),
        },
    )
    .unwrap()
}

fn form(body: &[u8]) -> std::collections::BTreeMap<String, String> {
    form_urlencoded::parse(body).into_owned().collect()
}

#[tokio::test]
async fn the_authorization_url_has_the_passport_parameters_and_pkce() {
    let authorization = oauth("http://127.0.0.1:9").begin().unwrap();
    let url = reqwest::Url::parse(&authorization.url).unwrap();
    assert_eq!(
        url.as_str().split('?').next(),
        Some("https://accounts.google.com/o/oauth2/v2/auth")
    );
    let query: std::collections::BTreeMap<String, String> =
        url.query_pairs().into_owned().collect();
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["client_id"], "client-1.apps.googleusercontent.com");
    assert_eq!(
        query["redirect_uri"],
        "https://todo.example/api/auth/google/callback"
    );
    assert_eq!(
        query["scope"],
        "profile email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.owned"
    );
    assert_eq!(query["access_type"], "offline");
    assert_eq!(query["prompt"], "consent");
    assert_eq!(query["state"], authorization.state.expose());
    assert_eq!(query["code_challenge_method"], "S256");
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(
        authorization.pkce_verifier.expose().as_bytes(),
    ));
    assert_eq!(query["code_challenge"], challenge);
    assert_ne!(
        oauth("http://127.0.0.1:9").begin().unwrap().state,
        authorization.state
    );
}

#[tokio::test]
async fn exchanges_the_code_and_reads_the_profile() {
    let (base, seen) = serve(|request, _| match request.path.as_str() {
        "/token" => json_reply(200, &json!({"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "profile email", "extra": 1})),
        "/userinfo" => json_reply(200, &json!({"sub": "1093", "email": "a@example.com", "name": "Ann", "picture": "x"})),
        _ => json_reply(404, &json!({})),
    })
    .await;
    let oauth = oauth(&base);
    let grant = oauth
        .exchange_code("code-1", &Secret::new("verifier-1"))
        .await
        .unwrap();
    assert_eq!(grant.access_token.expose(), "at-1");
    assert_eq!(
        grant.refresh_token.as_ref().map(Secret::expose),
        Some("rt-1")
    );
    let profile = oauth.profile(&grant.access_token).await.unwrap();
    assert_eq!(profile.sub, "1093");
    assert_eq!(profile.email.as_deref(), Some("a@example.com"));
    assert_eq!(profile.name.as_deref(), Some("Ann"));
    let log = seen.lock().unwrap().clone();
    let token_form = form(&log[0].body);
    assert_eq!(token_form["grant_type"], "authorization_code");
    assert_eq!(token_form["code"], "code-1");
    assert_eq!(token_form["code_verifier"], "verifier-1");
    assert_eq!(
        token_form["client_id"],
        "client-1.apps.googleusercontent.com"
    );
    assert_eq!(token_form["client_secret"], "client-secret-1");
    assert_eq!(
        token_form["redirect_uri"],
        "https://todo.example/api/auth/google/callback"
    );
    assert_eq!(log[1].headers["authorization"], "Bearer at-1");
}

#[tokio::test]
async fn a_refused_refresh_token_is_reported() {
    let (base, seen) = serve(|request, _| {
        let fields = form(&request.body);
        if fields.get("refresh_token").map(String::as_str) == Some("good") {
            json_reply(200, &json!({"access_token": "at-2", "expires_in": 3599, "token_type": "Bearer"}))
        } else {
            json_reply(400, &json!({"error": "invalid_grant", "error_description": "Token has been expired or revoked."}))
        }
    })
    .await;
    let oauth = oauth(&base);
    let fresh = oauth.refresh(&Secret::new("good")).await.unwrap();
    assert_eq!(fresh.access_token.expose(), "at-2");
    assert!(fresh.refresh_token.is_none());
    assert_eq!(
        form(&seen.lock().unwrap()[0].body)["grant_type"],
        "refresh_token"
    );
    let refused = oauth.refresh(&Secret::new("revoked")).await;
    assert_eq!(refused.unwrap_err(), GoogleError::RefreshRejected);
}
