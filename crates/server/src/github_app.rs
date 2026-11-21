//! GitHub App: install flow, installation ids, short-lived installation tokens
//! and the list of repositories a user can add.
//!
//! Flow: `GET /api/github/install` (signed in) sets a state cookie and sends
//! the browser to the app's install page on GitHub. After install, GitHub
//! sends the browser to the app's Setup URL, `GET /api/github/install/callback`
//! with `installation_id`, `code` and the state. Anyone can type any
//! installation id into that URL, so the callback trades `code` for the
//! user's token and only records installations GitHub lists for that very
//! user (`GET /user/installations`). This needs "Request user authorization
//! (OAuth) during installation" on the app, and the sign-in credentials
//! (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`) to be the app's own.
//!
//! Installation tokens live an hour; they are kept in memory and renewed a
//! minute before they run out. Nothing secret is written to the database.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{cookie, random_token, set_cookie, User},
    config::{GithubApp, GithubOAuth},
    AppError, AppState,
};

const STATE_COOKIE: &str = "spectrace_install_state";
const STATE_MAX_AGE_SECS: i64 = 600;
const PAGE_SIZE: usize = 100;
/// Renew a token when less than this is left.
const TOKEN_SLACK: Duration = Duration::seconds(60);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/github/install", get(install))
        .route("/api/github/install/callback", get(install_callback))
        .route("/api/github/repos", get(list_repos))
}

type Tokens = HashMap<i64, (String, DateTime<Utc>)>;

/// Installation tokens by installation id, shared by all handlers.
#[derive(Clone, Default)]
pub struct TokenCache(Arc<Mutex<Tokens>>);

impl TokenCache {
    fn get(&self, installation_id: i64) -> Option<String> {
        let map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&installation_id)
            .filter(|(_, exp)| *exp - TOKEN_SLACK > Utc::now())
            .map(|(t, _)| t.clone())
    }

    fn put(&self, installation_id: i64, token: String, expires_at: DateTime<Utc>) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(installation_id, (token, expires_at));
    }

    fn forget(&self, installation_id: i64) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&installation_id);
    }
}

fn app(state: &AppState) -> Result<&GithubApp, AppError> {
    state.github_app.as_ref().ok_or_else(|| {
        AppError::Config(
            "GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY)"
                .into(),
        )
    })
}

fn secure_cookies(state: &AppState) -> bool {
    state.github.as_ref().is_some_and(|g| g.secure_cookies)
}

#[derive(Serialize)]
struct JwtClaims<'a> {
    iat: i64,
    exp: i64,
    iss: &'a str,
}

/// The app's own JWT (RS256, 9 minutes), used to ask GitHub for installation
/// tokens. `iat` is back-dated a minute to allow for clock drift.
fn app_jwt(app: &GithubApp) -> Result<String, AppError> {
    let now = Utc::now().timestamp();
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(app.private_key.as_bytes())
        .map_err(|e| AppError::Config(format!("bad GitHub App private key: {e}")))?;
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &JwtClaims {
            iat: now - 60,
            exp: now + 9 * 60,
            iss: &app.app_id,
        },
        &key,
    )
    .map_err(|e| AppError::Internal(format!("cannot sign GitHub App JWT: {e}")))
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
    expires_at: DateTime<Utc>,
}

/// A usable token for the installation, from the cache or freshly minted.
/// `None` means GitHub no longer knows the installation (uninstalled).
pub async fn installation_token(
    state: &AppState,
    installation_id: i64,
) -> Result<Option<String>, AppError> {
    if let Some(t) = state.app_tokens.get(installation_id) {
        return Ok(Some(t));
    }
    let app = app(state)?;
    let res = state
        .http
        .post(format!(
            "{}/app/installations/{installation_id}/access_tokens",
            app.api_url
        ))
        .header(header::ACCEPT, "application/vnd.github+json")
        .header(header::USER_AGENT, "spectrace")
        .bearer_auth(app_jwt(app)?)
        .send()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub installation token request: {e}")))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        state.app_tokens.forget(installation_id);
        return Ok(None);
    }
    let t: TokenResponse = res
        .error_for_status()
        .map_err(|e| AppError::Upstream(format!("GitHub installation token request: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub installation token response: {e}")))?;
    state
        .app_tokens
        .put(installation_id, t.token.clone(), t.expires_at);
    Ok(Some(t.token))
}

