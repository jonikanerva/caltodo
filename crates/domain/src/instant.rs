//! Instants with the millisecond precision of the JavaScript `Date`.
//!
//! The wire contract and the Google Calendar requests use the format of
//! `Date.prototype.toISOString`: UTC, `Z`, and exactly three fraction
//! digits, for example `2026-03-02T15:00:00.000Z`. The Node server parsed
//! each Google value into a `Date`, so it kept milliseconds only.

use jiff::Timestamp;
use jiff::tz::TimeZone;

/// The instant with its sub-millisecond part removed, like a JavaScript
/// `Date`. The value moves toward the earlier instant.
#[must_use]
pub fn to_millis(instant: Timestamp) -> Timestamp {
    Timestamp::from_millisecond(instant.as_millisecond()).unwrap_or(instant)
}

/// Parses an RFC 3339 instant from Google Calendar, such as
/// `2026-03-02T10:00:00+02:00` or `2026-02-08T15:30:00.000Z`, at millisecond
/// precision. A value that does not parse gives `None`.
#[must_use]
pub fn parse(text: &str) -> Option<Timestamp> {
    text.parse::<Timestamp>().ok().map(to_millis)
}

/// Formats like `Date.prototype.toISOString`.
#[must_use]
pub fn to_iso(instant: Timestamp) -> String {
    let utc = to_millis(instant).to_zoned(TimeZone::UTC);
    let year = i32::from(utc.year());
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        // `toISOString` writes the expanded year form outside 0000–9999.
        let sign = if year < 0 { '-' } else { '+' };
        format!("{sign}{:06}", year.unsigned_abs())
    };
    format!(
        "{year_text}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        utc.month(),
        utc.day(),
        utc.hour(),
        utc.minute(),
        utc.second(),
        utc.millisecond(),
    )
}

/// The whole minutes from `start` to `end`, rounded like `Math.round`.
/// `None` when `end` is not after `start` (`getDurationMinutes`).
#[must_use]
pub fn duration_minutes(start: Timestamp, end: Timestamp) -> Option<i64> {
    let millis = end.as_millisecond() - start.as_millisecond();
    (millis > 0).then(|| round_minutes(millis))
}

/// `Math.round(millis / 60000)` for any sign: the nearest whole minute, and
/// a half minute rounds toward positive infinity.
#[must_use]
pub fn round_minutes(millis: i64) -> i64 {
    (millis + 30_000).div_euclid(60_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn formats_like_to_iso_string() {
        assert_eq!(
            to_iso(ts("2026-03-02T15:00:00Z")),
            "2026-03-02T15:00:00.000Z"
        );
        assert_eq!(
            to_iso(ts("2026-03-02T10:00:00.123456+02:00")),
            "2026-03-02T08:00:00.123Z"
        );
        assert_eq!(
            to_iso(ts("0099-01-01T00:00:00Z")),
            "0099-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn parses_offsets_and_drops_sub_milliseconds() {
        assert_eq!(
            parse("2026-03-02T10:00:00+02:00"),
            Some(ts("2026-03-02T08:00:00Z"))
        );
        assert_eq!(
            parse("2026-03-02T10:00:00.9999Z"),
            Some(ts("2026-03-02T10:00:00.999Z"))
        );
        assert_eq!(parse("2026-02-08"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn rounds_minutes_like_math_round() {
        assert_eq!(round_minutes(29_999), 0);
        assert_eq!(round_minutes(30_000), 1);
        assert_eq!(round_minutes(-30_000), 0);
        assert_eq!(round_minutes(-30_001), -1);
        assert_eq!(round_minutes(-3_600_000), -60);
        let start = ts("2026-03-02T10:00:00Z");
        assert_eq!(duration_minutes(start, start), None);
        assert_eq!(
            duration_minutes(start, ts("2026-03-02T10:45:00Z")),
            Some(45)
        );
    }
}
