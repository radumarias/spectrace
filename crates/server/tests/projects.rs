#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Projects API: each call, validation and the owner check. Needs `DATABASE_URL`.
use axum::{
    body::Body,
    http::{header, Method, Request, Response, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spectrace_server::{app, AppState};
use sqlx::PgPool;
use tower::ServiceExt;

/// Create a user with a live session; returns the cookie header value.
async fn user_with_session(pool: &PgPool, github_id: i64, login: &str) -> String {
    let user_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO users (github_id, login) VALUES ($1, $2) RETURNING id")
            .bind(github_id)
            .bind(login)
            .fetch_one(pool)
            .await
            .unwrap();
    let token = format!("token-{login}");
    sqlx::query(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
    )
    .bind(user_id)
    .bind(Sha256::digest(token.as_bytes()).to_vec())
    .execute(pool)
    .await
    .unwrap();
    format!("spectrace_session={token}")
}

async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, c);
    }
    let req = match body {
        Some(b) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b.to_string())),
        None => req.body(Body::empty()),
    }
    .unwrap();
    let res: Response<Body> = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, json)
}

fn test_app(pool: PgPool) -> Router {
    app(AppState::new(pool, None))
}

#[sqlx::test]
async fn create_and_read_a_project(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let app = test_app(pool);

    let (status, created) = call(
        &app,
        Method::POST,
        "/api/projects",
        Some(&alice),
        Some(json!({
            "name": "  Shop  ",
            "context": "Checkout flow lives in the shop app.",
            "repos": [
                {"full_name": "acme/shop", "github_repo_id": 42, "default_branch": "trunk"},
                {"full_name": "acme/infra"}
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["name"], "Shop");
    assert_eq!(created["context"], "Checkout flow lives in the shop app.");
    let repos = created["repos"].as_array().unwrap();
    assert_eq!(repos.len(), 2);
    let shop = repos
        .iter()
        .find(|r| r["full_name"] == "acme/shop")
        .unwrap();
    assert_eq!(shop["github_repo_id"], 42);
    assert_eq!(shop["default_branch"], "trunk");
    assert_eq!(shop["index_state"], "pending");
    let infra = repos
        .iter()
        .find(|r| r["full_name"] == "acme/infra")
        .unwrap();
    assert_eq!(infra["default_branch"], "main");
    assert!(infra["github_repo_id"].is_null());

    let id = created["id"].as_str().unwrap();
    let (status, read) = call(
        &app,
        Method::GET,
        &format!("/api/projects/{id}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read, created);
}

#[sqlx::test]
async fn create_without_repos_or_context(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let app = test_app(pool);
    let (status, p) = call(
        &app,
        Method::POST,
        "/api/projects",
        Some(&alice),
        Some(json!({"name": "Bare"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(p["context"], "");
    assert_eq!(p["repos"], json!([]));
}

#[sqlx::test]
async fn create_validates_input(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let app = test_app(pool);
    let bad = [
        json!({"name": "   "}),
        json!({"name": "x".repeat(121)}),
        json!({"name": "p", "repos": [{"full_name": "no-slash"}]}),
        json!({"name": "p", "repos": [{"full_name": "a/b/c"}]}),
        json!({"name": "p", "repos": [{"full_name": "a/b"}, {"full_name": "A/B"}]}),
        json!({"name": "p", "repos": [{"full_name": "a/b", "default_branch": " "}]}),
    ];
    for body in bad {
        let (status, err) = call(
            &app,
            Method::POST,
            "/api/projects",
            Some(&alice),
            Some(body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(err["error"]["code"], "bad_request");
    }
    // Nothing was stored by the failed attempts.
    let (_, list) = call(&app, Method::GET, "/api/projects", Some(&alice), None).await;
    assert_eq!(list, json!([]));
}

#[sqlx::test]
async fn list_returns_only_my_projects_with_their_repos(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let bob = user_with_session(&pool, 2, "bob").await;
    let app = test_app(pool);
    for (who, name, repo) in [
        (&alice, "A1", "a/one"),
        (&bob, "B1", "b/one"),
        (&alice, "A2", "a/two"),
    ] {
        let (s, _) = call(
            &app,
            Method::POST,
            "/api/projects",
            Some(who),
            Some(json!({"name": name, "repos": [{"full_name": repo}]})),
        )
        .await;
        assert_eq!(s, StatusCode::CREATED);
    }
    let (status, list) = call(&app, Method::GET, "/api/projects", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["name"], "A1");
    assert_eq!(list[0]["repos"][0]["full_name"], "a/one");
    assert_eq!(list[1]["name"], "A2");
    assert_eq!(list[1]["repos"][0]["full_name"], "a/two");

    let (_, list) = call(&app, Method::GET, "/api/projects", Some(&bob), None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["name"], "B1");
}

#[sqlx::test]
async fn update_changes_only_what_is_sent(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let app = test_app(pool.clone());
    let (_, p) = call(
        &app,
        Method::POST,
        "/api/projects",
        Some(&alice),
        Some(json!({"name": "Old", "context": "keep me", "repos": [{"full_name": "a/one"}, {"full_name": "a/two"}]})),
    )
    .await;
    let id = p["id"].as_str().unwrap();
    let uri = format!("/api/projects/{id}");
    let one_id = p["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["full_name"] == "a/one")
        .unwrap()["id"]
        .clone();

    // Rename only.
    let (status, renamed) = call(
        &app,
        Method::PATCH,
        &uri,
        Some(&alice),
        Some(json!({"name": "New"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["name"], "New");
    assert_eq!(renamed["context"], "keep me");
    assert_eq!(renamed["repos"].as_array().unwrap().len(), 2);
    assert_ne!(renamed["updated_at"], p["updated_at"]);

    // Context only, can be cleared.
    let (_, cleared) = call(
        &app,
        Method::PATCH,
        &uri,
        Some(&alice),
        Some(json!({"context": ""})),
    )
    .await;
    assert_eq!(cleared["context"], "");
    assert_eq!(cleared["name"], "New");

    // Replace repos: a/one stays (same id, index state kept), a/two goes, a/three is new.
    sqlx::query("UPDATE project_repos SET index_state = 'ready' WHERE full_name = 'a/one'")
        .execute(&pool)
        .await
        .unwrap();
    let (status, swapped) = call(
        &app,
        Method::PATCH,
        &uri,
        Some(&alice),
        Some(json!({"repos": [{"full_name": "a/one", "default_branch": "dev"}, {"full_name": "a/three"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let repos = swapped["repos"].as_array().unwrap();
    assert_eq!(repos.len(), 2);
    let one = repos.iter().find(|r| r["full_name"] == "a/one").unwrap();
    assert_eq!(one["id"], one_id);
    assert_eq!(one["index_state"], "ready");
    assert_eq!(one["default_branch"], "dev");
    assert!(repos.iter().any(|r| r["full_name"] == "a/three"));
    assert!(!repos.iter().any(|r| r["full_name"] == "a/two"));

    // Empty list removes all repos.
    let (_, none) = call(
        &app,
        Method::PATCH,
        &uri,
        Some(&alice),
        Some(json!({"repos": []})),
    )
    .await;
    assert_eq!(none["repos"], json!([]));

    // Invalid updates are rejected and change nothing.
    let (status, _) = call(
        &app,
        Method::PATCH,
        &uri,
        Some(&alice),
        Some(json!({"name": ""})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, still) = call(&app, Method::GET, &uri, Some(&alice), None).await;
    assert_eq!(still["name"], "New");
}

#[sqlx::test]
async fn delete_removes_the_project_and_its_repos(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let app = test_app(pool.clone());
    let (_, p) = call(
        &app,
        Method::POST,
        "/api/projects",
        Some(&alice),
        Some(json!({"name": "Gone", "repos": [{"full_name": "a/one"}]})),
    )
    .await;
    let uri = format!("/api/projects/{}", p["id"].as_str().unwrap());
    let (status, _) = call(&app, Method::DELETE, &uri, Some(&alice), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, err) = call(&app, Method::GET, &uri, Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err["error"]["code"], "not_found");
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM project_repos")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
    let (status, _) = call(&app, Method::DELETE, &uri, Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn only_the_owner_can_see_or_change_a_project(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let bob = user_with_session(&pool, 2, "bob").await;
    let app = test_app(pool);
    let (_, p) = call(
        &app,
        Method::POST,
        "/api/projects",
        Some(&alice),
        Some(json!({"name": "Private", "repos": [{"full_name": "a/one"}]})),
    )
    .await;
    let uri = format!("/api/projects/{}", p["id"].as_str().unwrap());

    // Bob gets 404 (not 403) on every call, so ids cannot be probed.
    for (method, body) in [
        (Method::GET, None),
        (
            Method::PATCH,
            Some(json!({"name": "Hijacked", "repos": []})),
        ),
        (Method::DELETE, None),
    ] {
        let (status, err) = call(&app, method.clone(), &uri, Some(&bob), body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method}");
        assert_eq!(err["error"]["code"], "not_found");
    }
    // A made-up id looks identical.
    let (status, _) = call(
        &app,
        Method::GET,
        &format!("/api/projects/{}", uuid::Uuid::new_v4()),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Nothing of Alice's changed.
    let (status, mine) = call(&app, Method::GET, &uri, Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mine, p);
}

#[sqlx::test]
async fn every_call_needs_a_signed_in_user(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let app = test_app(pool);
    let (_, p) = call(
        &app,
        Method::POST,
        "/api/projects",
        Some(&alice),
        Some(json!({"name": "P"})),
    )
    .await;
    let uri = format!("/api/projects/{}", p["id"].as_str().unwrap());
    let forged = "spectrace_session=not-a-real-token";

    for cookie in [None, Some(forged)] {
        for (method, path, body) in [
            (Method::GET, "/api/projects".to_string(), None),
            (
                Method::POST,
                "/api/projects".to_string(),
                Some(json!({"name": "x"})),
            ),
            (Method::GET, uri.clone(), None),
            (Method::PATCH, uri.clone(), Some(json!({"name": "x"}))),
            (Method::DELETE, uri.clone(), None),
        ] {
            let (status, err) = call(&app, method.clone(), &path, cookie, body).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
            assert_eq!(err["error"]["code"], "unauthorized");
        }
    }
}

#[sqlx::test]
async fn deleting_a_user_deletes_their_projects(pool: PgPool) {
    let alice = user_with_session(&pool, 1, "alice").await;
    let app = test_app(pool.clone());
    call(
        &app,
        Method::POST,
        "/api/projects",
        Some(&alice),
        Some(json!({"name": "P", "repos": [{"full_name": "a/b"}]})),
    )
    .await;
    sqlx::query("DELETE FROM users")
        .execute(&pool)
        .await
        .unwrap();
    for table in ["projects", "project_repos"] {
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
}
