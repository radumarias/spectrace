use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};

use crate::{AppError, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

/// Liveness plus a database round trip, so a broken database shows up here.
async fn health(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let one: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&state.db).await?;
    Ok(Json(json!({
        "status": "ok",
        "service": "spectrace-server",
        "database": if one == 1 { "ok" } else { "error" },
    })))
}
