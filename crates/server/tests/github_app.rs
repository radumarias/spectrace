#![allow(clippy::unwrap_used, clippy::expect_used)]
//! GitHub App install flow and repo list against a mock GitHub (no network).
//! Needs `DATABASE_URL`.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Request, Response, StatusCode},
    routing::{get, post},
    Json, Router,
};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{json, Value};
use spectrace_server::{app, AppState, GithubApp, GithubOAuth};
use sqlx::PgPool;
use tower::ServiceExt;

const PRIVATE_KEY: &str = include_str!("fixtures/test-app-key.pem");
const PUBLIC_KEY: &str = include_str!("fixtures/test-app-key.pub.pem");

#[derive(Clone, Default)]
struct Mock {
    token_mints: Arc<AtomicUsize>,
}

fn bearer(h: &HeaderMap) -> String {
    h.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string()
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
}

fn repo(owner: &str, name: &str, id: i64) -> Value {
    json!({
        "id": id, "name": name, "full_name": format!("{owner}/{name}"),
        "private": id % 2 == 0, "default_branch": "main",
        "html_url": format!("https://github.example/{owner}/{name}"),
        "owner": {"login": owner}
    })
}

/// A fake GitHub. Two people exist: octocat (id 8073584, token gho_octocat)
/// and mona (id 42, token gho_mona). Installation 1001 is octocat's own,
/// 2002 is the acme org (150 repos, so the list needs two pages), 3003 is
/// mona's, 9999 was uninstalled.
async fn mock_github() -> (String, Mock) {
    let mock = Mock::default();
    let router = Router::new()
        .route(
            "/login/oauth/access_token",
            post(|body: String| async move {
                let token = if body.contains("code=good-code") || body.contains("code=install-code")
                {
                    "gho_octocat"
                } else if body.contains("code=mona-code") {
                    "gho_mona"
                } else {
                    return Json(json!({"error": "bad_verification_code"}));
                };
                Json(json!({"access_token": token}))
            }),
        )
        .route(
            "/user",
            get(|h: HeaderMap| async move {
                match bearer(&h).as_str() {
                    "gho_octocat" => (
                        StatusCode::OK,
                        Json(json!({"id": 8073584, "login": "octocat"})),
                    ),
                    "gho_mona" => (StatusCode::OK, Json(json!({"id": 42, "login": "mona"}))),
                    _ => (StatusCode::UNAUTHORIZED, Json(json!({}))),
                }
            }),
        )
        .route(
            "/user/installations",
            get(|h: HeaderMap| async move {
                let inst = |id: i64, login: &str, kind: &str, sel: &str| {
                    json!({"id": id, "repository_selection": sel,
                           "account": {"id": id + 7, "login": login, "type": kind}})
                };
                let list = match bearer(&h).as_str() {
                    "gho_octocat" => vec![
                        inst(1001, "octocat", "User", "all"),
                        inst(2002, "acme", "Organization", "selected"),
                    ],
                    "gho_mona" => vec![inst(3003, "mona", "User", "all")],
                    _ => vec![],
                };
                Json(json!({"total_count": list.len(), "installations": list}))
            }),
        )
        .route(
            "/app/installations/{id}/access_tokens",
            post(
                |State(m): State<Mock>, Path(id): Path<i64>, h: HeaderMap| async move {
                    // The app must prove itself with a JWT signed by its key.
                    let key = jsonwebtoken::DecodingKey::from_rsa_pem(PUBLIC_KEY.as_bytes())
                        .unwrap();
                    let mut v = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
                    v.set_required_spec_claims(&["exp", "iss"]);
                    let ok = jsonwebtoken::decode::<Claims>(&bearer(&h), &key, &v)
                        .map(|t| t.claims.iss == "12345")
                        .unwrap_or(false);
                    if !ok {
                        return (StatusCode::UNAUTHORIZED, Json(json!({})));
                    }
                    if id == 9999 {
                        return (StatusCode::NOT_FOUND, Json(json!({})));
                    }
                    m.token_mints.fetch_add(1, Ordering::SeqCst);
                    let exp = chrono::Utc::now() + chrono::Duration::hours(1);
                    (
                        StatusCode::CREATED,
                        Json(json!({"token": format!("ghs_{id}"), "expires_at": exp})),
                    )
                },
            ),
        )
        .route(
            "/installation/repositories",
            get(
                |h: HeaderMap, Query(q): Query<std::collections::HashMap<String, String>>| async move {
                    let page: usize = q.get("page").map_or(1, |p| p.parse().unwrap());
                    let all: Vec<Value> = match bearer(&h).as_str() {
                        "ghs_1001" => vec![repo("octocat", "hello", 1), repo("octocat", "spoon", 2)],
                        "ghs_2002" => (0..150)
                            .map(|i| repo("acme", &format!("r{i:03}"), 100 + i))
                            .collect(),
                        "ghs_3003" => vec![repo("mona", "secret", 3)],
                        _ => return (StatusCode::UNAUTHORIZED, Json(json!({}))),
                    };
                    let slice: Vec<Value> = all.iter().skip((page - 1) * 100).take(100).cloned().collect();
                    (
                        StatusCode::OK,
                        Json(json!({"total_count": all.len(), "repositories": slice})),
                    )
                },
            ),
        )
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, mock)
}