async fn install(State(state): State<AppState>, _user: User) -> Result<Response, AppError> {
    let app = app(&state)?;
    let install_state = random_token();
    let mut url = reqwest::Url::parse(&format!(
        "{}/apps/{}/installations/new",
        app.web_url, app.slug
    ))
    .map_err(|e| AppError::Config(format!("bad GITHUB_OAUTH_URL or GITHUB_APP_SLUG: {e}")))?;
    url.query_pairs_mut().append_pair("state", &install_state);
    let mut res = Redirect::to(url.as_str()).into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(
            STATE_COOKIE,
            &install_state,
            STATE_MAX_AGE_SECS,
            secure_cookies(&state),
        )?,
    );
    Ok(res)
}

#[derive(Deserialize)]
struct CallbackParams {
    installation_id: Option<i64>,
    setup_action: Option<String>,
    code: Option<String>,
    state: Option<String>,
}

#[derive(Deserialize)]
struct UserToken {
    access_token: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct GhUser {
    id: i64,
}

#[derive(Deserialize)]
struct UserInstallations {
    installations: Vec<GhInstallation>,
}

#[derive(Deserialize)]
struct GhInstallation {
    id: i64,
    repository_selection: String,
    account: GhAccount,
}

#[derive(Deserialize)]
struct GhAccount {
    id: i64,
    login: String,
    #[serde(rename = "type")]
    kind: String,
}

fn gh_get(state: &AppState, api_url: &str, path: &str, token: &str) -> reqwest::RequestBuilder {
    state
        .http
        .get(format!("{api_url}{path}"))
        .header(header::ACCEPT, "application/vnd.github+json")
        .header(header::USER_AGENT, "spectrace")
        .bearer_auth(token)
}

async fn user_token(state: &AppState, oauth: &GithubOAuth, code: &str) -> Result<String, AppError> {
    let t: UserToken = state
        .http
        .post(format!("{}/login/oauth/access_token", oauth.oauth_url))
        .header(header::ACCEPT, "application/json")
        .form(&[
            ("client_id", oauth.client_id.as_str()),
            ("client_secret", oauth.client_secret.as_str()),
            ("code", code),
        ])
        .send()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub token request: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub token response: {e}")))?;
    t.access_token.ok_or_else(|| {
        AppError::BadRequest(format!(
            "GitHub did not accept the code: {}",
            t.error_description.unwrap_or_default()
        ))
    })
}

async fn install_callback(
    State(state): State<AppState>,
    user: User,
    headers: HeaderMap,
    Query(params): Query<CallbackParams>,
) -> Result<Response, AppError> {
    let app = app(&state)?;
    let oauth = state.github.as_ref().ok_or_else(|| {
        AppError::Config("GitHub sign-in is not configured (GITHUB_CLIENT_ID)".into())
    })?;
    match (cookie(&headers, STATE_COOKIE), &params.state) {
        (Some(expected), Some(got)) if expected == *got => {}
        _ => return Err(AppError::BadRequest("install state does not match".into())),
    }
    let clear = set_cookie(STATE_COOKIE, "", 0, oauth.secure_cookies)?;

    // An org member who may not install asks the owners instead; nothing to
    // record until an owner approves.
    if params.setup_action.as_deref() == Some("request") {
        let mut res = Redirect::to("/?github_app=requested").into_response();
        res.headers_mut().append(header::SET_COOKIE, clear);
        return Ok(res);
    }

    let (Some(installation_id), Some(code)) = (params.installation_id, params.code) else {
        return Err(AppError::BadRequest(
            "missing installation_id or code (enable \"Request user authorization (OAuth) during installation\" on the GitHub App)".into(),
        ));
    };

    // Only record installations GitHub lists for the person who is signed in.
    let token = user_token(&state, oauth, &code).await?;
    let who: GhUser = gh_get(&state, &app.api_url, "/user", &token)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Upstream(format!("GitHub user request: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub user response: {e}")))?;
    if who.id != user.github_id {
        return Err(AppError::BadRequest(
            "that GitHub authorization belongs to a different user".into(),
        ));
    }
    let listed: UserInstallations = gh_get(
        &state,
        &app.api_url,
        "/user/installations?per_page=100",
        &token,
    )
    .send()
    .await
    .and_then(|r| r.error_for_status())
    .map_err(|e| AppError::Upstream(format!("GitHub installations request: {e}")))?
    .json()
    .await
    .map_err(|e| AppError::Upstream(format!("GitHub installations response: {e}")))?;
    let inst = listed
        .installations
        .into_iter()
        .find(|i| i.id == installation_id)
        .ok_or_else(|| {
            AppError::BadRequest("that installation is not available to your GitHub account".into())
        })?;

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO github_installations
           (id, account_id, account_login, account_type, repository_selection)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET account_id = EXCLUDED.account_id,
               account_login = EXCLUDED.account_login,
               account_type = EXCLUDED.account_type,
               repository_selection = EXCLUDED.repository_selection,
               updated_at = now()",
    )
    .bind(inst.id)
    .bind(inst.account.id)
    .bind(&inst.account.login)
    .bind(&inst.account.kind)
    .bind(&inst.repository_selection)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO user_installations (user_id, installation_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING",
    )
    .bind(user.id)
    .bind(inst.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut res = Redirect::to("/?github_app=installed").into_response();
    res.headers_mut().append(header::SET_COOKIE, clear);
    Ok(res)
}

