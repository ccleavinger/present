use axum::Router;
use present_domain::CreateDeckRequest;
use present_store::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "present_server=info,present_http_api=info,present_store=info".into()
            }),
        )
        .init();

    let data_root = std::env::var("PRESENT_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data"));
    let decks_root = data_root.join("decks");
    std::fs::create_dir_all(&decks_root)?;

    let state = Arc::new(AppState::new(decks_root));
    seed_demo_deck(&state)?;
    spawn_session_watchdog(state.clone());

    let app = Router::new().nest("/api", present_http_api::router(state.clone()));
    let addr = std::env::var("PRESENT_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Present API listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("server stopped; committing open editing sessions");
    let _ = tokio::task::spawn_blocking(move || state.close_all_sessions()).await;
    Ok(())
}

fn seed_demo_deck(state: &AppState) -> anyhow::Result<()> {
    let seed = std::env::var("PRESENT_SEED")
        .map(|value| value != "0")
        .unwrap_or(true);
    if seed && state.list_decks()?.is_empty() {
        match state.create_deck(CreateDeckRequest {
            title: "Welcome to Present".into(),
            id: Some("welcome".into()),
        }) {
            Ok(_) => tracing::info!("seeded demo deck 'welcome'"),
            Err(err) => tracing::warn!("could not seed demo deck: {err}"),
        }
    }
    Ok(())
}

fn spawn_session_watchdog(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        loop {
            ticker.tick().await;
            let state = state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                state.expire_sessions(Duration::from_secs(15 * 60));
            })
            .await;
        }
    });
}

async fn shutdown_signal() {
    let ctrl_c = async {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {}
            Err(err) => {
                tracing::warn!(error = %err, "could not listen for Ctrl+C");
                std::future::pending::<()>().await;
            }
        }
    };
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate_signal() => {}
    }
    tracing::info!("shutdown requested; draining connections");
}

#[cfg(unix)]
async fn terminate_signal() {
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut signal) => {
            signal.recv().await;
        }
        Err(err) => {
            tracing::warn!(error = %err, "could not listen for SIGTERM");
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(not(unix))]
async fn terminate_signal() {
    std::future::pending::<()>().await;
}
