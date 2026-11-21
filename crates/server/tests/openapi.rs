#![allow(clippy::unwrap_used, clippy::expect_used)]
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use spectrace_server::{app, openapi::ApiDoc, AppState};
use sqlx::PgPool;
use tower::ServiceExt;
use utoipa::OpenApi;

/// Needs `DATABASE_URL` like the other handler tests.
#[sqlx::test]
async fn serves_the_openapi_document(pool: PgPool) {
    let res = app(AppState::new(pool, None))
        .oneshot(
            Request::get("/api/openapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    for path in [
        "/api/health",
        "/api/me",
        "/api/auth/logout",
        "/api/auth/github/login",
    ] {
        assert!(v["paths"].get(path).is_some(), "missing {path}");
    }
}

/// The committed `web/openapi.json` (the client is generated from it) must match
/// the handlers. Fix with `just api-client`.
#[test]
fn committed_openapi_is_current() {
    let committed = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/openapi.json"
    ))
    .expect("web/openapi.json exists");
    let committed: serde_json::Value = serde_json::from_str(&committed).unwrap();
    let live = serde_json::to_value(ApiDoc::openapi()).unwrap();
    assert_eq!(
        committed, live,
        "web/openapi.json is stale: run `just api-client`"
    );
}
