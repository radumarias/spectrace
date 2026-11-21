use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use utoipa::ToSchema;

use crate::{AppError, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

#[derive(Serialize, ToSchema)]
pub struct Health {
    pub status: String,
    pub service: String,
    pub database: String,
}

/// Liveness plus a database round trip, so a broken database shows up here.
#[utoipa::path(
    get,
    path = "/api/health",
    tag = "health",
    responses((status = 200, description = "Server and database are up", body = Health))
)]
pub async fn health(State(state): State<AppState>) -> Result<Json<Health>, AppError> {
    let one: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&state.db).await?;
    Ok(Json(Health {
        status: "ok".into(),
        service: "spectrace-server".into(),
        database: if one == 1 { "ok" } else { "error" }.into(),
    }))
}
