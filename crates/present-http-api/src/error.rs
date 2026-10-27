use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use present_store::{AppError, AppErrorKind};
use serde_json::json;

#[derive(Debug)]
pub(crate) struct ApiError(AppError);

impl From<AppError> for ApiError {
    fn from(error: AppError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0.kind() {
            AppErrorKind::BadRequest => StatusCode::BAD_REQUEST,
            AppErrorKind::NotFound => StatusCode::NOT_FOUND,
            AppErrorKind::Conflict => StatusCode::CONFLICT,
            AppErrorKind::Unauthorized => StatusCode::UNAUTHORIZED,
            AppErrorKind::Forbidden => StatusCode::FORBIDDEN,
            AppErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let message = self.0.to_string();
        if status.is_server_error() {
            tracing::error!(error = %message, "request failed");
        }
        (status, Json(json!({ "error": message }))).into_response()
    }
}
