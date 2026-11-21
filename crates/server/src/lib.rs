pub mod config;
pub mod error;
pub mod routes;

use axum::Router;
use sqlx::{postgres::PgPoolOptions, PgPool};
use tower_http::trace::TraceLayer;

pub use config::Config;
pub use error::AppError;

/// Shared state handed to every handler.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
}

/// Connect to Postgres and apply pending migrations.
pub async fn connect(database_url: &str) -> Result<PgPool, AppError> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .merge(routes::router())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Install the global tracing subscriber. Level comes from `RUST_LOG`
/// (default `info`).
pub fn init_logging(format: config::LogFormat) {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = fmt().with_env_filter(filter);
    match format {
        config::LogFormat::Json => builder.json().init(),
        config::LogFormat::Pretty => builder.init(),
    }
}