async fn test_app(pool: PgPool) -> (Router, Mock) {
    let (mock_url, mock) = mock_github().await;
    let state = AppState::new(
        pool,
        Some(GithubOAuth {
            client_id: "cid".into(),
            client_secret: "shh".into(),
            public_url: "http://localhost:5173".into(),
            oauth_url: mock_url.clone(),
            api_url: mock_url.clone(),
            secure_cookies: false,
        }),
    )
    .with_github_app(Some(GithubApp {
        app_id: "12345".into(),
        slug: "spectrace-test".into(),
        private_key: PRIVATE_KEY.into(),
        webhook_secret: Some("hook".into()),
        web_url: mock_url.clone(),
        api_url: mock_url,
    }));
    (app(state), mock)
}

async fn send(app: &Router, req: Request<Body>) -> Response<Body> {
    app.clone().oneshot(req).await.unwrap()
}

async fn json_body(res: Response<Body>) -> Value {
    serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

fn set_cookie_pair(res: &Response<Body>, name: &str) -> Option<String> {
    res.headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .find(|v| v.starts_with(&format!("{name}=")))
        .map(|v| v.split(';').next().unwrap().to_string())
}

/// Sign in as octocat (the mock's `good-code`); returns the session cookie.
async fn sign_in(app: &Router) -> String {
    let res = send(
        app,
        Request::get("/api/auth/github/login")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let state_cookie = set_cookie_pair(&res, "spectrace_oauth_state").unwrap();
    let state = state_cookie.split_once('=').unwrap().1;
    let res = send(
        app,
        Request::get(format!(
            "/api/auth/github/callback?code=good-code&state={state}"
        ))
        .header(header::COOKIE, &state_cookie)
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    set_cookie_pair(&res, "spectrace_session").unwrap()
}

/// Start the install flow; returns (redirect location, state cookie pair).
async fn start_install(app: &Router, session: &str) -> (String, String) {
    let res = send(
        app,
        Request::get("/api/github/install")
            .header(header::COOKIE, session)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 303);
    let location = res.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .to_string();
    (
        location,
        set_cookie_pair(&res, "spectrace_install_state").unwrap(),
    )
}

/// Run the whole install dance for `installation_id`; returns the callback response.
async fn install(app: &Router, session: &str, installation_id: i64, code: &str) -> Response<Body> {
    let (_, state_cookie) = start_install(app, session).await;
    let state = state_cookie.split_once('=').unwrap().1.to_string();
    send(
        app,
        Request::get(format!(
            "/api/github/install/callback?installation_id={installation_id}&setup_action=install&code={code}&state={state}"
        ))
        .header(header::COOKIE, format!("{session}; {state_cookie}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
}

async fn repos(app: &Router, session: &str) -> Value {
    let res = send(
        app,
        Request::get("/api/github/repos")
            .header(header::COOKIE, session)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 200);
    json_body(res).await
}

#[sqlx::test]
async fn repo_list_only_has_repos_from_the_users_installations(pool: PgPool) {
    let (app, mock) = test_app(pool.clone()).await;
    let session = sign_in(&app).await;

    // Nothing installed yet.
    assert_eq!(repos(&app, &session).await, json!([]));

    // The install page is the app's, with our state.
    let (location, state_cookie) = start_install(&app, &session).await;
    let state = state_cookie.split_once('=').unwrap().1;
    assert!(location.contains("/apps/spectrace-test/installations/new"));
    assert!(location.contains(&format!("state={state}")));

    for id in [1001, 2002] {
        let res = install(&app, &session, id, "install-code").await;
        assert_eq!(res.status(), 303);
        assert_eq!(res.headers()[header::LOCATION], "/?github_app=installed");
    }
    // Installing twice is fine.
    install(&app, &session, 1001, "install-code").await;

    // Someone else's installation, already in the database.
    sqlx::query("INSERT INTO users (github_id, login) VALUES (42, 'mona')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection)
         VALUES (3003, 3010, 'mona', 'User', 'all')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_installations (user_id, installation_id)
         SELECT id, 3003 FROM users WHERE github_id = 42",
    )
    .execute(&pool)
    .await
    .unwrap();

    let list = repos(&app, &session).await;
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["full_name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 152, "2 personal + 150 org (two pages)");
    assert!(names
        .iter()
        .all(|n| n.starts_with("octocat/") || n.starts_with("acme/")));
    assert!(!names.contains(&"mona/secret"));
    assert!(
        names.windows(2).all(|w| w[0] <= w[1]),
        "sorted by full name"
    );
    let hello = list
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "hello")
        .unwrap();
    assert_eq!(hello["owner"], "octocat");
    assert_eq!(hello["installation_id"], 1001);
    assert_eq!(hello["default_branch"], "main");
    assert_eq!(hello["private"], false);

    // Account details were stored.
    let (login, kind): (String, String) = sqlx::query_as(
        "SELECT account_login, account_type FROM github_installations WHERE id = 2002",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((login.as_str(), kind.as_str()), ("acme", "Organization"));

    // Tokens are short-lived but reused until they near expiry: two lists, two mints.
    repos(&app, &session).await;
    assert_eq!(mock.token_mints.load(Ordering::SeqCst), 2);
}

#[sqlx::test]
async fn install_callback_refuses_what_github_does_not_vouch_for(pool: PgPool) {
    let (app, _) = test_app(pool.clone()).await;
    let session = sign_in(&app).await;

    // Someone else's installation id (mona's 3003) is not in octocat's list.
    let res = install(&app, &session, 3003, "install-code").await;
    assert_eq!(res.status(), 400);

    // An authorization from a different GitHub user.
    let res = install(&app, &session, 3003, "mona-code").await;
    assert_eq!(res.status(), 400);

    // A code GitHub rejects.
    let res = install(&app, &session, 1001, "nope").await;
    assert_eq!(res.status(), 400);

    // No code at all.
    let (_, state_cookie) = start_install(&app, &session).await;
    let state = state_cookie.split_once('=').unwrap().1;
    let res = send(
        &app,
        Request::get(format!(
            "/api/github/install/callback?installation_id=1001&state={state}"
        ))
        .header(header::COOKIE, format!("{session}; {state_cookie}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 400);

    // Wrong state.
    let res = send(
        &app,
        Request::get("/api/github/install/callback?installation_id=1001&code=install-code&state=x")
            .header(header::COOKIE, format!("{session}; {state_cookie}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 400);

    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM github_installations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test]
async fn install_request_for_org_owner_approval_records_nothing(pool: PgPool) {
    let (app, _) = test_app(pool.clone()).await;
    let session = sign_in(&app).await;
    let (_, state_cookie) = start_install(&app, &session).await;
    let state = state_cookie.split_once('=').unwrap().1;
    let res = send(
        &app,
        Request::get(format!(
            "/api/github/install/callback?setup_action=request&state={state}"
        ))
        .header(header::COOKIE, format!("{session}; {state_cookie}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 303);
    assert_eq!(res.headers()[header::LOCATION], "/?github_app=requested");
}

#[sqlx::test]
async fn uninstalled_installation_is_forgotten(pool: PgPool) {
    let (app, _) = test_app(pool.clone()).await;
    let session = sign_in(&app).await;
    install(&app, &session, 1001, "install-code").await;
    // GitHub has no installation 9999 any more.
    sqlx::query(
        "INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection)
         VALUES (9999, 1, 'gone', 'User', 'all')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_installations (user_id, installation_id)
         SELECT id, 9999 FROM users WHERE github_id = 8073584",
    )
    .execute(&pool)
    .await
    .unwrap();

    let list = repos(&app, &session).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    let left: Vec<i64> = sqlx::query_scalar("SELECT id FROM github_installations")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(left, vec![1001]);
}

#[sqlx::test]
async fn routes_need_sign_in_and_app_config(pool: PgPool) {
    let (app, _) = test_app(pool.clone()).await;
    for path in ["/api/github/repos", "/api/github/install"] {
        let res = send(&app, Request::get(path).body(Body::empty()).unwrap()).await;
        assert_eq!(res.status(), 401, "{path}");
    }

    // Signed in, but the app is not configured: a clear server error.
    let (mock_url, _) = mock_github().await;
    let unconfigured = spectrace_server::app(AppState::new(
        pool,
        Some(GithubOAuth {
            client_id: "cid".into(),
            client_secret: "shh".into(),
            public_url: "http://localhost:5173".into(),
            oauth_url: mock_url.clone(),
            api_url: mock_url,
            secure_cookies: false,
        }),
    ));
    let session = sign_in(&unconfigured).await;
    let res = send(
        &unconfigured,
        Request::get("/api/github/repos")
            .header(header::COOKIE, &session)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 500);
}
