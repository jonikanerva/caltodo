//! Request rate limits per client address (express-rate-limit on the Node
//! server).
//!
//! | Paths | Limit |
//! | --- | --- |
//! | `/api/…` | 120 per minute |
//! | `/api/auth/google`, `/api/auth/google/callback` | 25 per 15 minutes |
//! | `/api/action/…` and `/action/…` (one shared counter) | 40 per 15 minutes |
//!
//! A request passes each matching limiter in that order and counts in each.
//! The first full limiter answers 429. A window starts at the first request
//! of a client and lasts its full length (fixed window). The client address
//! is the last `X-Forwarded-For` entry, which Railway's proxy adds (Express
//! `trust proxy 1`), or else the peer address. An IPv6 address counts by its
//! /56 prefix, like express-rate-limit 8.
//!
//! Each limiter keeps at most [`MAX_CLIENTS`] counters in memory. When it is
//! full, it removes the expired counters and then the oldest one.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tokio::time::Instant;

use super::errors::{Problem, ProblemCode};

/// The most counters of one limiter.
pub const MAX_CLIENTS: usize = 10_000;

/// One fixed-window limiter.
#[derive(Debug)]
pub struct Limiter {
    limit: u32,
    window: Duration,
    clients: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

/// The decision of a limiter for one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub allowed: bool,
    pub limit: u32,
    pub remaining: u32,
    /// Seconds until the window ends, at least 1.
    pub reset_seconds: u64,
    pub window_seconds: u64,
}

impl Limiter {
    #[must_use]
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one request of `client` at `now`.
    pub fn check(&self, client: IpAddr, now: Instant) -> Decision {
        let mut clients = self.clients.lock().unwrap_or_else(PoisonError::into_inner);
        if !clients.contains_key(&client) && clients.len() >= MAX_CLIENTS {
            let window = self.window;
            clients.retain(|_, (start, _)| now.duration_since(*start) < window);
            if clients.len() >= MAX_CLIENTS
                && let Some(oldest) = clients
                    .iter()
                    .min_by_key(|(_, (start, _))| *start)
                    .map(|(key, _)| *key)
            {
                clients.remove(&oldest);
            }
        }
        let entry = clients.entry(client).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
        let count = entry.1;
        let left = self.window.saturating_sub(now.duration_since(entry.0));
        Decision {
            allowed: count <= self.limit,
            limit: self.limit,
            remaining: self.limit.saturating_sub(count),
            reset_seconds: (left.as_secs() + u64::from(left.subsec_nanos() > 0)).max(1),
            window_seconds: self.window.as_secs(),
        }
    }

    /// The number of counters, for tests.
    #[must_use]
    pub fn len(&self) -> usize {
        self.clients
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The three limiters of the server.
#[derive(Debug)]
pub struct RateLimits {
    pub api: Limiter,
    pub auth: Limiter,
    pub action: Limiter,
}

impl Default for RateLimits {
    fn default() -> Self {
        Self {
            api: Limiter::new(120, Duration::from_mins(1)),
            auth: Limiter::new(25, Duration::from_mins(15)),
            action: Limiter::new(40, Duration::from_mins(15)),
        }
    }
}

/// True when `path` is `prefix` or below it, at a segment boundary (the
/// path matching of `app.use(prefix, …)`).
fn under(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

impl RateLimits {
    /// The limiters that apply to a path, in order.
    fn for_path(&self, path: &str) -> Vec<&Limiter> {
        let mut limiters = Vec::with_capacity(2);
        if under(path, "/api") {
            limiters.push(&self.api);
        }
        if under(path, "/api/auth/google") {
            limiters.push(&self.auth);
        }
        if under(path, "/api/action") || under(path, "/action") {
            limiters.push(&self.action);
        }
        limiters
    }
}

/// The client key of a request.
#[must_use]
pub fn client_key(headers: &HeaderMap, peer: Option<SocketAddr>) -> IpAddr {
    let forwarded = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .rfind(|value| !value.is_empty())
        .and_then(|value| value.parse::<IpAddr>().ok());
    let address = forwarded
        .or_else(|| peer.map(|peer| peer.ip()))
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));
    match address {
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                IpAddr::V4(v4)
            } else {
                let mut segments = v6.segments();
                segments[3] &= 0xff00;
                for segment in &mut segments[4..] {
                    *segment = 0;
                }
                IpAddr::V6(Ipv6Addr::from(segments))
            }
        }
        v4 @ IpAddr::V4(_) => v4,
    }
}

fn header_value(value: &impl ToString) -> Option<HeaderValue> {
    HeaderValue::from_str(&value.to_string()).ok()
}

