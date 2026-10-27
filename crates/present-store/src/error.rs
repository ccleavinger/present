#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Internal(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppErrorKind {
    BadRequest,
    NotFound,
    Conflict,
    Unauthorized,
    Forbidden,
    Internal,
}

impl AppError {
    pub fn kind(&self) -> AppErrorKind {
        match self {
            Self::BadRequest(_) => AppErrorKind::BadRequest,
            Self::NotFound(_) => AppErrorKind::NotFound,
            Self::Conflict(_) => AppErrorKind::Conflict,
            Self::Unauthorized(_) => AppErrorKind::Unauthorized,
            Self::Forbidden(_) => AppErrorKind::Forbidden,
            Self::Internal(_) | Self::Io(_) | Self::Json(_) => AppErrorKind::Internal,
            Self::Git(err) => match err.code() {
                git2::ErrorCode::NotFound | git2::ErrorCode::UnbornBranch => AppErrorKind::NotFound,
                git2::ErrorCode::Exists
                | git2::ErrorCode::Conflict
                | git2::ErrorCode::MergeConflict
                | git2::ErrorCode::NotFastForward
                | git2::ErrorCode::Uncommitted
                | git2::ErrorCode::Modified => AppErrorKind::Conflict,
                git2::ErrorCode::Invalid | git2::ErrorCode::InvalidSpec => AppErrorKind::BadRequest,
                _ => AppErrorKind::Internal,
            },
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
