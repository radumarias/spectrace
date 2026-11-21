use spectrace_server::{app, connect, init_logging, AppState, Config};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    init_logging(config.log_format);

    let db = connect(&config.database_url).await?;
    tracing::info!("database ready, migrations applied");

    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "spectrace-server listening");
    axum::serve(
        listener,
        app(AppState::new(db, config.github.clone()).with_github_app(config.github_app.clone())),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
