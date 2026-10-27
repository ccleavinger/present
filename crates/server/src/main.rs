use axum::Router;
use present_store::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    load_local_env();
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
    spawn_session_watchdog(state.clone());
    spawn_autocommit_worker(state.clone());

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

fn load_local_env() {
    let Ok(contents) = std::fs::read_to_string(".local.env") else { return; };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let Some((name, value)) = line.split_once('=') else { continue; };
        let name = name.trim();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { continue; }
        if std::env::var_os(name).is_some() { continue; }
        let value = value.trim().trim_matches(|c| c == '\'' || c == '"');
        std::env::set_var(name, value);
    }
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

fn spawn_autocommit_worker(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let state = state.clone();
            match tokio::task::spawn_blocking(move || state.auto_commit_due()).await {
                Ok(Ok(commits)) => {
                    for commit in commits {
                        tracing::info!(commit = %commit.id, summary = %commit.summary, "created semantic auto-save");
                    }
                }
                Ok(Err(err)) => tracing::warn!(error = %err, "semantic auto-save failed"),
                Err(err) => tracing::warn!(error = %err, "semantic auto-save task failed"),
            }
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
