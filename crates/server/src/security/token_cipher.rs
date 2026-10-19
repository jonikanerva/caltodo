//! Encryption of the stored Google OAuth tokens (`users.access_token` and
//! `users.refresh_token`).
//!
//! The format is the format of the Node server (`server/crypto.ts`), so the
//! tokens that the Node server stored stay readable:
//!
//! - key: SHA-256 of `TOKEN_ENCRYPTION_KEY`;
//! - cipher: AES-256-GCM with a random 12-byte nonce and a 16-byte tag;
//! - stored text: `enc:v1:<nonce>:<tag>:<ciphertext>`, each part unpadded
//!   base64url.
//!
//! A stored value without the `enc:v1:` prefix is a legacy plaintext token
//! and reads as is. A malformed or tampered `enc:v1:` value reads as no
//! token. `tests/fixtures/node/token_crypto.vectors.json` holds Node output.

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use super::RandomUnavailable;
use crate::config::Secret;

/// The prefix of an encrypted value.
pub const PREFIX: &str = "enc:v1:";
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// The cipher of the stored tokens.
#[derive(Clone)]
pub struct TokenCipher {
    cipher: Aes256Gcm,
}

impl std::fmt::Debug for TokenCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TokenCipher(<redacted>)")
    }
}

impl TokenCipher {
    /// The cipher of `TOKEN_ENCRYPTION_KEY`.
    #[must_use]
    pub fn new(key_source: &Secret) -> Self {
        let key = Sha256::digest(key_source.expose().as_bytes());
        Self {
            cipher: Aes256Gcm::new(&key),
        }
    }

    /// The stored form of a token (`encryptToken`): an empty value and an
    /// already encrypted value stay as they are.
    ///
    /// # Errors
    ///
    /// The random source fails.
    pub fn encrypt(&self, value: &str) -> Result<String, RandomUnavailable> {
        if value.is_empty() || value.starts_with(PREFIX) {
            return Ok(value.to_owned());
        }
        let mut nonce = [0_u8; NONCE_BYTES];
        getrandom::fill(&mut nonce).map_err(|_| RandomUnavailable)?;
        Ok(self.encrypt_with_nonce(value, nonce))
    }

    /// The stored form with a given nonce. Tests use it to reproduce Node
    /// output byte for byte.
    #[must_use]
    pub fn encrypt_with_nonce(&self, value: &str, nonce: [u8; NONCE_BYTES]) -> String {
        // AES-GCM fails only for a plaintext over 64 GiB. The empty output
        // then has no tag, so it can never decrypt to a wrong token.
        let sealed = self
            .cipher
            .encrypt(&Nonce::<Aes256Gcm>::from(nonce), value.as_bytes())
            .unwrap_or_default();
        // The cipher appends the tag; the stored format keeps it apart.
        let (ciphertext, tag) = sealed.split_at(sealed.len().saturating_sub(TAG_BYTES));
        format!(
            "{PREFIX}{}:{}:{}",
            URL_SAFE_NO_PAD.encode(nonce),
            URL_SAFE_NO_PAD.encode(tag),
            URL_SAFE_NO_PAD.encode(ciphertext)
        )
    }

    /// The token of a stored value (`decryptToken`).
    #[must_use]
    pub fn decrypt(&self, stored: &str) -> Option<String> {
        if !stored.starts_with(PREFIX) {
            return Some(stored.to_owned());
        }
        let parts: Vec<&str> = stored.split(':').collect();
        let [_, _, nonce, tag, ciphertext] = parts.as_slice() else {
            return None;
        };
        let nonce: [u8; NONCE_BYTES] = decode_lenient(nonce)?.try_into().ok()?;
        let tag = decode_lenient(tag)?;
        if tag.len() != TAG_BYTES {
            return None;
        }
        let mut sealed = decode_lenient(ciphertext)?;
        sealed.extend_from_slice(&tag);
        let plaintext = self
            .cipher
            .decrypt(&Nonce::<Aes256Gcm>::from(nonce), sealed.as_slice())
            .ok()?;
        // Node decodes the plaintext with replacement characters.
        Some(String::from_utf8_lossy(&plaintext).into_owned())
    }
}

/// Decodes base64url like Node `Buffer.from(text, "base64url")`: padding
/// is ignored, and the decoding stops at the first character outside the
/// alphabet. The result can then have a wrong length, which the caller
/// rejects.
fn decode_lenient(text: &str) -> Option<Vec<u8>> {
    let valid: String = text
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    // An unpadded base64 text of length 4n + 1 has a lone final character
    // that encodes no whole byte; Node drops it.
    let usable = if valid.len() % 4 == 1 {
        &valid[..valid.len() - 1]
    } else {
        valid.as_str()
    };
    URL_SAFE_NO_PAD.decode(usable).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher() -> TokenCipher {
        TokenCipher::new(&Secret::new("unit-test-token-encryption-key-0123456"))
    }

    #[test]
    fn round_trips_and_keeps_empty_and_encrypted_values() {
        let cipher = cipher();
        let stored = cipher.encrypt("ya29.synthetic").unwrap();
        assert!(stored.starts_with(PREFIX));
        assert_eq!(cipher.decrypt(&stored).as_deref(), Some("ya29.synthetic"));
        assert_eq!(cipher.encrypt("").unwrap(), "");
        assert_eq!(cipher.encrypt(&stored).unwrap(), stored);
        assert_ne!(cipher.encrypt("x").unwrap(), cipher.encrypt("x").unwrap());
    }

    #[test]
    fn rejects_another_key() {
        let stored = cipher().encrypt("ya29.synthetic").unwrap();
        let other = TokenCipher::new(&Secret::new("another-token-encryption-key-0123456789"));
        assert_eq!(other.decrypt(&stored), None);
    }

    #[test]
    fn debug_hides_the_key() {
        assert_eq!(format!("{:?}", cipher()), "TokenCipher(<redacted>)");
    }
}
