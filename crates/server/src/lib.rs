use axum::{http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use serde_json::json;

/// The one error type for the server. Handlers return `Result<_, AppError>`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let body = Json(json!({ "error": self.to_string() }));
        (StatusCode::INTERNAL_SERVER_ERROR, body).into_response()
    }
}

async fn health() -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        json!({ "status": "ok", "service": "spectrace-server" }),
    ))
}

pub fn app() -> Router {
    Router::new().route("/api/health", get(health))
}
