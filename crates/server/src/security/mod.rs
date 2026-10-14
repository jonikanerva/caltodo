//! Secrets at rest and in links: the stored OAuth token encryption, the
//! action token hashes, and random values.

pub mod action_tokens;
pub mod token_cipher;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The random source failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("random bytes are unavailable")]
pub struct RandomUnavailable;

/// `bytes` random bytes from the operating system as unpadded base64url.
///
/// # Errors
///
/// The operating system gives no random bytes.
pub fn random_base64url(bytes: usize) -> Result<String, RandomUnavailable> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).map_err(|_| RandomUnavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// `bytes` random bytes from the operating system as lower-case hex, like
/// Node `crypto.randomBytes(n).toString("hex")`.
///
/// # Errors
///
/// The operating system gives no random bytes.
pub fn random_hex(bytes: usize) -> Result<String, RandomUnavailable> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).map_err(|_| RandomUnavailable)?;
    Ok(hex(&buffer))
}

/// Lower-case hex.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut text, byte| {
            // Writing to a String cannot fail.
            write!(text, "{byte:02x}").ok();
            text
        })
}

/// Compares two texts in time that does not depend on where they differ.
#[must_use]
pub fn constant_time_eq(left: &str, right: &str) -> bool {
    use subtle::ConstantTimeEq as _;
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_random_text_of_the_expected_form() {
        let token = random_base64url(32).unwrap();
        assert_eq!(token.len(), 43);
        assert!(!token.contains('='));
        let csrf = random_hex(32).unwrap();
        assert_eq!(csrf.len(), 64);
        assert!(csrf.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(random_hex(32).unwrap(), csrf);
    }

    #[test]
    fn compares_texts() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "a"));
    }
}