/// The `RateLimit-*` headers (IETF draft 6, `standardHeaders: true`).
fn add_headers(headers: &mut HeaderMap, decision: &Decision) {
    let pairs = [
        (
            "ratelimit-policy",
            format!("{};w={}", decision.limit, decision.window_seconds),
        ),
        ("ratelimit-limit", decision.limit.to_string()),
        ("ratelimit-remaining", decision.remaining.to_string()),
        ("ratelimit-reset", decision.reset_seconds.to_string()),
    ];
    for (name, value) in pairs {
        if let Some(value) = header_value(&value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    }
}

/// The answer of a full limiter: a problem for an `/api` path, the text of
/// express-rate-limit otherwise.
fn limited(path: &str, decision: &Decision) -> Response {
    let mut response = if under(path, "/api") {
        Problem::new(ProblemCode::RateLimited).into_response()
    } else {
        (
            StatusCode::TOO_MANY_REQUESTS,
            [(CONTENT_TYPE, "text/plain; charset=utf-8")],
            ProblemCode::RateLimited.detail(),
        )
            .into_response()
    };
    if let Some(value) = header_value(&decision.reset_seconds) {
        response.headers_mut().insert(RETRY_AFTER, value);
    }
    response
}

/// The middleware.
pub async fn limit(
    State(limits): State<std::sync::Arc<RateLimits>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0);
    let client = client_key(request.headers(), peer);
    let now = Instant::now();
    let mut last = None;
    for limiter in limits.for_path(&path) {
        let decision = limiter.check(client, now);
        if !decision.allowed {
            let mut response = limited(&path, &decision);
            add_headers(response.headers_mut(), &decision);
            return response;
        }
        last = Some(decision);
    }
    let mut response = next.run(request).await;
    if let Some(decision) = last {
        add_headers(response.headers_mut(), &decision);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn limits_each_client_in_a_fixed_window() {
        let limiter = Limiter::new(2, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(limiter.check(ip("10.0.0.1"), t0).allowed);
        assert!(limiter.check(ip("10.0.0.1"), t0).allowed);
        let third = limiter.check(ip("10.0.0.1"), t0 + Duration::from_millis(1500));
        assert!(!third.allowed);
        assert_eq!(third.reset_seconds, 59);
        assert!(limiter.check(ip("10.0.0.2"), t0).allowed);
        assert!(
            limiter
                .check(ip("10.0.0.1"), t0 + Duration::from_secs(60))
                .allowed
        );
    }

    #[test]
    fn keeps_a_bounded_number_of_clients() {
        let limiter = Limiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        for n in 0..u32::try_from(MAX_CLIENTS).unwrap() + 5 {
            limiter.check(IpAddr::from(n.to_be_bytes()), t0);
        }
        assert_eq!(limiter.len(), MAX_CLIENTS);
        // After the window, the expired counters go first.
        limiter.check(ip("192.168.1.1"), t0 + Duration::from_secs(61));
        assert_eq!(limiter.len(), 1);
    }

    #[test]
    fn selects_the_limiters_of_a_path() {
        let limits = RateLimits::default();
        let count = |path: &str| limits.for_path(path).len();
        assert_eq!(count("/api/tasks"), 1);
        assert_eq!(count("/api/auth/google"), 2);
        assert_eq!(count("/api/auth/google/callback"), 2);
        assert_eq!(count("/api/auth/googlex"), 1);
        assert_eq!(count("/api/action/abc"), 2);
        assert_eq!(count("/action/abc"), 1);
        assert_eq!(count("/actions"), 0);
        assert_eq!(count("/"), 0);
    }

    #[test]
    fn trusts_one_proxy_hop() {
        let mut headers = HeaderMap::new();
        let peer: SocketAddr = "10.1.1.1:5000".parse().unwrap();
        assert_eq!(client_key(&headers, Some(peer)), ip("10.1.1.1"));
        headers.insert("x-forwarded-for", "1.2.3.4, 5.6.7.8".parse().unwrap());
        assert_eq!(client_key(&headers, Some(peer)), ip("5.6.7.8"));
        headers.insert(
            "x-forwarded-for",
            "2001:db8:aaaa:bbcc:1:2:3:4".parse().unwrap(),
        );
        assert_eq!(client_key(&headers, Some(peer)), ip("2001:db8:aaaa:bb00::"));
        headers.insert("x-forwarded-for", "not-an-ip".parse().unwrap());
        assert_eq!(client_key(&headers, Some(peer)), ip("10.1.1.1"));
    }
}
