//! Identifiers. Each entity has its own type, so a user id cannot go where an
//! event id belongs.
//!
//! The values are opaque text: `users.id` is a PostgreSQL `varchar` with a
//! UUID default, and Google Calendar chooses event and calendar ids.

use serde::{Deserialize, Serialize};

macro_rules! text_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// The id of a non-empty text. An empty text is no id.
            #[must_use]
            pub fn new(value: impl Into<String>) -> Option<Self> {
                let value = value.into();
                (!value.is_empty()).then_some(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            #[must_use]
            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

text_id!(
    /// The id of a row of `users` (`users.id`).
    UserId
);
text_id!(
    /// The id of a Google Calendar event. A task id is the event id.
    EventId
);
text_id!(
    /// The id of a Google Calendar calendar, such as `primary` or an e-mail
    /// address.
    CalendarId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_text_is_no_id() {
        assert_eq!(EventId::new(""), None);
        assert_eq!(
            EventId::new("e1").map(EventId::into_string),
            Some("e1".into())
        );
    }
}
