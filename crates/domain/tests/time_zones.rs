//! The time zone check against the Node server.
//!
//! `fixtures/node_time_zones.json` lists the names that the Node server
//! accepted (`Intl.supportedValuesOf("timeZone")`). Stored settings use these
//! names, so the Rust check must accept each of them.

use caltodo_domain::settings::TimeZoneName;
use serde_json::Value;

#[test]
fn accepts_every_name_that_the_node_server_accepted() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/node_time_zones.json")).unwrap();
    let accepted = fixture["accepted"].as_array().unwrap();
    assert!(accepted.len() > 400);
    let rejected: Vec<&str> = accepted
        .iter()
        .map(|name| name.as_str().unwrap())
        .filter(|name| TimeZoneName::parse(name).is_none())
        .collect();
    assert_eq!(rejected, Vec::<&str>::new());
}

#[test]
fn rejects_names_outside_the_database() {
    for name in ["", "Mars/Olympus", "utc", "America/new_york", "GMT+2"] {
        assert!(TimeZoneName::parse(name).is_none(), "{name}");
    }
    // Wider than Node: IANA aliases are valid names.
    assert!(TimeZoneName::parse("UTC").is_some());
    assert!(TimeZoneName::parse("US/Eastern").is_some());
}
