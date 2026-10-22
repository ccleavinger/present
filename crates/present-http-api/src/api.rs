use crate::error::ApiError;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use present_domain::*;
use present_merge as merge;
use present_store::{AppError, AppState};
use serde::Deserialize;
use std::sync::Arc;

const MAX_ASSET_UPLOAD_BYTES: usize = 100 * 1024 * 1024;

type ApiResult<T> = Result<T, ApiError>;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/decks", get(list_decks).post(create_deck))
        .route(
            "/decks/{deck}",
            get(get_deck).patch(update_deck).delete(delete_deck),
        )
        .route("/decks/{deck}/slides", post(create_slide))
        .route(
            "/decks/{deck}/slides/{slide}",
            get(get_slide).put(write_slide).delete(delete_slide),
        )
        .route("/decks/{deck}/slides/{slide}/notes", put(write_notes))
        .route(
            "/decks/{deck}/slides/{slide}/assets",
            get(list_assets).post(upload_asset),
        )
        .route(
            "/decks/{deck}/slides/{slide}/assets/{name}",
            get(read_asset),
        )
        .route("/decks/{deck}/order", put(reorder))
        .route("/decks/{deck}/checkpoint", post(checkpoint))
        .route("/decks/{deck}/commits", get(list_commits))
        .route(
            "/decks/{deck}/branches",
            get(list_branches).post(create_branch),
        )
        .route("/decks/{deck}/checkout", post(checkout))
        .route("/decks/{deck}/merge/preview", get(merge_preview))
        .route("/decks/{deck}/merge/apply", post(merge_apply))
        .route("/decks/{deck}/sessions", post(create_session))
        .route("/sessions/{session}/commit", post(commit_session))
        .route("/sessions/{session}/close", post(close_session))
        .fallback(api_not_found)
        // Leave room for multipart headers while allowing a 100 MiB image file.
        .layer(DefaultBodyLimit::max(105 * 1024 * 1024))
        .with_state(state)
}

fn lock(state: &AppState) -> std::sync::MutexGuard<'_, ()> {
    state.write_lock.lock().unwrap_or_else(|e| e.into_inner())
}

async fn health() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({ "ok": true, "service": "present", "version": env!("CARGO_PKG_VERSION") }),
    )
}

async fn api_not_found() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "API route not found" })),
    )
}

