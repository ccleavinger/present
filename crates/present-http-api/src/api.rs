use crate::error::ApiError;
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    DefaultBodyLimit, Extension, Multipart, Path, Query, Request, State,
};
use axum::http::{header, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use hashbrown::HashMap;
use parking_lot::Mutex;
use present_domain::*;
use present_merge as merge;
use present_store::{AppError, AppState};
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use tokio::sync::broadcast;

const MAX_ASSET_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
static PRESENCE_ROOMS: LazyLock<Mutex<HashMap<String, broadcast::Sender<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static ACCOUNT_EVENTS: LazyLock<broadcast::Sender<(String, Option<String>, String)>> =
    LazyLock::new(|| broadcast::channel(256).0);
static NEXT_PRESENCE_CONNECTION: AtomicU64 = AtomicU64::new(1);

type ApiResult<T> = Result<T, ApiError>;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/events", get(account_socket))
        .route("/users", get(list_demo_users).post(create_demo_user))
        .route("/users/sign-in", post(sign_in_demo_user))
        .route("/share/{deck}/{token}", get(share_link_preview))
        .route("/share/{deck}/{token}/join", post(join_share_link))
        .route("/decks", get(list_decks).post(create_deck))
        .route(
            "/templates",
            get(list_template_bundles).post(save_template_bundle),
        )
        .route(
            "/templates/{template}",
            get(get_template_bundle)
                .put(save_template_bundle)
                .delete(delete_template_bundle),
        )
        .route(
            "/decks/{deck}",
            get(get_deck).patch(update_deck).delete(delete_deck),
        )
        .route("/decks/{deck}/slides", post(create_slide))
        .route("/decks/{deck}/agent/script", post(agent_script))
        .route(
            "/decks/{deck}/template-bundle",
            get(get_deck_template_bundle),
        )
        .route(
            "/decks/{deck}/templates/slides",
            get(list_slide_templates).post(save_slide_template),
        )
        .route(
            "/decks/{deck}/templates/slides/{template}",
            axum::routing::delete(delete_slide_template),
        )
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
        .route("/decks/{deck}/history", get(history_page))
        .route("/decks/{deck}/history/{commit}", get(commit_snapshot))
        .route(
            "/decks/{deck}/history/{commit}/restore",
            post(restore_commit),
        )
        .route(
            "/decks/{deck}/branches",
            get(list_branches).post(create_branch).delete(delete_branch),
        )
        .route("/decks/{deck}/checkout", post(checkout))
        .route("/decks/{deck}/merge/preview", get(merge_preview))
        .route("/decks/{deck}/merge/apply", post(merge_apply))
        .route("/decks/{deck}/collaboration", get(get_collaboration))
        .route(
            "/decks/{deck}/collaboration/members",
            post(set_collaborator).delete(remove_collaborator),
        )
        .route(
            "/decks/{deck}/collaboration/links",
            get(list_share_links).post(create_share_link),
        )
        .route(
            "/decks/{deck}/collaboration/links/{link}",
            delete(revoke_share_link),
        )
        .route(
            "/decks/{deck}/comments",
            get(list_comments).post(add_comment),
        )
        .route(
            "/decks/{deck}/comments/{comment}",
            put(update_comment).delete(delete_comment),
        )
        .route("/decks/{deck}/locks", post(update_locks))
        .route("/decks/{deck}/presence", get(collaboration_socket))
        .route("/decks/{deck}/sessions", post(create_session))
        .route("/sessions/{session}/commit", post(commit_session))
        .route("/sessions/{session}/close", post(close_session))
        .fallback(api_not_found)
        // Leave room for multipart headers while allowing a 100 MiB image file.
        .layer(DefaultBodyLimit::max(105 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_demo_user,
        ))
        .with_state(state)
}

async fn require_demo_user(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let path = normalized_api_path(request.uri().path());
    if path == "/health"
        || path == "/users"
        || path == "/users/sign-in"
        || public_share_preview(request.method(), &path)
    {
        return next.run(request).await;
    }
    let query = Query::<HashMap<String, String>>::try_from_uri(request.uri())
        .map(|Query(values)| values)
        .unwrap_or_default();
    let contextual_asset = request.method() == Method::GET
        && path.contains("/assets/")
        && query_value(&query, "branch").is_some_and(|value| !value.is_empty())
        && query_value(&query, "demoUserId").is_some_and(|value| !value.is_empty());
    let contextual_presence = (path.ends_with("/presence") || path == "/events")
        && query_value(&query, "demoUserId").is_some_and(|value| !value.is_empty());
    let user_id = request
        .headers()
        .get("x-present-user")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            (contextual_asset || contextual_presence)
                .then(|| query_value(&query, "demoUserId"))
                .flatten()
        });
    let user_id = match user_id {
        Some(user_id) if !user_id.is_empty() => user_id,
        _ => {
            return ApiError::from(AppError::Unauthorized("select a demo profile".into()))
                .into_response()
        }
    };
    match state.demo_user(user_id) {
        Ok(user) => {
            if let Some((deck_id, branch, session_actor)) = query_value(&query, "sessionId")
                .and_then(|session| state.session_branch(session).ok())
            {
                if session_actor.id != user.id {
                    return ApiError::from(AppError::Forbidden(
                        "editing session belongs to another profile".into(),
                    ))
                    .into_response();
                }
                let required = access_for_request(request.method(), &path);
                if let Err(error) = state.require_deck_role(&deck_id, &user, &branch, required) {
                    return ApiError::from(error).into_response();
                }
            } else if let Some(deck_id) = path
                .strip_prefix("/decks/")
                .and_then(|tail| tail.split('/').next())
                .filter(|id| !id.is_empty())
            {
                let required = access_for_request(request.method(), &path);
                let branch = query_value(&query, "branch")
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        state
                            .preferred_branch(deck_id, &user)
                            .unwrap_or_else(|_| "main".into())
                    });
                if path == format!("/decks/{deck_id}") && request.method() == Method::DELETE {
                    match state.is_deck_owner(deck_id, &user) {
                        Ok(true) => {}
                        Ok(false) => {
                            return ApiError::from(AppError::Forbidden(
                                "only the presentation creator can delete it".into(),
                            ))
                            .into_response()
                        }
                        Err(error) => return ApiError::from(error).into_response(),
                    }
                } else if path.ends_with("/collaboration/members")
                    || path.contains("/collaboration/links")
                {
                    match state.is_deck_owner(deck_id, &user) {
                        Ok(true) => {}
                        Ok(false) => {
                            return ApiError::from(AppError::Forbidden(
                                "only the presentation creator can manage collaborators".into(),
                            ))
                            .into_response()
                        }
                        Err(error) => return ApiError::from(error).into_response(),
                    }
                } else if let Err(error) =
                    state.require_deck_role(deck_id, &user, &branch, required)
                {
                    return ApiError::from(error).into_response();
                }
            }
            let notice = mutation_notice(&state, &request, &query, &user);
            request.extensions_mut().insert(user);
            let response = next.run(request).await;
            if response.status().is_success() {
                if let Some((deck, branch, event)) = notice {
                    if !matches!(event["scope"].as_str(), Some("comments" | "history")) {
                        let _ = account_events().send((
                            deck.clone(),
                            branch.clone(),
                            event["scope"].as_str().unwrap_or("deck").to_owned(),
                        ));
                    }
                    let message = event.to_string();
                    if let Some(branch) = branch {
                        broadcast_presence(&deck, &branch, message);
                    } else {
                        broadcast_deck(&deck, message);
                    }
                }
            }
            response
        }
        Err(error) => ApiError::from(error).into_response(),
    }
}

