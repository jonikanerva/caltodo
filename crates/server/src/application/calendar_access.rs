//! The Google Calendar of one user, with the stored tokens.
//!
//! The Node server used googleapis, which refreshed an expired access token
//! by itself and stored the new tokens. Here a call that Google answers with
//! 401 refreshes the access token once with the refresh token, stores the
//! new tokens encrypted, and runs the call again.

use std::future::Future;
use std::sync::{Mutex, PoisonError};

use caltodo_domain::event::CalendarEvent;
use caltodo_domain::ids::{CalendarId, EventId, UserId};
use jiff::Timestamp;

use super::Services;
use super::ports::{CalendarSummary, EventPatch, GoogleError, NewEvent};
use crate::config::Secret;
use crate::db::StoreError;

/// The calendar access of one user for one request or job step.
#[derive(Debug)]
pub struct UserCalendar<'s> {
    services: &'s Services,
    user: UserId,
    access: Mutex<Secret>,
    refresh: Mutex<Option<Secret>>,
    /// One refresh at a time; parallel calls wait and reuse its result.
    refreshing: tokio::sync::Mutex<()>,
}

impl<'s> UserCalendar<'s> {
    /// The calendar of a user, or `None` when the user does not exist or has
    /// no access token (`getCalendarClient` returned null).
    ///
    /// # Errors
    ///
    /// The user query fails.
    pub async fn open(services: &'s Services, user: &UserId) -> Result<Option<Self>, StoreError> {
        let Some(record) = services.store.user(user).await? else {
            return Ok(None);
        };
        let Some(access) = record
            .access_token
            .filter(|token| !token.expose().is_empty())
        else {
            return Ok(None);
        };
        Ok(Some(Self {
            services,
            user: record.id,
            access: Mutex::new(access),
            refresh: Mutex::new(record.refresh_token.filter(|t| !t.expose().is_empty())),
            refreshing: tokio::sync::Mutex::new(()),
        }))
    }

    fn access_token(&self) -> Secret {
        self.access
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Runs `call` with the access token, and once more after a refresh when
    /// Google answers 401.
    async fn call<T, F, Fut>(&self, call: F) -> Result<T, GoogleError>
    where
        F: Fn(Secret) -> Fut,
        Fut: Future<Output = Result<T, GoogleError>>,
    {
        let token = self.access_token();
        match call(token.clone()).await {
            Err(GoogleError::Unauthorized) => {
                self.refresh_after(&token).await?;
                call(self.access_token()).await
            }
            other => other,
        }
    }

    /// Refreshes the access token unless another call already replaced the
    /// failed token.
    async fn refresh_after(&self, failed: &Secret) -> Result<(), GoogleError> {
        let _one_at_a_time = self.refreshing.lock().await;
        if self.access_token() != *failed {
            return Ok(());
        }
        let refresh_token = self
            .refresh
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or(GoogleError::Unauthorized)?;
        let grant = self.services.oauth.refresh(&refresh_token).await?;
        let refresh = grant.refresh_token.clone().unwrap_or(refresh_token);
        if let Err(error) = self
            .services
            .store
            .update_tokens(&self.user, &grant.access_token, Some(&refresh))
            .await
        {
            // The new token still works for this request; the next request
            // refreshes again.
            tracing::warn!(reason = %error, "refreshed Google tokens were not stored");
        }
        *self.access.lock().unwrap_or_else(PoisonError::into_inner) = grant.access_token;
        *self.refresh.lock().unwrap_or_else(PoisonError::into_inner) = Some(refresh);
        Ok(())
    }

    /// The events that overlap the range.
    ///
    /// # Errors
    ///
    /// Google fails.
    pub async fn list_events(
        &self,
        calendar: &CalendarId,
        time_min: Timestamp,
        time_max: Timestamp,
    ) -> Result<Vec<CalendarEvent>, GoogleError> {
        let api = &self.services.calendar;
        self.call(
            |token| async move { api.list_events(&token, calendar, time_min, time_max).await },
        )
        .await
    }

    /// One event.
    ///
    /// # Errors
    ///
    /// Google fails; [`GoogleError::NotFound`] for 404 and 410.
    pub async fn get_event(
        &self,
        calendar: &CalendarId,
        event: &EventId,
    ) -> Result<CalendarEvent, GoogleError> {
        let api = &self.services.calendar;
        self.call(|token| async move { api.get_event(&token, calendar, event).await })
            .await
    }

    /// Creates an event.
    ///
    /// # Errors
    ///
    /// Google fails.
    pub async fn insert_event(
        &self,
        calendar: &CalendarId,
        event: &NewEvent,
    ) -> Result<CalendarEvent, GoogleError> {
        let api = &self.services.calendar;
        self.call(|token| async move { api.insert_event(&token, calendar, event).await })
            .await
    }

    /// Changes an event.
    ///
    /// # Errors
    ///
    /// Google fails.
    pub async fn patch_event(
        &self,
        calendar: &CalendarId,
        event: &EventId,
        patch: &EventPatch,
    ) -> Result<CalendarEvent, GoogleError> {
        let api = &self.services.calendar;
        self.call(|token| async move { api.patch_event(&token, calendar, event, patch).await })
            .await
    }

    /// The user's calendar list.
    ///
    /// # Errors
    ///
    /// Google fails.
    pub async fn list_calendars(&self) -> Result<Vec<CalendarSummary>, GoogleError> {
        let api = &self.services.calendar;
        self.call(|token| async move { api.list_calendars(&token).await })
            .await
    }
}
