//! Sign in with GitHub (OAuth web flow), session cookie, `/api/me`, sign out.
//!
//! Flow: `GET /api/auth/github/login` sets a short-lived state cookie and
//! redirects to GitHub. GitHub sends the browser back to
//! `GET /api/auth/github/callback`, which checks the state, trades the code
//! for a token, reads the GitHub profile, upserts the user and starts a
//! session. The session cookie holds a random token; the database keeps only
//! its SHA-256.
use axum::{
    extract::{FromRequestParts, Query, State},
    http::{header, request::Parts, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{config::GithubOAuth, AppError, AppState};

pub const SESSION_COOKIE: &str = "spectrace_session";
const STATE_COOKIE: &str = "spectrace_oauth_state";
const SESSION_DAYS: i64 = 30;
const STATE_MAX_AGE_SECS: i64 = 600;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/github/login", get(login))
        .route("/api/auth/github/callback", get(callback))
        .route("/api/auth/logout", post(logout))
        .route("/api/me", get(me))
}

/// The signed-in user, as returned by `/api/me`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: uuid::Uuid,
    pub github_id: i64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Extractor for handlers that need a signed-in user; answers 401 otherwise.
impl FromRequestParts<AppState> for User {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = cookie(&parts.headers, SESSION_COOKIE)
            .ok_or_else(|| AppError::Unauthorized("not signed in".into()))?;
        sqlx::query_as::<_, User>(
            "SELECT u.id, u.github_id, u.login, u.name, u.avatar_url
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = $1 AND s.expires_at > now()",
        )
        .bind(hash_token(&token))
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::Unauthorized("session expired or unknown".into()))
    }
}

fn github(state: &AppState) -> Result<&GithubOAuth, AppError> {
    state.github.as_ref().ok_or_else(|| {
        AppError::Config(
            "GitHub sign-in is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)".into(),
        )
    })
}

pub(crate) fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub(crate) fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|p| p.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

pub(crate) fn set_cookie(
    name: &str,
    value: &str,
    max_age: i64,
    secure: bool,
) -> Result<HeaderValue, AppError> {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    ))
    .map_err(|e| AppError::Internal(format!("bad cookie: {e}")))
}

async fn login(State(state): State<AppState>) -> Result<Response, AppError> {
    let gh = github(&state)?;
    let oauth_state = random_token();
    let mut url = reqwest::Url::parse(&format!("{}/login/oauth/authorize", gh.oauth_url))
        .map_err(|e| AppError::Config(format!("bad GITHUB_OAUTH_URL: {e}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", &gh.client_id)
        .append_pair(
            "redirect_uri",
            &format!("{}/api/auth/github/callback", gh.public_url),
        )
        .append_pair("scope", "read:user")
        .append_pair("state", &oauth_state);
    let mut res = Redirect::to(url.as_str()).into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(
            STATE_COOKIE,
            &oauth_state,
            STATE_MAX_AGE_SECS,
            gh.secure_cookies,
        )?,
    );
    Ok(res)
}

#[derive(Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct GithubUser {
    id: i64,
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CallbackParams>,
) -> Result<Response, AppError> {
    let gh = github(&state)?;
    if let Some(e) = params.error {
        return Err(AppError::BadRequest(format!("GitHub refused sign-in: {e}")));
    }
    let (Some(code), Some(got_state)) = (params.code, params.state) else {
        return Err(AppError::BadRequest("missing code or state".into()));
    };
    match cookie(&headers, STATE_COOKIE) {
        Some(expected) if expected == got_state => {}
        _ => return Err(AppError::BadRequest("sign-in state does not match".into())),
    }

    let token: TokenResponse = state
        .http
        .post(format!("{}/login/oauth/access_token", gh.oauth_url))
        .header(header::ACCEPT, "application/json")
        .form(&[
            ("client_id", gh.client_id.as_str()),
            ("client_secret", gh.client_secret.as_str()),
            ("code", code.as_str()),
            (
                "redirect_uri",
                &format!("{}/api/auth/github/callback", gh.public_url),
            ),
        ])
        .send()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub token request: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub token response: {e}")))?;
    let access_token = token.access_token.ok_or_else(|| {
        AppError::BadRequest(format!(
            "GitHub did not accept the code: {}",
            token.error_description.unwrap_or_default()
        ))
    })?;

    let profile: GithubUser = state
        .http
        .get(format!("{}/user", gh.api_url))
        .header(header::ACCEPT, "application/vnd.github+json")
        .header(header::USER_AGENT, "spectrace")
        .bearer_auth(&access_token)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Upstream(format!("GitHub user request: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub user response: {e}")))?;

    let user_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO users (github_id, login, name, avatar_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (github_id) DO UPDATE
           SET login = EXCLUDED.login, name = EXCLUDED.name,
               avatar_url = EXCLUDED.avatar_url, updated_at = now()
         RETURNING id",
    )
    .bind(profile.id)
    .bind(&profile.login)
    .bind(&profile.name)
    .bind(&profile.avatar_url)
    .fetch_one(&state.db)
    .await?;

    let session_token = random_token();
    sqlx::query(
        "INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))",
    )
    .bind(user_id)
    .bind(hash_token(&session_token))
    .bind(SESSION_DAYS as i32)
    .execute(&state.db)
    .await?;

    let mut res = Redirect::to("/").into_response();
    let h = res.headers_mut();
    h.append(
        header::SET_COOKIE,
        set_cookie(
            SESSION_COOKIE,
            &session_token,
            SESSION_DAYS * 86400,
            gh.secure_cookies,
        )?,
    );
    h.append(
        header::SET_COOKIE,
        set_cookie(STATE_COOKIE, "", 0, gh.secure_cookies)?,
    );
    Ok(res)
}

async fn me(user: User) -> Json<User> {
    Json(user)
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(token) = cookie(&headers, SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(hash_token(&token))
            .execute(&state.db)
            .await?;
    }
    let secure = state.github.as_ref().is_some_and(|g| g.secure_cookies);
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(SESSION_COOKIE, "", 0, secure)?,
    );
    Ok(res)
}
