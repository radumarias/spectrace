//! The OpenAPI document. The web client is generated from it (`just api-client`).
//!
//! When you add a handler, annotate it with `#[utoipa::path]` and list it in
//! `ApiDoc` below, then re-run `just api-client`.
use axum::{routing::get, Json, Router};
use utoipa::OpenApi;

use crate::{auth, error, routes, AppState};

#[derive(OpenApi)]
#[openapi(
    info(title = "spectrace API", version = "0.1.0"),
    paths(routes::health, auth::login, auth::callback, auth::logout, auth::me),
    components(schemas(auth::User, error::ErrorBody, error::ErrorDetail, routes::Health))
)]
pub struct ApiDoc;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/openapi.json", get(spec))
}

async fn spec() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}
