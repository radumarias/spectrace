#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Sign-in end to end against a mock GitHub (no network). Needs `DATABASE_URL`.
use axum::{
    body::Body,
    http::{header, Request, Response},
    routing::{get, post},
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use spectrace_server::{app, AppState, GithubOAuth};
use sqlx::PgPool;
use tower::ServiceExt;

/// A fake GitHub: accepts code `good-code`, knows one user.
async fn mock_github() -> String {
    let router = Router::new()
        .route(
            "/login/oauth/access_token",
            post(|body: String| async move {
                if body.contains("code=good-code") && body.contains("client_secret=shh") {
                    Json(json!({"access_token": "gho_fake", "token_type": "bearer"}))
                } else {
                    Json(json!({"error": "bad_verification_code", "error_description": "nope"}))
                }
            }),
        )
        .route(
            "/user",
            get(|req: Request<Body>| async move {
                let ok = req
                    .headers()
                    .get(header::AUTHORIZATION)
                    .map(|v| v.to_str().unwrap())
                    == Some("Bearer gho_fake");
                if ok {
                    (
                        axum::http::StatusCode::OK,
                        Json(json!({
                            "id": 8073584,
                            "login": "octocat",
                            "name": "The Octocat",
                            "avatar_url": "https://avatars.example/octocat.png"
                        })),
                    )
                } else {
                    (axum::http::StatusCode::UNAUTHORIZED, Json(json!({})))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    url
}

async fn test_app(pool: PgPool) -> Router {
    let mock = mock_github().await;
    app(AppState::new(
        pool,
        Some(GithubOAuth {
            client_id: "cid".into(),
            client_secret: "shh".into(),
            public_url: "http://localhost:5173".into(),
            oauth_url: mock.clone(),
            api_url: mock,
            secure_cookies: false,
        }),
    ))
}

async fn send(app: &Router, req: Request<Body>) -> Response<Body> {
    app.clone().oneshot(req).await.unwrap()
}

fn set_cookie_pair(res: &Response<Body>, name: &str) -> Option<String> {
    res.headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .find(|v| v.starts_with(&format!("{name}=")))
        .map(|v| v.split(';').next().unwrap().to_string())
}

async fn json_body(res: Response<Body>) -> Value {
    serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

/// Run login + callback; returns the session cookie pair.
async fn sign_in(app: &Router) -> String {
    let res = send(
        app,
        Request::get("/api/auth/github/login")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 303);
    let location = res.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .to_string();
    assert!(location.contains("/login/oauth/authorize?client_id=cid"));
    let state_cookie = set_cookie_pair(&res, "spectrace_oauth_state").unwrap();
    let state = state_cookie.split_once('=').unwrap().1;
    assert!(location.contains(&format!("state={state}")));

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
    assert_eq!(res.status(), 303);
    assert_eq!(res.headers()[header::LOCATION], "/");
    let session = set_cookie_pair(&res, "spectrace_session").unwrap();
    let raw = res
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .find(|v| v.starts_with("spectrace_session="))
        .unwrap();
    assert!(raw.contains("HttpOnly") && raw.contains("SameSite=Lax"));
    session
}

#[sqlx::test]
async fn sign_in_then_read_me_then_sign_out(pool: PgPool) {
    let app = test_app(pool.clone()).await;

    // Signed out: 401.
    let res = send(&app, Request::get("/api/me").body(Body::empty()).unwrap()).await;
    assert_eq!(res.status(), 401);
    assert_eq!(json_body(res).await["error"]["code"], "unauthorized");

    let session = sign_in(&app).await;

    let res = send(
        &app,
        Request::get("/api/me")
            .header(header::COOKIE, &session)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 200);
    let me = json_body(res).await;
    assert_eq!(me["login"], "octocat");
    assert_eq!(me["github_id"], 8073584);
    assert_eq!(me["name"], "The Octocat");

    // The raw cookie token is never stored.
    let token = session.split_once('=').unwrap().1;
    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sessions WHERE encode(token_hash, 'hex') = $1")
            .bind(token)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, 0);

    // Signing in again reuses the same user row.
    sign_in(&app).await;
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users, 1);

    let res = send(
        &app,
        Request::post("/api/auth/logout")
            .header(header::COOKIE, &session)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 204);
    let res = send(
        &app,
        Request::get("/api/me")
            .header(header::COOKIE, &session)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 401);
}

#[sqlx::test]
async fn expired_session_is_rejected(pool: PgPool) {
    let app = test_app(pool.clone()).await;
    let session = sign_in(&app).await;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 minute'")
        .execute(&pool)
        .await
        .unwrap();
    let res = send(
        &app,
        Request::get("/api/me")
            .header(header::COOKIE, &session)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 401);
}

#[sqlx::test]
async fn callback_rejects_wrong_state_and_bad_code(pool: PgPool) {
    let app = test_app(pool).await;
    // State cookie missing or different.
    let res = send(
        &app,
        Request::get("/api/auth/github/callback?code=good-code&state=abc")
            .header(header::COOKIE, "spectrace_oauth_state=other")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 400);
    // Right state, code GitHub rejects.
    let res = send(
        &app,
        Request::get("/api/auth/github/callback?code=bad&state=abc")
            .header(header::COOKIE, "spectrace_oauth_state=abc")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 400);
    assert!(set_cookie_pair(&res, "spectrace_session").is_none());
}

#[sqlx::test]
async fn login_without_config_is_a_server_error(pool: PgPool) {
    let app = app(AppState::new(pool, None));
    let res = send(
        &app,
        Request::get("/api/auth/github/login")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 500);
}

#[sqlx::test]
async fn logout_without_session_is_fine(pool: PgPool) {
    let app = test_app(pool).await;
    let res = send(
        &app,
        Request::post("/api/auth/logout")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), 204);
}
