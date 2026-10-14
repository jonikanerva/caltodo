//! The Google Calendar event format of a task.
//!
//! Existing calendar events and other code depend on this format, so it must
//! not change (`server/calendar.ts`):
//!
//! - The title starts with `☑️ ` (incomplete) or `✅ ` (complete).
//! - The private extended property `caltodo` is `"true"`. The property
//!   `caltodoCompleted` is `"true"` or `"false"`.
//! - The description holds the task details, a blank line, the action
//!   section `Actions:\n- Manage: <link>`, and the signature
//!   `\n---\nCreated by Todo`. Old events have the action section
//!   `Actions:\n- Mark Complete: …`.

use std::collections::BTreeMap;

use jiff::Timestamp;

use crate::text::js_trim;

/// The title prefix of an incomplete task.
pub const TITLE_PREFIX_INCOMPLETE: &str = "☑️ ";
/// The title prefix of a completed task.
pub const TITLE_PREFIX_COMPLETE: &str = "✅ ";
/// The private extended property that marks a task event.
pub const MARKER_KEY: &str = "caltodo";
/// The private extended property with the completion state.
pub const COMPLETED_KEY: &str = "caltodoCompleted";
/// The last line of a task description.
pub const APP_SIGNATURE: &str = "Created by Todo";
const ACTIONS_MARKER: &str = "Actions:\n- Manage:";
const LEGACY_ACTIONS_MARKER: &str = "Actions:\n- Mark Complete:";

/// The fields of a Google Calendar event that the task rules read.
///
/// The calendar adapter decodes the Google JSON into this value. A start or
/// end without a valid `dateTime` (an all-day event) is `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CalendarEvent {
    pub id: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub start: Option<Timestamp>,
    pub end: Option<Timestamp>,
    pub updated: Option<Timestamp>,
    pub transparency: Option<String>,
    /// `extendedProperties.private`.
    pub private_properties: BTreeMap<String, String>,
}

impl CalendarEvent {
    /// True for an event that this app created: `caltodo` is `"true"`.
    #[must_use]
    pub fn is_task(&self) -> bool {
        self.private_properties
            .get(MARKER_KEY)
            .is_some_and(|value| value == "true")
    }

    /// The completion flag: `Some(true)` for `"true"`, `Some(false)` for
    /// `"false"`, and `None` for a missing or other value.
    #[must_use]
    pub fn completion(&self) -> Option<bool> {
        match self
            .private_properties
            .get(COMPLETED_KEY)
            .map(String::as_str)
        {
            Some("true") => Some(true),
            Some("false") => Some(false),
            _ => None,
        }
    }

    /// A task event with the completion flag `"true"`.
    #[must_use]
    pub fn is_completed_task(&self) -> bool {
        self.is_task() && self.completion() == Some(true)
    }

    /// False for an event marked "free" (`transparency: transparent`).
    #[must_use]
    pub fn is_busy(&self) -> bool {
        self.transparency.as_deref() != Some("transparent")
    }

    /// Google reports a deleted event with the status `cancelled`.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.status.as_deref() == Some("cancelled")
    }

    /// The task id: the event id when it is not empty.
    #[must_use]
    pub fn task_id(&self) -> Option<&str> {
        self.id.as_deref().filter(|id| !id.is_empty())
    }

    /// The start and end of a timed event.
    #[must_use]
    pub fn time_range(&self) -> Option<(Timestamp, Timestamp)> {
        Some((self.start?, self.end?))
    }
}

/// Removes one task prefix from an event title.
#[must_use]
pub fn strip_title_prefix(summary: &str) -> &str {
    summary
        .strip_prefix(TITLE_PREFIX_INCOMPLETE)
        .or_else(|| summary.strip_prefix(TITLE_PREFIX_COMPLETE))
        .unwrap_or(summary)
}

/// The event title of a task.
#[must_use]
pub fn format_title(title: &str, completed: bool) -> String {
    let prefix = if completed {
        TITLE_PREFIX_COMPLETE
    } else {
        TITLE_PREFIX_INCOMPLETE
    };
    format!("{prefix}{title}")
}

/// The task details in an event description: the text before the signature
/// and before the action section, trimmed. `None` when nothing remains.
#[must_use]
pub fn extract_details(description: Option<&str>) -> Option<String> {
    let description = description.filter(|text| !text.is_empty())?;
    let signature = format!("---\n{APP_SIGNATURE}");
    let mut content = description;
    if let Some(index) = content.find(&signature) {
        content = &content[..index];
    }
    let actions = content
        .find(ACTIONS_MARKER)
        .or_else(|| content.find(LEGACY_ACTIONS_MARKER));
    if let Some(index) = actions {
        content = &content[..index];
    }
    let trimmed = js_trim(content);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// The description of a new event, before it has an action link.
#[must_use]
pub fn base_description(details: Option<&str>) -> String {
    match details.filter(|text| !text.is_empty()) {
        Some(details) => format!("{details}\n\n---\n{APP_SIGNATURE}"),
        None => format!("---\n{APP_SIGNATURE}"),
    }
}

/// The description with the action link of the event.
#[must_use]
pub fn description_with_actions(details: Option<&str>, manage_link: &str) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(4);
    if let Some(details) = details.filter(|text| !text.is_empty()) {
        parts.push(details.to_owned());
        parts.push(String::new());
    }
    parts.push(format!("Actions:\n- Manage: {manage_link}"));
    parts.push(format!("\n---\n{APP_SIGNATURE}"));
    parts.join("\n")
}

/// The private extended properties of a task with this completion state.
#[must_use]
pub fn task_properties(completed: bool) -> BTreeMap<String, String> {
    BTreeMap::from([
        (MARKER_KEY.to_owned(), "true".to_owned()),
        (
            COMPLETED_KEY.to_owned(),
            if completed { "true" } else { "false" }.to_owned(),
        ),
    ])
}

/// The private properties after a completion change: the existing
/// properties with the task properties on top.
#[must_use]
pub fn completion_properties(
    existing: &BTreeMap<String, String>,
    completed: bool,
) -> BTreeMap<String, String> {
    let mut merged = existing.clone();
    merged.extend(task_properties(completed));
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_one_prefix() {
        assert_eq!(strip_title_prefix("☑️ Plan sprint"), "Plan sprint");
        assert_eq!(strip_title_prefix("✅ Plan sprint"), "Plan sprint");
        assert_eq!(strip_title_prefix("Regular meeting"), "Regular meeting");
        assert_eq!(strip_title_prefix(""), "");
        assert_eq!(strip_title_prefix("✅ ☑️ Twice"), "☑️ Twice");
    }

    #[test]
    fn builds_the_descriptions() {
        assert_eq!(
            description_with_actions(Some("D"), "https://x/action/t"),
            "D\n\nActions:\n- Manage: https://x/action/t\n\n---\nCreated by Todo"
        );
        assert_eq!(
            description_with_actions(None, "L"),
            "Actions:\n- Manage: L\n\n---\nCreated by Todo"
        );
        assert_eq!(base_description(Some("")), "---\nCreated by Todo");
        assert_eq!(extract_details(Some("")), None);
    }

    #[test]
    fn merges_the_completion_properties() {
        let existing = BTreeMap::from([
            ("caltodo".to_owned(), "true".to_owned()),
            ("oldField".to_owned(), "keep-me".to_owned()),
        ]);
        let merged = completion_properties(&existing, true);
        assert_eq!(merged.get("oldField").map(String::as_str), Some("keep-me"));
        assert_eq!(merged.get(COMPLETED_KEY).map(String::as_str), Some("true"));
    }
}
