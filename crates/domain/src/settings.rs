//! Validated settings values and task input limits (`shared/schema.ts`).

use jiff::tz::TimeZone;

use crate::text::utf16_len;

/// An hour of the day, 0 to 23.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct WorkHour(u8);

impl WorkHour {
    #[must_use]
    pub fn new(hour: u8) -> Option<Self> {
        (hour <= 23).then_some(Self(hour))
    }

    /// The hour of a stored or requested integer.
    #[must_use]
    pub fn from_i64(hour: i64) -> Option<Self> {
        u8::try_from(hour).ok().and_then(Self::new)
    }

    #[must_use]
    pub fn get(self) -> u8 {
        self.0
    }
}

/// A task duration in minutes, 15 to 480: the requested duration of a new
/// task and the default duration of the settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskMinutes(u32);

impl TaskMinutes {
    pub const MIN: u32 = 15;
    pub const MAX: u32 = 480;

    #[must_use]
    pub fn from_i64(minutes: i64) -> Option<Self> {
        u32::try_from(minutes)
            .ok()
            .filter(|minutes| (Self::MIN..=Self::MAX).contains(minutes))
            .map(Self)
    }

    #[must_use]
    pub fn get(self) -> u32 {
        self.0
    }
}

/// An IANA time zone name that the bundled time zone database knows, with
/// the exact case of the database.
///
/// The Node server accepted the names of `Intl.supportedValuesOf("timeZone")`.
/// This check accepts each of those names
/// (`tests/fixtures/node_time_zones.json`) and also the IANA aliases, such as
/// `UTC` and `US/Eastern`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeZoneName {
    name: String,
    zone: TimeZone,
}

impl TimeZoneName {
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        let zone = TimeZone::get(name).ok()?;
        // Jiff finds a zone without regard to case. A stored name must have
        // the case of the database, because Google Calendar receives it.
        (zone.iana_name() == Some(name)).then(|| Self {
            name: name.to_owned(),
            zone,
        })
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn zone(&self) -> &TimeZone {
        &self.zone
    }
}

/// The longest task title in UTF-16 code units.
pub const TITLE_MAX: usize = 200;
/// The longest task details in UTF-16 code units.
pub const DETAILS_MAX: usize = 5000;
/// The most task ids in one reorder or bulk-complete request.
pub const TASK_IDS_MAX: usize = 200;

/// True for a task title of 1 to 200 UTF-16 code units.
#[must_use]
pub fn is_valid_title(title: &str) -> bool {
    (1..=TITLE_MAX).contains(&utf16_len(title))
}

/// True for task details of at most 5000 UTF-16 code units.
#[must_use]
pub fn is_valid_details(details: &str) -> bool {
    utf16_len(details) <= DETAILS_MAX
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_hours_and_minutes() {
        assert_eq!(WorkHour::from_i64(0).map(WorkHour::get), Some(0));
        assert_eq!(WorkHour::from_i64(23).map(WorkHour::get), Some(23));
        assert_eq!(WorkHour::from_i64(24), None);
        assert_eq!(WorkHour::from_i64(-1), None);
        assert_eq!(TaskMinutes::from_i64(14), None);
        assert_eq!(TaskMinutes::from_i64(15).map(TaskMinutes::get), Some(15));
        assert_eq!(TaskMinutes::from_i64(480).map(TaskMinutes::get), Some(480));
        assert_eq!(TaskMinutes::from_i64(481), None);
    }

    #[test]
    fn validates_time_zone_names_with_their_case() {
        assert!(TimeZoneName::parse("Europe/Helsinki").is_some());
        assert!(TimeZoneName::parse("europe/helsinki").is_none());
        assert!(TimeZoneName::parse("Mars/Olympus").is_none());
        assert!(TimeZoneName::parse("").is_none());
    }

    #[test]
    fn counts_title_length_in_utf16_units() {
        assert!(!is_valid_title(""));
        assert!(is_valid_title(&"a".repeat(200)));
        assert!(!is_valid_title(&"a".repeat(201)));
        assert!(!is_valid_title(&"😀".repeat(101)));
        assert!(is_valid_details(&"a".repeat(5000)));
        assert!(!is_valid_details(&"a".repeat(5001)));
    }
}
