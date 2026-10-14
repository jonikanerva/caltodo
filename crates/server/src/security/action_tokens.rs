//! Action tokens: the one-use links in calendar event descriptions
//! (`server/tokens.ts`).
//!
//! The raw token is 32 random bytes as unpadded base64url. Only its hash is
//! stored: the hex HMAC-SHA256 of the raw token with `ACTION_TOKEN_SECRET`.
//! The link is `<origin>/action/<raw token>`. A token expires after 7 days
//! and works once. `tests/fixtures/node/action_tokens.vectors.json` holds
//! Node output.

use hmac::{Hmac, KeyInit, Mac};
use jiff::SignedDuration;
use sha2::Sha256;

use super::{RandomUnavailable, hex, random_base64url};
use crate::config::Secret;

/// The random bytes of a raw token.
pub const TOKEN_BYTES: usize = 32;
/// The lifetime of a token.
pub const TOKEN_LIFETIME: SignedDuration = SignedDuration::from_hours(7 * 24);

/// A new token: the raw value for the link and the hash for the database.
#[derive(Clone, PartialEq, Eq)]
pub struct NewToken {
    pub raw: String,
    pub hash: String,
}

impl std::fmt::Debug for NewToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NewToken(<redacted>)")
    }
}

/// The HMAC key of the token hashes.
#[derive(Clone)]
pub struct TokenHasher {
    secret: Secret,
}

impl std::fmt::Debug for TokenHasher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TokenHasher(<redacted>)")
    }
}

impl TokenHasher {
    #[must_use]
    pub fn new(secret: Secret) -> Self {
        Self { secret }
    }

    /// The stored hash of a raw token.
    #[must_use]
    pub fn hash(&self, raw: &str) -> String {
        // HMAC accepts a key of any length, so the construction cannot fail.
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(self.secret.expose().as_bytes()) else {
            return String::new();
        };
        mac.update(raw.as_bytes());
        hex(&mac.finalize().into_bytes())
    }

    /// A new random token.
    ///
    /// # Errors
    ///
    /// The operating system gives no random bytes.
    pub fn generate(&self) -> Result<NewToken, RandomUnavailable> {
        let raw = random_base64url(TOKEN_BYTES)?;
        let hash = self.hash(&raw);
        Ok(NewToken { raw, hash })
    }
}

/// The manage link of a token.
#[must_use]
pub fn action_link(origin: &str, raw: &str) -> String {
    format!("{origin}/action/{raw}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_hashed_tokens() {
        let hasher = TokenHasher::new(Secret::new("unit-test-action-token-secret-0123456"));
        let token = hasher.generate().unwrap();
        assert_eq!(token.raw.len(), 43);
        assert_eq!(token.hash, hasher.hash(&token.raw));
        assert_eq!(token.hash.len(), 64);
        assert_eq!(
            action_link("https://todo.example", &token.raw),
            format!("https://todo.example/action/{}", token.raw)
        );
        assert_eq!(format!("{token:?}"), "NewToken(<redacted>)");
    }
}
