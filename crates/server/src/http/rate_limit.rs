//! Request rate limits per client address (express-rate-limit on the Node
//! server).
//!
//! | Paths | Limit |
//! | --- | --- |
//! | `/api/…` | 120 per minute |
//! | `/api/auth/google`, `/api/auth/google/callback` | 25 per 15 minutes |
//! | `/api/action/…` and `/action/…` (one shared counter) | 40 per 15 minutes |
//!
//! A request passes each matching limiter in that order and counts once in
//! each. The sign-in callback thus counts once in the sign-in limit; the
//! Node server mounted that limiter twice on the callback path. The first
//! full limiter answers 429. The middleware runs before the session layer
//! and the body middleware (`http/mod.rs`), so a limited request loads no
//! session and reads no body. A window starts at the first request
//! of a client and lasts its full length (fixed window). The client address
//! is the last `X-Forwarded-For` entry, which Railway's proxy adds (Express
//! `trust proxy 1`), or else the peer address. An IPv6 address counts by its
//! /56 prefix, like express-rate-limit 8.
//!
//! Each limiter keeps at most [`MAX_CLIENTS`] counters in memory. When a new
//! client arrives and the limiter is full, the limiter removes the expired
//! counters. If none has expired, it removes the live counter with the
//! lowest count (on a tie, the one with the oldest window start), and then
//! counts the new client. A full limiter never refuses a new client, so a
//! flood of new addresses cannot block real users. The flood addresses
//! have low counts and remove each other, so a counter close to its limit
//! stays (issue #5 item 10). To remove a counter with count `c`, a client
//! must first raise every other counter to at least `c`, which uses up the
//! budget of those addresses.

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
    capacity: usize,
    clients: Mutex<Clients>,
}

/// The counters of a limiter.
#[derive(Debug, Default)]
struct Clients {
    /// The window start and the request count of each client.
    counters: HashMap<IpAddr, (Instant, u32)>,
    /// No window in `counters` starts before this instant. A full limiter
    /// uses it to skip the scan for expired counters while none can have
    /// expired. A removal can only make the bound less tight, never wrong.
    earliest_start: Option<Instant>,
}

impl Clients {
    /// Removes the expired counters and sets the exact earliest start.
    fn remove_expired(&mut self, now: Instant, window: Duration) {
        self.counters
            .retain(|_, (start, _)| now.duration_since(*start) < window);
        self.earliest_start = self.counters.values().map(|(start, _)| *start).min();
    }

    /// Removes the live counter with the lowest count; on a tie, the one
    /// with the oldest window start. One scan of at most the capacity.
    fn remove_lowest(&mut self) {
        let lowest = self
            .counters
            .iter()
            .min_by_key(|(_, (start, count))| (*count, *start))
            .map(|(client, _)| *client);
        if let Some(client) = lowest {
            self.counters.remove(&client);
        }
    }
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
    /// A limiter with room for [`MAX_CLIENTS`] counters.
    #[must_use]
    pub fn new(limit: u32, window: Duration) -> Self {
        Self::with_capacity(limit, window, MAX_CLIENTS)
    }

    /// A limiter with room for `capacity` counters.
    #[must_use]
    pub fn with_capacity(limit: u32, window: Duration, capacity: usize) -> Self {
        Self {
            limit,
            window,
            capacity,
            clients: Mutex::new(Clients::default()),
        }
    }