fn account_events() -> broadcast::Sender<(String, Option<String>, String)> {
    ACCOUNT_EVENTS.clone()
}

async fn account_socket(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Extension(actor): Extension<DemoUser>,
) -> impl IntoResponse {
    ws.max_message_size(1024).on_upgrade(move |mut socket| async move {
        let mut receiver = account_events().subscribe();
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(15));
        let mut last_seen = std::time::Instant::now();
        let refresh = serde_json::json!({"type":"library_changed"}).to_string();
        if socket.send(Message::Text(refresh.clone().into())).await.is_err() { return; }
        loop {
            tokio::select! {
                event = receiver.recv() => {
                    let relevant = match event {
                        Ok((deck, branch, scope)) => {
                            matches!(scope.as_str(),"deleted"|"collaboration") || branch.or_else(||state.preferred_branch(&deck,&actor).ok())
                                .is_some_and(|branch|state.deck_role(&deck,&actor.id,&branch).ok().flatten().is_some())
                        },
                        Err(broadcast::error::RecvError::Lagged(_)) => true,
                        Err(_) => break,
                    };
                    if relevant && socket.send(Message::Text(refresh.clone().into())).await.is_err() { break; }
                },
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Pong(_))) => last_seen = std::time::Instant::now(),
                    Some(Ok(Message::Ping(bytes))) => { if socket.send(Message::Pong(bytes)).await.is_err() {break;} },
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    _ => {},
                },
                _ = ticker.tick() => {
                    if last_seen.elapsed() > std::time::Duration::from_secs(45) { break; }
                    if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
            }
        }
    })
}

fn mutation_notice(
    state: &AppState,
    request: &Request,
    query: &HashMap<String, String>,
    actor: &DemoUser,
) -> Option<(String, Option<String>, serde_json::Value)> {
    let method = request.method();
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return None;
    }
    let path = normalized_api_path(request.uri().path());
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.first() == Some(&"sessions") {
        let session = *parts.get(1)?;
        let (deck, branch, _) = state.session_branch(session).ok()?;
        return Some((
            deck,
            Some(branch),
            serde_json::json!({"type":"invalidate", "scope":"history", "sessionId":session, "userId":actor.id}),
        ));
    }
    if parts.first() != Some(&"decks") || path.ends_with("/locks") || path.ends_with("/sessions") {
        return None;
    }
    let deck = parts.get(1)?.to_string();
    let mut slide = None;
    let scope = match parts.get(2).copied() {
        Some("comments") => "comments",
        Some("collaboration") => "collaboration",
        Some("checkpoint") => "history",
        Some("slides")
            if parts.len() > 3 && (*method == Method::PUT || parts.get(4) == Some(&"assets")) =>
        {
            slide = parts.get(3).copied();
            "content"
        }
        None if *method == Method::DELETE => "deleted",
        _ => "deck",
    };
    let branch = query_value(query, "sessionId")
        .and_then(|session| {
            state
                .session_branch(session)
                .ok()
                .map(|(_, branch, _)| branch)
        })
        .or_else(|| query.get("branch").cloned())
        .or_else(|| state.preferred_branch(&deck, actor).ok());
    let branch =
        if scope == "collaboration" || scope == "deleted" || parts.get(2) == Some(&"branches") {
            None
        } else {
            branch
        };
    let event = serde_json::json!({"type":"invalidate", "scope":scope, "slideId":slide, "sessionId":query_value(query,"sessionId"), "userId":actor.id});
    Some((deck, branch, event))
}

fn broadcast_deck(deck: &str, message: String) {
    for (room, sender) in PRESENCE_ROOMS.lock().iter() {
        if room.starts_with(&format!("{deck}:")) {
            let _ = sender.send(message.clone());
        }
    }
}

fn access_for_request(method: &Method, path: &str) -> DeckRole {
    if (path.ends_with("/comments") && *method == Method::POST)
        || (path.contains("/comments/") && (*method == Method::PUT || *method == Method::DELETE))
    {
        return DeckRole::Comment;
    }
    if path.ends_with("/sessions") {
        return DeckRole::View;
    }
    if *method == Method::GET || *method == Method::HEAD {
        DeckRole::View
    } else {
        DeckRole::Edit
    }
}

fn normalized_api_path(path: &str) -> &str {
    path.strip_prefix("/api").unwrap_or(path)
}

fn public_share_preview(method: &Method, path: &str) -> bool {
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    matches!(*method, Method::GET | Method::HEAD) && parts.len() == 3 && parts[0] == "share"
}

fn query_value<'a>(query: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    query.get(key).map(String::as_str)
}

#[cfg(test)]
mod identity_path_tests {
    use hashbrown::HashMap;

    use super::{normalized_api_path, query_value};

    #[test]
    fn identity_exemptions_match_nested_and_direct_api_paths() {
        assert_eq!(normalized_api_path("/api/users"), "/users");
        assert_eq!(normalized_api_path("/users"), "/users");
        assert_eq!(
            normalized_api_path("/api/sessions/ses_1/close"),
            "/sessions/ses_1/close"
        );
    }

    #[test]
    fn image_urls_carry_profile_and_branch_context() {
        let path = normalized_api_path("/api/decks/deck/slides/slide/assets/photo.png");
        assert!(path.contains("/assets/"));
        let uri = "/?branch=feature%2Fslides&demoUserId=usr_123"
            .parse()
            .unwrap();
        let axum::extract::Query(query) =
            axum::extract::Query::<HashMap<String, String>>::try_from_uri(&uri).unwrap();
        assert_eq!(query_value(&query, "branch"), Some("feature/slides"));
        assert_eq!(query_value(&query, "demoUserId"), Some("usr_123"));
        assert!(query_value(&query, "sessionId").is_none());
    }
}

