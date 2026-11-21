use axum::{http::StatusCode, response::IntoResponse, response::Response, Json};
use serde_json::json;

/// The one error type for the server. Handlers return `Result<_, AppError>`
/// and every variant maps to a JSON body `{"error": {"code", "message"}}`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("bad gateway: {0}")]
    Upstream(String),
    #[error("configuration error: {0}")]
    Config(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
            Self::Database(_) | Self::Migrate(_) | Self::Config(_) | Self::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::BadRequest(_) => "bad_request",
            Self::Unauthorized(_) => "unauthorized",
            Self::Upstream(_) => "upstream",
            Self::Config(_) => "config",
            Self::Database(_) => "database",
            Self::Migrate(_) => "migration",
            Self::Internal(_) => "internal",
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        // Never leak internals for 5xx; log them instead.
        let message = if status.is_server_error() {
            tracing::error!(error = %self, code = self.code(), "request failed");
            "internal server error".to_string()
        } else {
            self.to_string()
        };
        let body = Json(json!({ "error": { "code": self.code(), "message": message } }));
        (status, body).into_response()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn body_of(e: AppError) -> (StatusCode, serde_json::Value) {
        let res = e.into_response();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn client_errors_show_message() {
        let (s, v) = body_of(AppError::NotFound("pr 1".into())).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        assert_eq!(v["error"]["code"], "not_found");
        assert_eq!(v["error"]["message"], "not found: pr 1");
    }

    #[tokio::test]
    async fn server_errors_hide_details() {
        let (s, v) = body_of(AppError::Internal("secret".into())).await;
        assert_eq!(s, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(v["error"]["message"], "internal server error");
    }
}
