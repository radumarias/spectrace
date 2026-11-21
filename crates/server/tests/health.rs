#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Needs `DATABASE_URL` (run `just db` first). `#[sqlx::test]` creates a
//! throwaway database per test and applies the migrations to it.
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use spectrace_server::{app, AppState};
use sqlx::PgPool;
use tower::ServiceExt;

#[sqlx::test]
async fn health_returns_ok(pool: PgPool) {
    let res = app(AppState { db: pool })
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["status"], "ok");
    assert_eq!(v["database"], "ok");
}

#[sqlx::test]
async fn migrations_applied(pool: PgPool) {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM app_meta")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test]
async fn unknown_route_is_404(pool: PgPool) {
    let res = app(AppState { db: pool })
        .oneshot(Request::get("/api/nope").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}