#[cfg(test)]
mod demo_identity_api_tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn share_link_join_is_authenticated_scoped_and_revocable() {
        fn request(
            method: Method,
            path: &str,
            user: Option<&str>,
            body: serde_json::Value,
        ) -> Request<Body> {
            let mut builder = Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json");
            if let Some(user) = user {
                builder = builder.header("X-Present-User", user);
            }
            builder.body(Body::from(body.to_string())).unwrap()
        }
        let root = std::env::temp_dir().join(format!(
            "present-share-api-{}",
            NEXT_PRESENCE_CONNECTION.fetch_add(1, Ordering::Relaxed)
        ));
        let state = Arc::new(AppState::new(root.join("decks")));
        let owner = state.create_demo_user("link_owner").unwrap();
        let recipient = state.create_demo_user("link_recipient").unwrap();
        let detail = state
            .create_deck_as(
                serde_json::from_value(
                    serde_json::json!({"id":"shared-link", "title":"Shared by link"}),
                )
                .unwrap(),
                &owner,
            )
            .unwrap();
        state
            .create_branch(
                "shared-link",
                CreateBranchRequest {
                    name: "feature/shared".into(),
                    from: Some("main".into()),
                    checkout: false,
                    session_id: None,
                },
                &owner,
            )
            .unwrap();
        let app = Router::new().nest("/api", router(state.clone()));
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/decks/shared-link/collaboration/links",
                Some(&owner.id),
                serde_json::json!({"branch":"feature/shared","role":"view"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let link: ShareLink =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let url = format!("/api/share/shared-link/{}", link.token);
        let response = app
            .clone()
            .oneshot(request(Method::GET, &url, None, serde_json::json!({})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let preview: ShareLinkPreview =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(preview.title, "Shared by link");
        assert_eq!(preview.branch, "feature/shared");
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::POST,
                    &format!("{url}/join"),
                    None,
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::GET,
                    "/api/decks/shared-link?branch=feature%2Fshared",
                    Some(&recipient.id),
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::POST,
                    &format!("{url}/join"),
                    Some(&recipient.id),
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::GET,
                    "/api/decks/shared-link?branch=feature%2Fshared",
                    Some(&recipient.id),
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::GET,
                    "/api/decks/shared-link?branch=main",
                    Some(&recipient.id),
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/decks/shared-link/sessions",
                Some(&recipient.id),
                serde_json::json!({"branch":"feature/shared"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let session: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let slide_url = format!(
            "/api/decks/shared-link/slides/{}?sessionId={}",
            detail.slides[0].id,
            session["id"].as_str().unwrap()
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::PUT,
                    &slide_url,
                    Some(&recipient.id),
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::GET,
                    "/api/decks/shared-link/collaboration/links",
                    Some(&recipient.id),
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let revoke = format!("/api/decks/shared-link/collaboration/links/{}", link.id);
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::DELETE,
                    &revoke,
                    Some(&recipient.id),
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    Method::DELETE,
                    &revoke,
                    Some(&owner.id),
                    serde_json::json!({})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            app.clone()
                .oneshot(request(Method::GET, &url, None, serde_json::json!({})))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            app.oneshot(request(
                Method::GET,
                &slide_url,
                Some(&recipient.id),
                serde_json::json!({})
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::FORBIDDEN
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn shared_branch_sessions_choose_an_authorized_branch() {
        let root = std::env::temp_dir().join(format!(
            "present-shared-session-{}",
            NEXT_PRESENCE_CONNECTION.fetch_add(1, Ordering::Relaxed)
        ));
        let state = Arc::new(AppState::new(root.join("decks")));
        let owner = state.create_demo_user("owner").unwrap();
        let member = state.create_demo_user("member").unwrap();
        state
            .create_deck_as(
                serde_json::from_value(serde_json::json!({"id":"shared","title":"Shared"}))
                    .unwrap(),
                &owner,
            )
            .unwrap();
        state
            .create_branch(
                "shared",
                CreateBranchRequest {
                    name: "feature/slides".into(),
                    from: Some("main".into()),
                    checkout: false,
                    session_id: None,
                },
                &owner,
            )
            .unwrap();
        state
            .set_deck_member(
                "shared",
                &owner,
                SetDeckMemberRequest {
                    username: member.username.clone(),
                    branch: "feature/slides".into(),
                    role: DeckRole::View,
                },
            )
            .unwrap();
        let app = Router::new().nest("/api", router(state));
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/decks/shared/sessions")
                    .header("content-type", "application/json")
                    .header("X-Present-User", &member.id)
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["branch"], "feature/slides");
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/decks/shared/sessions")
                    .header("content-type", "application/json")
                    .header("X-Present-User", &member.id)
                    .body(Body::from(r#"{"branch":"main"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn demo_profiles_are_public_but_deck_routes_require_a_known_profile() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("present-api-users-{nonce}"));
        let state = Arc::new(AppState::new(root.join("decks")));
        let app = Router::new().nest("/api", router(state.clone()));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/users")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/decks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let request = Request::builder()
            .method("POST")
            .uri("/api/users")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"displayName":"Riley"}"#))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let user: DemoUser = serde_json::from_slice(&bytes).unwrap();

        let request = Request::builder()
            .uri("/api/decks")
            .header("X-Present-User", &user.id)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        state
            .create_deck_as(
                CreateDeckRequest {
                    title: "Asset test".into(),
                    id: Some("asset-test".into()),
                    template_id: Some("blank".into()),
                    template_bundle: None,
                },
                &user,
            )
            .unwrap();
        state
            .upload_asset(
                "asset-test",
                "s_01_blank",
                "cover.png",
                b"image bytes",
                None,
                &user,
            )
            .unwrap();
        let request = Request::builder()
            .uri(format!("/api/decks/asset-test/slides/s_01_blank/assets/cover.png?branch=main&demoUserId={}", user.id))
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let request = Request::builder()
            .uri("/api/decks")
            .header("X-Present-User", "usr_unknown")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn lock(state: &AppState) -> parking_lot::MutexGuard<'_, ()> {
    state.write_lock.lock()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchQuery {
    branch: Option<String>,
}

async fn get_collaboration(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<DeckCollaboration>> {
    Ok(Json(state.deck_collaboration(&deck, &actor)?))
}

async fn list_share_links(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<Vec<ShareLink>>> {
    Ok(Json(state.share_links(&deck, &actor)?))
}

async fn create_share_link(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(request): Json<CreateShareLinkRequest>,
) -> ApiResult<(StatusCode, Json<ShareLink>)> {
    let _guard = lock(&state);
    Ok((
        StatusCode::CREATED,
        Json(state.create_share_link(&deck, &actor, request)?),
    ))
}

async fn revoke_share_link(
    State(state): State<Arc<AppState>>,
    Path((deck, link)): Path<(String, String)>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<StatusCode> {
    let _guard = lock(&state);
    state.revoke_share_link(&deck, &actor, &link)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn share_link_preview(
    State(state): State<Arc<AppState>>,
    Path((deck, token)): Path<(String, String)>,
) -> ApiResult<Json<ShareLinkPreview>> {
    Ok(Json(state.share_link_preview(&deck, &token)?))
}

async fn join_share_link(
    State(state): State<Arc<AppState>>,
    Path((deck, token)): Path<(String, String)>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<ShareLinkPreview>> {
    let result = {
        let _guard = lock(&state);
        state.join_share_link(&deck, &token, &actor)?
    };
    broadcast_deck(
        &deck,
        serde_json::json!({"type":"invalidate", "scope":"collaboration", "userId":actor.id})
            .to_string(),
    );
    let _ = account_events().send((deck, None, "collaboration".into()));
    Ok(Json(result))
}

async fn set_collaborator(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(request): Json<SetDeckMemberRequest>,
) -> ApiResult<Json<DeckCollaboration>> {
    let _guard = lock(&state);
    Ok(Json(state.set_deck_member(&deck, &actor, request)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveMemberQuery {
    username: String,
    branch: String,
}

async fn remove_collaborator(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Query(query): Query<RemoveMemberQuery>,
) -> ApiResult<Json<DeckCollaboration>> {
    let _guard = lock(&state);
    Ok(Json(state.remove_deck_member(
        &deck,
        &actor,
        &query.username,
        &query.branch,
    )?))
}

async fn list_comments(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<BranchQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<Vec<ObjectComment>>> {
    Ok(Json(state.comments(
        &deck,
        query.branch.as_deref().unwrap_or("main"),
        &actor,
    )?))
}

async fn add_comment(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<BranchQuery>,
    Extension(actor): Extension<DemoUser>,
    Json(request): Json<CreateObjectCommentRequest>,
) -> ApiResult<(StatusCode, Json<ObjectComment>)> {
    let _guard = lock(&state);
    let branch = query.branch.as_deref().unwrap_or("main");
    Ok((
        StatusCode::CREATED,
        Json(state.add_comment(&deck, branch, &actor, request)?),
    ))
}

async fn update_comment(
    State(state): State<Arc<AppState>>,
    Path((deck, comment)): Path<(String, String)>,
    Query(query): Query<BranchQuery>,
    Extension(actor): Extension<DemoUser>,
    Json(request): Json<UpdateObjectCommentRequest>,
) -> ApiResult<Json<ObjectComment>> {
    let _guard = lock(&state);
    Ok(Json(state.update_comment(
        &deck,
        query.branch.as_deref().unwrap_or("main"),
        &actor,
        &comment,
        &request.message,
    )?))
}

async fn delete_comment(
    State(state): State<Arc<AppState>>,
    Path((deck, comment)): Path<(String, String)>,
    Query(query): Query<BranchQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<StatusCode> {
    let _guard = lock(&state);
    state.delete_comment(
        &deck,
        query.branch.as_deref().unwrap_or("main"),
        &actor,
        &comment,
    )?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockRequest {
    branch: String,
    session_id: Option<String>,
    object_ids: Vec<String>,
    #[serde(default)]
    release: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LockResponse {
    acquired: Vec<String>,
}

async fn update_locks(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(request): Json<LockRequest>,
) -> ApiResult<Json<LockResponse>> {
    let event_object_ids = request.object_ids.clone();
    let acquired = if request.release {
        state.release_session_locks(
            &deck,
            &request.branch,
            &actor,
            request.session_id.as_deref(),
            &request.object_ids,
        );
        Vec::new()
    } else {
        state.acquire_session_locks(
            &deck,
            &request.branch,
            &actor,
            request.session_id.as_deref(),
            &request.object_ids,
        )?
    };
    let object_ids = if request.release {
        event_object_ids
    } else {
        acquired.clone()
    };
    let event = serde_json::json!({ "type": if request.release { "unlock" } else { "lock" }, "user": actor, "branch": request.branch, "objectIds": object_ids, "sessionId": request.session_id });
    broadcast_presence(&deck, &request.branch, event.to_string());
    Ok(Json(LockResponse { acquired }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresenceQuery {
    branch: String,
    session_id: Option<String>,
    slide_id: Option<String>,
}

async fn collaboration_socket(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<PresenceQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<impl axum::response::IntoResponse> {
    let _ = state.require_deck_role(&deck, &actor, &query.branch, DeckRole::View)?;
    if let Some(session) = query.session_id.as_deref() {
        state.validate_session_actor(&deck, Some(session), &actor)?;
        if state.session_branch(session)?.1 != query.branch {
            return Err(AppError::BadRequest("session belongs to another branch".into()).into());
        }
    }
    let (sender, _) = presence_sender(&deck, &query.branch);
    Ok(ws
        .max_message_size(262_144)
        .max_frame_size(262_144)
        .on_upgrade(move |socket| {
            handle_presence_socket(
                socket,
                sender,
                state,
                deck,
                query.branch,
                query.slide_id,
                query.session_id,
                actor,
            )
        }))
}

fn presence_sender(deck: &str, branch: &str) -> (broadcast::Sender<String>, bool) {
    let key = format!("{deck}:{branch}");
    let mut rooms = PRESENCE_ROOMS.lock();
    if let Some(sender) = rooms.get(&key) {
        return (sender.clone(), false);
    }
    let (sender, _) = broadcast::channel(128);
    rooms.insert(key, sender.clone());
    (sender, true)
}

fn broadcast_presence(deck: &str, branch: &str, message: String) {
    if let Some(sender) = PRESENCE_ROOMS.lock().get(&format!("{deck}:{branch}")) {
        let _ = sender.send(message);
    }
}

fn lock_snapshot(state: &AppState, deck: &str, branch: &str) -> serde_json::Value {
    let locks: Vec<_> = state.active_object_locks(deck, branch).into_iter()
        .map(|(user, object_id, session)| serde_json::json!({"user":user,"objectId":object_id,"sessionId":session})).collect();
    serde_json::json!({"type":"locks_snapshot","locks":locks})
}

async fn handle_presence_socket(
    mut socket: WebSocket,
    sender: broadcast::Sender<String>,
    state: Arc<AppState>,
    deck: String,
    branch: String,
    mut slide_id: Option<String>,
    session_id: Option<String>,
    actor: DemoUser,
) {
    let mut receiver = sender.subscribe();
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
    let connection_id = format!(
        "{}:{}",
        actor.id,
        NEXT_PRESENCE_CONNECTION.fetch_add(1, Ordering::Relaxed)
    );
    let mut awareness = serde_json::json!({"type":"presence","user":actor,"slideId":slide_id,"connectionId":connection_id,"sessionId":session_id,"objectIds":[]});
    let snapshots = state.live_presence_snapshot(&deck, &branch, &connection_id);
    state.set_live_presence(&deck, &branch, &actor, &connection_id, awareness.clone());
    let ready = serde_json::json!({"type":"ready","connectionId":connection_id,"sessionId":session_id,"users":snapshots,"locks":lock_snapshot(&state,&deck,&branch)["locks"]});
    if socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .is_err()
    {
        state.remove_live_presence(&deck, &branch, &actor, &connection_id);
        return;
    }
    let _ = sender.send(awareness.to_string());
    let mut last_head = state.branch_tip(&deck, &branch).ok();
    let mut last_seen = std::time::Instant::now();
    let mut last_cursor = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut last_preview = last_cursor;
    let mut can_edit = state
        .require_deck_role(&deck, &actor, &branch, DeckRole::Edit)
        .is_ok();
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if last_seen.elapsed() > std::time::Duration::from_secs(20) || state.require_deck_role(&deck,&actor,&branch,DeckRole::View).is_err() { break; }
                if let Some(session) = session_id.as_deref() {
                    if state.validate_session_actor(&deck,Some(session),&actor).is_err() { break; }
                }
                let head = state.branch_tip(&deck,&branch).ok();
                if head != last_head {
                    last_head = head;
                    if socket.send(Message::Text(serde_json::json!({"type":"invalidate","scope":"history"}).to_string().into())).await.is_err() { break; }
                }
                can_edit = state.require_deck_role(&deck,&actor,&branch,DeckRole::Edit).is_ok();
                if !can_edit {
                    let released = state.release_user_object_locks(&deck,&branch,&actor);
                    if !released.is_empty() { let _ = sender.send(serde_json::json!({"type":"unlock","userId":actor.id,"objectIds":released}).to_string()); }
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                if socket.send(Message::Text(lock_snapshot(&state,&deck,&branch).to_string().into())).await.is_err() { break; }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    last_seen = std::time::Instant::now();
                    let value: serde_json::Value = match serde_json::from_str(text.as_str()) { Ok(value) => value, Err(_) => continue };
                    match value["type"].as_str() {
                        Some("presence") => {
                            let next_slide = value["slideId"].as_str().filter(|id| present_store::jsonutil::valid_id(id)).map(str::to_owned);
                            if next_slide != slide_id { awareness["x"] = serde_json::Value::Null; awareness["y"] = serde_json::Value::Null; }
                            slide_id = next_slide;
                            awareness["slideId"] = serde_json::json!(slide_id);
                            awareness["objectIds"] = serde_json::json!(value["objectIds"].as_array().map(|ids| ids.iter().filter_map(|id|id.as_str()).take(64).collect::<Vec<_>>()).unwrap_or_default());
                            state.set_live_presence(&deck,&branch,&actor,&connection_id,awareness.clone());
                            let _ = sender.send(awareness.to_string());
                        },
                        Some("cursor") if last_cursor.elapsed() >= std::time::Duration::from_millis(30) => {
                            let (x,y) = (value["x"].as_f64(),value["y"].as_f64());
                            if let (Some(x),Some(y)) = (x,y) { if !x.is_finite() || !y.is_finite() || x.abs()>100_000.0 || y.abs()>100_000.0 { continue; } }
                            awareness["x"] = serde_json::json!(x); awareness["y"] = serde_json::json!(y);
                            last_cursor = std::time::Instant::now();
                            state.set_live_presence(&deck,&branch,&actor,&connection_id,awareness.clone());
                            let _ = sender.send(awareness.to_string());
                        },
                        Some("preview") if can_edit && last_preview.elapsed() >= std::time::Duration::from_millis(50) => {
                            let Some(slide) = value["slideId"].as_str().filter(|id| present_store::jsonutil::valid_id(id)) else {continue;};
                            let Some(elements) = value["elements"].as_object().filter(|map| !map.is_empty() && map.len()<=64) else {continue;};
                            let ids: Vec<_> = elements.keys().cloned().collect();
                            if !state.owns_object_locks(&deck,&branch,&actor,session_id.as_deref(),&ids) { continue; }
                            if elements.iter().any(|(id,element)| !present_store::jsonutil::valid_id(id) || (!element.is_null() && serde_json::from_value::<Element>(element.clone()).map_or(true, |element| element.id != *id))) {continue;}
                            last_preview = std::time::Instant::now();
                            let _ = sender.send(serde_json::json!({"type":"preview","slideId":slide,"elements":elements,"user":actor,"sessionId":session_id,"connectionId":connection_id}).to_string());
                        },
                        _ => {}
                    }
                },
                Some(Ok(Message::Pong(_))) => last_seen = std::time::Instant::now(),
                Some(Ok(Message::Ping(bytes))) => { if socket.send(Message::Pong(bytes)).await.is_err(){break;} },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            outgoing = receiver.recv() => match outgoing {
                Ok(message) => {
                    // Preview state is only useful to collaborators looking at that slide.
                    // Keep awareness and durable invalidations branch-wide, but avoid sending
                    // every drag update to clients that cannot display it.
                    let is_other_slide_preview = serde_json::from_str::<serde_json::Value>(&message)
                        .ok()
                        .filter(|event| event["type"] == "preview")
                        .is_some_and(|event| event["slideId"].as_str() != slide_id.as_deref());
                    if !is_other_slide_preview && socket.send(Message::Text(message.into())).await.is_err() { break; }
                },
                Err(broadcast::error::RecvError::Lagged(_)) => if socket.send(Message::Text(serde_json::json!({"type":"resync"}).to_string().into())).await.is_err() {break;},
                Err(_) => break,
            }
        }
    }
    // A network reconnect must not revoke an HTTP save's leases. They expire
    // after 15 seconds unless the owning editing session renews/releases them.
    if state.remove_live_presence(&deck, &branch, &actor, &connection_id) {
        let _ = sender.send(serde_json::json!({"type":"leave","userId":actor.id,"connectionId":connection_id,"sessionId":session_id}).to_string());
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({ "ok": true, "service": "present", "version": env!("CARGO_PKG_VERSION") }),
    )
}

async fn list_demo_users(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<DemoUser>>> {
    Ok(Json(state.demo_users()?))
}

async fn create_demo_user(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateDemoUserRequest>,
) -> ApiResult<(StatusCode, Json<DemoUser>)> {
    let _guard = lock(&state);
    let username = if request.username.trim().is_empty() {
        request.display_name.as_str()
    } else {
        request.username.as_str()
    };
    Ok((StatusCode::CREATED, Json(state.create_demo_user(username)?)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignInRequest {
    username: String,
}

async fn sign_in_demo_user(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SignInRequest>,
) -> ApiResult<Json<DemoUser>> {
    Ok(Json(state.sign_in_demo_user(&request.username)?))
}

async fn api_not_found() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "API route not found" })),
    )
}

async fn list_decks(
    State(state): State<Arc<AppState>>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<Vec<DeckSummary>>> {
    Ok(Json(state.list_decks_for_user(&actor)?))
}

fn filter_detail_for_user(
    state: &AppState,
    actor: &DemoUser,
    mut detail: DeckDetail,
) -> ApiResult<DeckDetail> {
    detail.branches = state.branches_for_user(&detail.id, actor)?;
    Ok(detail)
}

async fn list_template_bundles(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<TemplateBundleSummary>>> {
    Ok(Json(state.template_bundles()?))
}

async fn get_template_bundle(
    State(state): State<Arc<AppState>>,
    Path(template): Path<String>,
) -> ApiResult<Json<TemplateBundle>> {
    Ok(Json(state.template_bundle(&template)?))
}

async fn save_template_bundle(
    State(state): State<Arc<AppState>>,
    path: Option<Path<String>>,
    Json(mut bundle): Json<TemplateBundle>,
) -> ApiResult<(StatusCode, Json<TemplateBundleSummary>)> {
    let _guard = lock(&state);
    if let Some(Path(id)) = path {
        bundle.id = id;
    }
    let saved = state.save_template_bundle(bundle)?;
    Ok((StatusCode::OK, Json(TemplateBundleSummary::from(&saved))))
}

async fn delete_template_bundle(
    State(state): State<Arc<AppState>>,
    Path(template): Path<String>,
) -> ApiResult<StatusCode> {
    let _guard = lock(&state);
    state.delete_template_bundle(&template)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_deck_template_bundle(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<SessionQuery>,
) -> ApiResult<Json<Option<TemplateBundle>>> {
    Ok(Json(state.deck_template_bundle(
        &deck,
        query.session_id.as_deref(),
    )?))
}

async fn create_deck(
    State(state): State<Arc<AppState>>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<CreateDeckRequest>,
) -> ApiResult<(StatusCode, Json<DeckDetail>)> {
    let _guard = lock(&state);
    Ok((
        StatusCode::CREATED,
        Json({
            let detail =
                filter_detail_for_user(&state, &actor, state.create_deck_as(req, &actor)?)?;
            let _ = account_events().send((
                detail.id.clone(),
                Some(detail.current_branch.clone()),
                "deck".into(),
            ));
            detail
        }),
    ))
}

async fn get_deck(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<BranchSessionQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<DeckDetail>> {
    let detail = match query.session_id {
        Some(session) => state.session_deck_detail(&deck, &session)?,
        None => match query.branch {
            Some(branch) => state.deck_detail_for_branch(&deck, &branch)?,
            None => state.deck_detail_for_user(&deck, &actor)?,
        },
    };
    Ok(Json(filter_detail_for_user(&state, &actor, detail)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentScriptRequest {
    request: String,
    #[serde(default)]
    feedback: String,
    #[serde(default)]
    slides: Vec<serde_json::Value>,
    deck_title: String,
}

fn agent_settings(
    get: impl Fn(&str) -> Option<String>,
) -> Result<(reqwest::Url, String), AppError> {
    let required = |name: &str| {
        get(name)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::Internal(format!(
                    "Agent is not configured. Set {name} in .local.env."
                ))
            })
    };
    let url = required("OPENAI_URL")?;
    let model = required("OPENAI_MODEL")?;
    let mut endpoint = reqwest::Url::parse(&url)
        .map_err(|_| AppError::Internal("OPENAI_URL must be a valid HTTP or HTTPS URL.".into()))?;
    if !matches!(endpoint.scheme(), "http" | "https") {
        return Err(AppError::Internal(
            "OPENAI_URL must be a valid HTTP or HTTPS URL.".into(),
        ));
    }
    let path = endpoint.path().trim_end_matches('/');
    let path = if path.ends_with("/chat/completions") {
        path.to_owned()
    } else {
        format!("{path}/chat/completions")
    };
    endpoint.set_path(&path);
    Ok((endpoint, model))
}

#[cfg(test)]
mod agent_configuration_tests {
    use super::*;

    #[test]
    fn provider_url_and_model_come_from_the_requested_environment_keys() {
        let (endpoint, model) = agent_settings(|name| match name {
            "OPENAI_URL" => Some("https://provider.example/gateway/v1/?tenant=demo".into()),
            "OPENAI_MODEL" => Some(" custom-provider/model ".into()),
            "OPENAI_BASE_URL" => Some("https://unused.example/v1".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(
            endpoint.as_str(),
            "https://provider.example/gateway/v1/chat/completions?tenant=demo"
        );
        assert_eq!(model, "custom-provider/model");
    }

    #[test]
    fn full_chat_endpoint_is_not_appended_twice() {
        let (endpoint, _) = agent_settings(|name| {
            Some(
                match name {
                    "OPENAI_URL" => "http://localhost:8080/v1/chat/completions/?version=1",
                    _ => "local-model",
                }
                .into(),
            )
        })
        .unwrap();
        assert_eq!(
            endpoint.as_str(),
            "http://localhost:8080/v1/chat/completions?version=1"
        );
    }

    #[test]
    fn missing_url_or_model_does_not_silently_choose_a_provider() {
        let error =
            agent_settings(|name| (name != "OPENAI_URL").then(|| "configured".into())).unwrap_err();
        assert!(error.to_string().contains("OPENAI_URL"));
        let error = agent_settings(|name| {
            (name == "OPENAI_URL").then(|| "https://provider.example/v1".into())
        })
        .unwrap_err();
        assert!(error.to_string().contains("OPENAI_MODEL"));
    }

    #[test]
    fn non_http_urls_are_rejected_before_sending_provider_requests() {
        let error = agent_settings(|name| {
            Some(
                if name == "OPENAI_URL" {
                    "file:///tmp/provider"
                } else {
                    "model"
                }
                .into(),
            )
        })
        .unwrap_err();
        assert!(error.to_string().contains("OPENAI_URL"));
    }
}

async fn agent_script(
    Path(_deck): Path<String>,
    Json(input): Json<AgentScriptRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if input.request.trim().is_empty() || input.request.len() > 8_000 {
        return Err(AppError::BadRequest("Describe a task in 1–8,000 characters.".into()).into());
    }
    if input.feedback.len() > 32_000 || input.slides.len() > 30 {
        return Err(
            AppError::BadRequest("Agent context exceeds the configured limits.".into()).into(),
        );
    }
    let slide_text = serde_json::to_string(&input.slides).unwrap_or_default();
    if slide_text.len() > 80_000 {
        return Err(AppError::BadRequest(
            "The deck context is too large to send to the agent.".into(),
        )
        .into());
    }
    let (endpoint, model) = agent_settings(|name| std::env::var(name).ok())?;
    let key = std::env::var("OPENAI_KEY")
        .or_else(|_| std::env::var("OPENAI_API_KEY"))
        .map_err(|_| {
            AppError::Internal("Agent is not configured. Set OPENAI_KEY in .local.env.".into())
        })?;
    let system = "You create presentation slides as JavaScript for Present's restricted template scripting API. Return only executable JavaScript source, with no markdown fences. The program must return {initialSlides, slideOptions, customObjectTypes}; initialSlides should contain the proposed new slides and slideOptions must be an empty array. Use api.createSlide(name, background) and api.addElement(slide, element). Use only text, rect, ellipse, triangle, diamond, star, arrow, callout, line, and image slide elements. Coordinates use a 1920x1080 canvas. Keep the result visually coherent, concise, and editable. Do not use imports, network, filesystem, DOM, or browser APIs. Use deterministic IDs. The worker will execute and validate the script in an isolated worker.";
    let user = format!(
        "Deck: {}\nTask: {}\nFeedback for this revision: {}\nCurrent deck slide JSON: {}",
        input.deck_title,
        input.request.trim(),
        if input.feedback.trim().is_empty() {
            "(none)"
        } else {
            input.feedback.trim()
        },
        slide_text,
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(75))
        .build()
        .map_err(|_| AppError::Internal("Could not initialize the agent client.".into()))?;
    let response = client
        .post(endpoint)
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": model,
            "max_completion_tokens": 12000,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        }))
        .send()
        .await
        .map_err(|error| AppError::Internal(format!("Agent request failed: {error}")))?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| AppError::Internal("Agent returned an unreadable response.".into()))?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("The configured model rejected the request.");
        return Err(AppError::Internal(format!("Agent service error: {message}")).into());
    }
    let script = body
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::Internal("Agent response did not include a script.".into()))?
        .trim()
        .trim_start_matches("```javascript")
        .trim_start_matches("```js")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if script.is_empty() || script.len() > 80_000 {
        return Err(
            AppError::Internal("Agent returned an empty or oversized script.".into()).into(),
        );
    }
    Ok(Json(
        serde_json::json!({ "script": script, "model": model }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchSessionQuery {
    session_id: Option<String>,
    branch: Option<String>,
}

async fn delete_deck(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<StatusCode> {
    let _guard = lock(&state);
    state.delete_deck_as(&deck, &actor)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_deck(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<UpdateDeckRequest>,
) -> ApiResult<Json<DeckDetail>> {
    let _guard = lock(&state);
    Ok(Json(filter_detail_for_user(
        &state,
        &actor,
        state.update_deck(&deck, req, &actor)?,
    )?))
}

async fn get_slide(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    Query(query): Query<SlideReadQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<SlidePayload>> {
    tokio::task::spawn_blocking(move || -> present_store::AppResult<SlidePayload> {
        match (query.session_id, query.branch) {
            (Some(session), _) => state.read_slide_for_session(&deck, &slide, &session),
            (None, Some(branch)) => state.read_slide_for_branch(&deck, &slide, &branch, &actor),
            _ => {
                let branch = state.preferred_branch(&deck, &actor)?;
                state.read_slide_for_branch(&deck, &slide, &branch, &actor)
            }
        }
    })
    .await
    .map_err(|error| {
        ApiError::from(AppError::Internal(format!(
            "slide read task failed: {error}"
        )))
    })?
    .map(Json)
    .map_err(ApiError::from)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlideReadQuery {
    session_id: Option<String>,
    branch: Option<String>,
}

// Keep filesystem work and mutex waits off Tokio's async request threads.
async fn store_write<T: Send + 'static>(
    state: Arc<AppState>,
    operation: &'static str,
    action: impl FnOnce(&AppState) -> present_store::AppResult<T> + Send + 'static,
) -> ApiResult<T> {
    tokio::task::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let guard = state.write_lock.lock();
        let waited = started.elapsed();
        let result = action(&state);
        drop(guard);
        if started.elapsed() >= std::time::Duration::from_secs(1) {
            tracing::warn!(
                operation,
                wait_ms = waited.as_millis() as u64,
                total_ms = started.elapsed().as_millis() as u64,
                "slow store operation"
            );
        }
        if let Err(error) = &result {
            tracing::warn!(operation, error = %error, "store operation failed");
        }
        result.map_err(ApiError::from)
    })
    .await
    .map_err(|error| ApiError::from(AppError::Internal(format!("store task failed: {error}"))))?
}

async fn write_slide(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<WriteSlideRequest>,
) -> ApiResult<Json<SlidePayload>> {
    store_write(state, "write_slide", move |state| {
        let req = state.rebase_slide_write(&deck, &slide, req)?;
        state.assert_slide_locks(&deck, &slide, req.session_id.as_deref(), &actor, &req.slide)?;
        state.write_slide(&deck, &slide, req, &actor)
    })
    .await
    .map(Json)
}

async fn write_notes(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<WriteNotesRequest>,
) -> ApiResult<Json<SlidePayload>> {
    store_write(state, "write_notes", move |state| {
        state.write_notes(&deck, &slide, req, &actor)
    })
    .await
    .map(Json)
}

async fn create_slide(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<CreateSlideRequest>,
) -> ApiResult<(StatusCode, Json<SlidePayload>)> {
    let _guard = lock(&state);
    Ok((
        StatusCode::CREATED,
        Json(state.create_slide(&deck, req, &actor)?),
    ))
}

async fn list_slide_templates(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<SessionQuery>,
) -> ApiResult<Json<Vec<SlideTemplate>>> {
    Ok(Json(
        state.slide_templates(&deck, query.session_id.as_deref())?,
    ))
}

async fn save_slide_template(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<SessionQuery>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<SaveSlideTemplateRequest>,
) -> ApiResult<(StatusCode, Json<SlideTemplate>)> {
    let _guard = lock(&state);
    Ok((
        StatusCode::CREATED,
        Json(state.save_slide_template(&deck, req, query.session_id.as_deref(), &actor)?),
    ))
}

async fn delete_slide_template(
    State(state): State<Arc<AppState>>,
    Path((deck, template)): Path<(String, String)>,
    Query(query): Query<SessionQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<StatusCode> {
    let _guard = lock(&state);
    state.delete_slide_template(&deck, &template, query.session_id.as_deref(), &actor)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_slide(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    Query(query): Query<SessionQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<DeckDetail>> {
    let _guard = lock(&state);
    let branch = state.asset_branch(&deck, query.session_id.as_deref())?;
    let current = state
        .read_slide_for_branch(&deck, &slide, &branch, &actor)?
        .slide;
    state.ensure_no_foreign_locks(
        &deck,
        &branch,
        &actor,
        query.session_id.as_deref(),
        Some(&current),
    )?;
    let detail = state.delete_slide(&deck, &slide, query.session_id.as_deref(), &actor)?;
    Ok(Json(filter_detail_for_user(&state, &actor, detail)?))
}

async fn reorder(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<ReorderRequest>,
) -> ApiResult<Json<DeckDetail>> {
    let _guard = lock(&state);
    Ok(Json(filter_detail_for_user(
        &state,
        &actor,
        state.reorder_slides(&deck, req, &actor)?,
    )?))
}

async fn checkpoint(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    body: Option<Json<CommitRequest>>,
) -> ApiResult<Json<CommitInfo>> {
    let message = body.and_then(|b| b.0.message);
    store_write(state, "checkpoint", move |state| {
        state.checkpoint_as(&deck, message, &actor)
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryQuery {
    branch: String,
    before: Option<String>,
    limit: Option<usize>,
}

async fn history_page(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<HistoryQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<HistoryPage>> {
    tokio::task::spawn_blocking(move || {
        state.history_page(
            &deck,
            &query.branch,
            &actor,
            query.before.as_deref(),
            query.limit.unwrap_or(40),
        )
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
    .map(Json)
    .map_err(ApiError::from)
}

async fn commit_snapshot(
    State(state): State<Arc<AppState>>,
    Path((deck, commit)): Path<(String, String)>,
    Query(query): Query<HistoryQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<CommitSnapshot>> {
    tokio::task::spawn_blocking(move || {
        state.commit_snapshot(&deck, &query.branch, &commit, &actor)
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
    .map(Json)
    .map_err(ApiError::from)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreRequest {
    expected_head: String,
}

async fn restore_commit(
    State(state): State<Arc<AppState>>,
    Path((deck, commit)): Path<(String, String)>,
    Query(query): Query<HistoryQuery>,
    Extension(actor): Extension<DemoUser>,
    Json(request): Json<RestoreRequest>,
) -> ApiResult<Json<CommitInfo>> {
    store_write(state, "restore_commit", move |state| {
        state.restore_commit(
            &deck,
            &query.branch,
            &commit,
            &request.expected_head,
            &actor,
        )
    })
    .await
    .map(Json)
}

async fn list_commits(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Query(query): Query<CommitQuery>,
) -> ApiResult<Json<Vec<CommitInfo>>> {
    let commits = match query.session_id {
        Some(session) => state.commits_for_session(&deck, &session, query.limit.unwrap_or(50))?,
        None => state.commits(&deck, query.limit.unwrap_or(50))?,
    };
    Ok(Json(commits))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionQuery {
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitQuery {
    limit: Option<usize>,
    session_id: Option<String>,
}

async fn list_branches(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<Vec<BranchInfo>>> {
    Ok(Json(state.branches_for_user(&deck, &actor)?))
}

async fn create_branch(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<CreateBranchRequest>,
) -> ApiResult<(StatusCode, Json<DeckDetail>)> {
    let _guard = lock(&state);
    Ok((
        StatusCode::CREATED,
        Json(filter_detail_for_user(
            &state,
            &actor,
            state.create_branch(&deck, req, &actor)?,
        )?),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteBranchRequest {
    name: String,
}

async fn delete_branch(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<DeleteBranchRequest>,
) -> ApiResult<StatusCode> {
    let _guard = lock(&state);
    state.delete_branch(&deck, &req.name, &actor)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn checkout(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<CheckoutRequest>,
) -> ApiResult<Json<DeckDetail>> {
    let _guard = lock(&state);
    Ok(Json(filter_detail_for_user(
        &state,
        &actor,
        state.checkout(&deck, req, &actor)?,
    )?))
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    Path(deck): Path<String>,
    Extension(actor): Extension<DemoUser>,
    body: Option<Json<CreateSessionRequest>>,
) -> ApiResult<(StatusCode, Json<SessionInfo>)> {
    let mut req = body
        .map(|b| b.0)
        .unwrap_or(CreateSessionRequest { branch: None });
    let branch = req
        .branch
        .clone()
        .unwrap_or(state.preferred_branch(&deck, &actor)?);
    state.require_deck_role(&deck, &actor, &branch, DeckRole::View)?;
    req.branch = Some(branch);
    Ok((
        StatusCode::CREATED,
        Json(state.create_session_as(&deck, req, &actor)?),
    ))
}

async fn commit_session(
    State(state): State<Arc<AppState>>,
    Path(session): Path<String>,
    Extension(actor): Extension<DemoUser>,
    body: Option<Json<CommitRequest>>,
) -> ApiResult<Json<CommitInfo>> {
    let message = body.and_then(|b| b.0.message);
    store_write(state, "commit_session", move |state| {
        let (deck, branch, session_actor) = state.session_branch(&session)?;
        if session_actor.id != actor.id {
            return Err(AppError::Forbidden(
                "editing session belongs to another profile".into(),
            ));
        }
        state.require_deck_role(&deck, &actor, &branch, DeckRole::Edit)?;
        state.commit_session(&session, message)
    })
    .await
    .map(Json)
}

async fn close_session(
    State(state): State<Arc<AppState>>,
    Path(session): Path<String>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<StatusCode> {
    store_write(state, "close_session", move |state| {
        if let Ok((deck, branch, session_actor)) = state.session_branch(&session) {
            if session_actor.id != actor.id {
                return Err(AppError::Forbidden(
                    "editing session belongs to another profile".into(),
                ));
            }
            state.require_deck_role(&deck, &actor, &branch, DeckRole::View)?;
        }
        state.close_session(&session)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_assets(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    Query(query): Query<SessionQuery>,
) -> ApiResult<Json<Vec<AssetInfo>>> {
    Ok(Json(state.list_assets(
        &deck,
        &slide,
        query.session_id.as_deref(),
    )?))
}

async fn upload_asset(
    State(state): State<Arc<AppState>>,
    Path((deck, slide)): Path<(String, String)>,
    Query(query): Query<SessionQuery>,
    Extension(actor): Extension<DemoUser>,
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
            return Err(
                AppError::BadRequest("image files must be 100 MiB or smaller".into()).into(),
            );
        }
        upload = Some((name, bytes));
        break;
    }
    let (name, bytes) =
        upload.ok_or_else(|| AppError::BadRequest("expected a 'file' field".into()))?;
    let _guard = lock(&state);
    let branch = state.asset_branch(&deck, query.session_id.as_deref())?;
    let mut asset = state.upload_asset(
        &deck,
        &slide,
        &name,
        &bytes,
        query.session_id.as_deref(),
        &actor,
    )?;
    asset
        .url
        .push_str(&format!("?branch={branch}&demoUserId={}", actor.id));
    Ok(Json(asset))
}

async fn read_asset(
    State(state): State<Arc<AppState>>,
    Path((deck, slide, name)): Path<(String, String, String)>,
    Query(query): Query<AssetQuery>,
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<impl axum::response::IntoResponse> {
    let (bytes, mime) = if let Some(commit) = query.commit.as_deref() {
        let branch = query
            .branch
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("historical assets require a branch".into()))?;
        state.read_asset_at_commit(&deck, &slide, &name, branch, commit, &actor)?
    } else {
        match query.branch.as_deref() {
            Some(branch) => state.read_asset_for_branch(&deck, &slide, &name, branch)?,
            None => state.read_asset(&deck, &slide, &name, query.session_id.as_deref())?,
        }
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        bytes,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetQuery {
    commit: Option<String>,
    session_id: Option<String>,
    branch: Option<String>,
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
    Extension(actor): Extension<DemoUser>,
) -> ApiResult<Json<MergePreview>> {
    let target = query
        .target
        .clone()
        .unwrap_or(state.preferred_branch(&deck, &actor)?);
    state.require_deck_role(&deck, &actor, &query.source, DeckRole::View)?;
    state.require_deck_role(&deck, &actor, &target, DeckRole::View)?;
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
    Extension(actor): Extension<DemoUser>,
    Json(req): Json<ApplyMergeRequest>,
) -> ApiResult<Json<CommitInfo>> {
    let _guard = lock(&state);
    Ok(Json(merge::apply(&state, &deck, req, &actor)?))
}