/// A repository the app can reach, as returned by `GET /api/github/repos`.
#[derive(Debug, Serialize)]
pub struct Repo {
    pub id: i64,
    pub installation_id: i64,
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub default_branch: String,
    pub html_url: String,
}

#[derive(Deserialize)]
struct RepoPage {
    repositories: Vec<GhRepo>,
}

#[derive(Deserialize)]
struct GhRepo {
    id: i64,
    name: String,
    full_name: String,
    private: bool,
    default_branch: String,
    html_url: String,
    owner: GhOwner,
}

#[derive(Deserialize)]
struct GhOwner {
    login: String,
}

/// Every repository one installation can reach, page by page.
async fn installation_repos(
    state: &AppState,
    app: &GithubApp,
    installation_id: i64,
    token: &str,
) -> Result<Vec<Repo>, AppError> {
    let mut out = Vec::new();
    for page in 1.. {
        let batch: RepoPage = gh_get(
            state,
            &app.api_url,
            &format!("/installation/repositories?per_page={PAGE_SIZE}&page={page}"),
            token,
        )
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Upstream(format!("GitHub repositories request: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("GitHub repositories response: {e}")))?;
        let n = batch.repositories.len();
        out.extend(batch.repositories.into_iter().map(|r| Repo {
            id: r.id,
            installation_id,
            owner: r.owner.login,
            name: r.name,
            full_name: r.full_name,
            private: r.private,
            default_branch: r.default_branch,
            html_url: r.html_url,
        }));
        if n < PAGE_SIZE {
            break;
        }
    }
    Ok(out)
}

/// Repositories from the signed-in user's installations, and no others.
/// An installation GitHub no longer knows (uninstalled) is forgotten.
async fn list_repos(
    State(state): State<AppState>,
    user: User,
) -> Result<Json<Vec<Repo>>, AppError> {
    let app = app(&state)?;
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT installation_id FROM user_installations WHERE user_id = $1
         ORDER BY installation_id",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    let mut repos = Vec::new();
    for id in ids {
        let Some(token) = installation_token(&state, id).await? else {
            sqlx::query("DELETE FROM github_installations WHERE id = $1")
                .bind(id)
                .execute(&state.db)
                .await?;
            continue;
        };
        repos.extend(installation_repos(&state, app, id, &token).await?);
    }
    repos.sort_by(|a, b| a.full_name.cmp(&b.full_name));
    Ok(Json(repos))
}