    /// Counts one request of `client` at `now`.
    pub fn check(&self, client: IpAddr, now: Instant) -> Decision {
        let window = self.window;
        let mut clients = self.clients.lock().unwrap_or_else(PoisonError::into_inner);
        if !clients.counters.contains_key(&client) && clients.counters.len() >= self.capacity {
            let may_have_expired = clients
                .earliest_start
                .is_none_or(|start| now.duration_since(start) >= window);
            if may_have_expired {
                clients.remove_expired(now, window);
            }
            if clients.counters.len() >= self.capacity {
                // Full of live counters. Refusing the new client would let
                // a flood of addresses block every real user, so the least
                // used counter makes room.
                clients.remove_lowest();
            }
        }
        clients.earliest_start = Some(clients.earliest_start.map_or(now, |start| start.min(now)));
        let entry = clients.counters.entry(client).or_insert((now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
        let count = entry.1;
        let left = window.saturating_sub(now.duration_since(entry.0));
        self.decision(count <= self.limit, self.limit.saturating_sub(count), left)
    }

    fn decision(&self, allowed: bool, remaining: u32, left: Duration) -> Decision {
        Decision {
            allowed,
            limit: self.limit,
            remaining,
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
            .counters
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

    /// The request count of `client` in its current window.
    fn count(limiter: &Limiter, client: &str) -> Option<u32> {
        limiter
            .clients
            .lock()
            .unwrap()
            .counters
            .get(&ip(client))
            .map(|(_, count)| *count)
    }

    #[test]
    fn keeps_a_bounded_number_of_clients() {
        let limiter = Limiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        let full = u32::try_from(MAX_CLIENTS).unwrap();
        for n in 0..full + 5 {
            assert!(limiter.check(IpAddr::from(n.to_be_bytes()), t0).allowed);
        }
        assert_eq!(limiter.len(), MAX_CLIENTS);
        // After the window, the expired counters make room.
        assert!(
            limiter
                .check(ip("192.168.1.1"), t0 + Duration::from_secs(61))
                .allowed
        );
        assert_eq!(limiter.len(), 1);
    }

    /// Issue #5 item 10: a full limiter of live counters removes the counter
    /// with the lowest count (on a tie, the oldest window start) and counts
    /// the new client.
    #[test]
    fn a_full_limiter_removes_the_lowest_count_and_admits_the_new_client() {
        let limiter = Limiter::with_capacity(2, Duration::from_secs(60), 3);
        let t0 = Instant::now();
        let at = |seconds: u64| t0 + Duration::from_secs(seconds);
        assert!(limiter.check(ip("10.0.0.1"), at(0)).allowed);
        assert!(limiter.check(ip("10.0.0.1"), at(1)).allowed);
        assert!(limiter.check(ip("10.0.0.2"), at(10)).allowed);
        assert!(limiter.check(ip("10.0.0.3"), at(20)).allowed);

        let admitted = limiter.check(ip("10.0.0.4"), at(30));
        assert_eq!(
            admitted,
            Decision {
                allowed: true,
                limit: 2,
                remaining: 1,
                reset_seconds: 60,
                window_seconds: 60,
            }
        );
        assert_eq!(limiter.len(), 3);
        assert_eq!(
            count(&limiter, "10.0.0.1"),
            Some(2),
            "the highest count stays"
        );
        assert_eq!(
            count(&limiter, "10.0.0.2"),
            None,
            "count 1 and the oldest start of the two counters with count 1"
        );
        assert_eq!(count(&limiter, "10.0.0.3"), Some(1));
        assert_eq!(count(&limiter, "10.0.0.4"), Some(1));
    }

    /// Issue #5 item 10 and the review of the fail-closed version: a flood of
    /// new addresses with one request each neither blocks a real new client
    /// nor resets a counter close to its limit. The removal of the oldest
    /// counter reset the limited client here; a refusal of new clients
    /// blocked the real new client.
    #[test]
    fn a_limited_counter_survives_a_flood_and_new_clients_get_in() {
        let limiter = Limiter::with_capacity(5, Duration::from_secs(60), 3);
        let t0 = Instant::now();
        let at = |seconds: u64| t0 + Duration::from_secs(seconds);
        for _ in 0..5 {
            assert!(limiter.check(ip("10.0.0.1"), at(0)).allowed);
        }
        assert!(!limiter.check(ip("10.0.0.1"), at(1)).allowed);

        for n in 0..1_000_u16 {
            let [high, low] = n.to_be_bytes();
            let flood = limiter.check(IpAddr::from([172, 16, high, low]), at(2));
            assert!(flood.allowed, "flood address {n} is counted");
        }
        assert_eq!(limiter.len(), 3);
        assert_eq!(count(&limiter, "10.0.0.1"), Some(6));
        assert!(
            !limiter.check(ip("10.0.0.1"), at(3)).allowed,
            "the limited client stays limited"
        );
        assert!(
            limiter.check(ip("192.0.2.1"), at(4)).allowed,
            "a real new client gets in"
        );
        assert_eq!(count(&limiter, "10.0.0.1"), Some(7));
    }

    /// An expired counter goes before a live counter with a lower count.
    #[test]
    fn expired_counters_go_first() {
        let limiter = Limiter::with_capacity(5, Duration::from_secs(60), 3);
        let t0 = Instant::now();
        let at = |seconds: u64| t0 + Duration::from_secs(seconds);
        for _ in 0..4 {
            assert!(limiter.check(ip("10.0.0.1"), at(0)).allowed);
        }
        assert!(limiter.check(ip("10.0.0.2"), at(30)).allowed);
        assert!(limiter.check(ip("10.0.0.3"), at(40)).allowed);
        assert!(limiter.check(ip("10.0.0.4"), at(65)).allowed);
        assert_eq!(count(&limiter, "10.0.0.1"), None);
        assert_eq!(count(&limiter, "10.0.0.2"), Some(1));
        assert_eq!(count(&limiter, "10.0.0.3"), Some(1));
        assert_eq!(count(&limiter, "10.0.0.4"), Some(1));
    }

    /// A counter whose window started again is live, although the limiter
    /// first saw the client earlier.
    #[test]
    fn a_restarted_window_is_not_expired() {
        let limiter = Limiter::with_capacity(5, Duration::from_secs(60), 3);
        let t0 = Instant::now();
        let at = |seconds: u64| t0 + Duration::from_secs(seconds);
        assert!(limiter.check(ip("10.0.0.1"), at(0)).allowed);
        for _ in 0..3 {
            assert!(limiter.check(ip("10.0.0.1"), at(61)).allowed);
        }
        assert!(limiter.check(ip("10.0.0.2"), at(62)).allowed);
        assert!(limiter.check(ip("10.0.0.3"), at(63)).allowed);
        // The limiter first saw 10.0.0.1 more than one window ago, but its
        // window started again at 61 s: it is live and has the highest count.
        assert!(limiter.check(ip("10.0.0.4"), at(64)).allowed);
        assert_eq!(count(&limiter, "10.0.0.1"), Some(3));
        assert_eq!(count(&limiter, "10.0.0.2"), None);
        assert_eq!(count(&limiter, "10.0.0.3"), Some(1));
        // At 121 s the window of 10.0.0.1 has ended, so it goes first.
        assert!(limiter.check(ip("10.0.0.5"), at(121)).allowed);
        assert_eq!(count(&limiter, "10.0.0.1"), None);
        assert_eq!(count(&limiter, "10.0.0.3"), Some(1));
        assert_eq!(limiter.len(), 3);
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
