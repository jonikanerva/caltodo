//! The Google sign-in (`server/auth.ts`, passport-google-oauth20).

use super::Services;
use super::ports::{GoogleError, GoogleProfile};
use crate::config::Secret;
use crate::db::users::{NewUser, User, UserWriteError};

/// A failed sign-in after the OAuth redirect.
#[derive(Debug, thiserror::Error)]
pub enum SignInError {
    #[error(transparent)]
    Google(#[from] GoogleError),
    #[error(transparent)]
    Store(#[from] UserWriteError),
}

/// The user fields of a Google profile, like the Passport Google strategy:
/// the e-mail address or an empty text, and the name, the e-mail address, or
/// `User`.
#[must_use]
pub fn new_user(profile: &GoogleProfile) -> NewUser {
    let email = profile.email.clone().unwrap_or_default();
    let display_name = profile
        .name
        .clone()
        .filter(|name| !name.is_empty())
        .or_else(|| (!email.is_empty()).then(|| email.clone()))
        .unwrap_or_else(|| "User".to_owned());
    NewUser {
        google_id: profile.sub.clone(),
        email,
        display_name,
    }
}

/// Exchanges the authorization code, reads the Google profile, and records
/// the user and the tokens.
///
/// # Errors
///
/// A Google failure, or a database failure.
pub async fn complete_sign_in(
    services: &Services,
    code: &str,
    pkce_verifier: &Secret,
) -> Result<User, SignInError> {
    let grant = services.oauth.exchange_code(code, pkce_verifier).await?;
    let profile = services.oauth.profile(&grant.access_token).await?;
    Ok(services
        .store
        .record_sign_in(
            &new_user(&profile),
            &grant.access_token,
            grant.refresh_token.as_ref(),
        )
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(email: Option<&str>, name: Option<&str>) -> GoogleProfile {
        GoogleProfile {
            sub: "google-sub-1".to_owned(),
            email: email.map(str::to_owned),
            name: name.map(str::to_owned),
        }
    }

    #[test]
    fn maps_the_profile_like_passport() {
        let full = new_user(&profile(Some("a@example.com"), Some("Ann")));
        assert_eq!(full.google_id, "google-sub-1");
        assert_eq!(full.email, "a@example.com");
        assert_eq!(full.display_name, "Ann");
        assert_eq!(
            new_user(&profile(Some("a@example.com"), Some(""))).display_name,
            "a@example.com"
        );
        let bare = new_user(&profile(None, None));
        assert_eq!(bare.email, "");
        assert_eq!(bare.display_name, "User");
    }
}