async fn list_decks(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<DeckSummary>>> {
    Ok(Json(state.list_decks()?))
}

async fn create_deck(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateDeckRequest>,
) -> ApiResult<(StatusCode, Json<DeckDetail>)> {
    let _guard = lock(&state);
    Ok((StatusCode::CREATED, Json(state.create_deck(req)?)))
}

async fn get_deck(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
) -> ApiResult<Json<DeckDetail>> {
    Ok(Json(state.deck_detail(&deck)?))
}

async fn delete_deck(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
) -> ApiResult<StatusCode> {
    let _guard = lock(&state);
    state.delete_deck(&deck)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_deck(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Json(req): Json<UpdateDeckRequest>,
) -> ApiResult<Json<DeckDetail>> {
    let _guard = lock(&state);
    Ok(Json(state.update_deck(&deck, req)?))
}

async fn get_slide(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
) -> ApiResult<Json<SlidePayload>> {
    Ok(Json(state.read_slide(&deck, &slide)?))
}

async fn write_slide(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    Json(req): Json<WriteSlideRequest>,
) -> ApiResult<Json<SlidePayload>> {
    let _guard = lock(&state);
    Ok(Json(state.write_slide(&deck, &slide, req)?))
}

async fn write_notes(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    Json(req): Json<WriteNotesRequest>,
) -> ApiResult<Json<SlidePayload>> {
    let _guard = lock(&state);
    Ok(Json(state.write_notes(&deck, &slide, req)?))
}

async fn create_slide(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Json(req): Json<CreateSlideRequest>,
) -> ApiResult<(StatusCode, Json<SlidePayload>)> {
    let _guard = lock(&state);
    Ok((StatusCode::CREATED, Json(state.create_slide(&deck, req)?)))
}

async fn delete_slide(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
) -> ApiResult<Json<DeckDetail>> {
    let _guard = lock(&state);
    Ok(Json(state.delete_slide(&deck, &slide)?))
}

async fn reorder(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Json(req): Json<ReorderRequest>,
) -> ApiResult<Json<DeckDetail>> {
    let _guard = lock(&state);
    Ok(Json(state.reorder_slides(&deck, req)?))
}

async fn checkpoint(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    body: Option<Json<CommitRequest>>,
) -> ApiResult<Json<CommitInfo>> {
    let _guard = lock(&state);
    let message = body.and_then(|b| b.0.message);
    Ok(Json(state.checkpoint(&deck, message)?))
}

async fn list_commits(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
) -> ApiResult<Json<Vec<CommitInfo>>> {
    Ok(Json(state.commits(&deck, 50)?))
}

async fn list_branches(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
) -> ApiResult<Json<Vec<BranchInfo>>> {
    Ok(Json(state.branches(&deck)?))
}

async fn create_branch(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Json(req): Json<CreateBranchRequest>,
) -> ApiResult<(StatusCode, Json<DeckDetail>)> {
    let _guard = lock(&state);
    Ok((StatusCode::CREATED, Json(state.create_branch(&deck, req)?)))
}

async fn checkout(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Json(req): Json<CheckoutRequest>,
) -> ApiResult<Json<DeckDetail>> {
    let _guard = lock(&state);
    Ok(Json(state.checkout(&deck, req)?))
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    body: Option<Json<CreateSessionRequest>>,
) -> ApiResult<(StatusCode, Json<SessionInfo>)> {
    let req = body
        .map(|b| b.0)
        .unwrap_or(CreateSessionRequest { branch: None });
    Ok((StatusCode::CREATED, Json(state.create_session(&deck, req)?)))
}

async fn commit_session(
    State(state): State<Arc<AppState>>,
    Path(session): Path<String>,
    body: Option<Json<CommitRequest>>,
) -> ApiResult<Json<CommitInfo>> {
    let _guard = lock(&state);
    let message = body.and_then(|b| b.0.message);
    Ok(Json(state.commit_session(&session, message)?))
}

async fn close_session(
    State(state): State<Arc<AppState>>,
    Path(session): Path<String>,
) -> ApiResult<StatusCode> {
    let _guard = lock(&state);
    state.close_session(&session)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_assets(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
) -> ApiResult<Json<Vec<AssetInfo>>> {
    Ok(Json(state.list_assets(&deck, &slide)?))
}

async fn upload_asset(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    mut multipart: Multipart,
) -> ApiResult<Json<AssetInfo>> {
    let mut upload = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("invalid upload: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let name = field
            .file_name()
            .map(str::to_owned)
            .unwrap_or_else(|| "asset.bin".into());
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("could not read upload: {e}")))?;
        if bytes.len() > MAX_ASSET_UPLOAD_BYTES {
            return Err(AppError::BadRequest(
                "image files must be 100 MiB or smaller".into(),
            )
            .into());
        }
        upload = Some((name, bytes));
        break;
    }
    let (name, bytes) =
        upload.ok_or_else(|| AppError::BadRequest("expected a 'file' field".into()))?;
    let _guard = lock(&state);
    Ok(Json(state.upload_asset(&deck, &slide, &name, &bytes)?))
}

async fn read_asset(
    State(state): State<Arc<AppState>>,
    Path((deck, slide, name)): Path<(String, String, String)>,
) -> ApiResult<impl axum::response::IntoResponse> {
    let (bytes, mime) = state.read_asset(&deck, &slide, &name)?;
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        bytes,
    ))
}

#[derive(Debug, Deserialize)]
struct MergeQuery {
    source: String,
    #[serde(default)]
    target: Option<String>,
}

async fn merge_preview(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<MergeQuery>,
) -> ApiResult<Json<MergePreview>> {
    Ok(Json(merge::preview_api(
        &state,
        &deck,
        &query.source,
        query.target.as_deref(),
    )?))
}

async fn merge_apply(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Json(req): Json<ApplyMergeRequest>,
) -> ApiResult<Json<CommitInfo>> {
    let _guard = lock(&state);
    Ok(Json(merge::apply(&state, &deck, req)?))
}
