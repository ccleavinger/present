use crate::error::{AppError, AppResult};
use crate::jsonutil::{
    now_secs, read_json, read_json_opt, slugify, valid_id, write_atomic, write_json_atomic,
};
use git2::{BranchType, IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature};
use present_domain::*;
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub struct Session {
    pub info: SessionInfo,
    pub last_activity: Instant,
    pub dirty: bool,
}

pub struct AppState {
    pub decks_root: PathBuf,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub write_lock: Mutex<()>,
}

impl AppState {
    pub fn new(decks_root: PathBuf) -> Self {
        Self {
            decks_root,
            sessions: Mutex::new(HashMap::new()),
            write_lock: Mutex::new(()),
        }
    }

    pub fn deck_path(&self, deck_id: &str) -> AppResult<PathBuf> {
        if !valid_id(deck_id) {
            return Err(AppError::BadRequest("invalid deck id".into()));
        }
        Ok(self.decks_root.join(deck_id))
    }

    pub fn open_repo(&self, deck_id: &str) -> AppResult<Repository> {
        let path = self.deck_path(deck_id)?;
        if !path.is_dir() {
            return Err(AppError::NotFound(format!("deck '{deck_id}' not found")));
        }
        Repository::open(&path).map_err(|err| {
            if err.code() == git2::ErrorCode::NotFound {
                AppError::NotFound(format!("deck '{deck_id}' is not a git repository"))
            } else {
                err.into()
            }
        })
    }

    pub fn list_decks(&self) -> AppResult<Vec<DeckSummary>> {
        fs::create_dir_all(&self.decks_root)?;
        let mut decks = Vec::new();
        for entry in fs::read_dir(&self.decks_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if let Ok(summary) = self.deck_summary(&id) {
                decks.push(summary);
            }
        }
        decks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(decks)
    }

    fn deck_summary(&self, id: &str) -> AppResult<DeckSummary> {
        let repo = self.open_repo(id)?;
        let deck: Deck = read_json(&workdir(&repo)?.join("deck.json"))?;
        let (branch, updated_at) = head_info(&repo)?;
        Ok(DeckSummary {
            id: id.to_string(),
            title: deck.title,
            slide_count: deck.slides.len(),
            current_branch: branch,
            updated_at,
            dirty: repo_dirty(&repo)?,
        })
    }

    pub fn create_deck(&self, req: CreateDeckRequest) -> AppResult<DeckDetail> {
        let title = req.title.trim();
        if title.is_empty() {
            return Err(AppError::BadRequest("title is required".into()));
        }
        fs::create_dir_all(&self.decks_root)?;

        let id = match req.id {
            Some(id) => {
                if !valid_id(&id) {
                    return Err(AppError::BadRequest(
                        "id may only contain letters, numbers, '-' and '_'".into(),
                    ));
                }
                id
            }
            None => {
                let stem = slugify(title);
                loop {
                    let candidate = format!("{stem}-{}", short_id());
                    if !self.decks_root.join(&candidate).exists() {
                        break candidate;
                    }
                }
            }
        };
        let path = self.decks_root.join(&id);
        if path.exists() {
            return Err(AppError::Conflict(
                "a deck with that id already exists".into(),
            ));
        }
        fs::create_dir_all(&path)?;

        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main");
        opts.no_reinit(true);
        let repo = Repository::init_opts(&path, &opts)?;

        write_atomic(&path.join(".gitignore"), b"*.tmp\n.DS_Store\n")?;
        seed_deck(&path, &id, title)?;

        commit_all(&repo, "Initialize deck", &[])?;
        self.deck_detail(&id)
    }

    pub fn delete_deck(&self, id: &str) -> AppResult<()> {
        let path = self.deck_path(id)?;
        if !path.is_dir() {
            return Err(AppError::NotFound(format!("deck '{id}' not found")));
        }
        fs::remove_dir_all(path)?;
        Ok(())
    }

    pub fn deck_detail(&self, id: &str) -> AppResult<DeckDetail> {
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?.to_path_buf();
        let deck: Deck = read_json(&workdir.join("deck.json"))?;
        let mut slides = Vec::new();
        for (index, slide_id) in deck.slides.iter().enumerate() {
            let path = workdir.join("slides").join(slide_id).join("slide.json");
            if let Some(slide) = read_json_opt::<Slide>(&path)? {
                slides.push(SlideSummary {
                    id: slide.id,
                    name: slide.name,
                    background: slide.background,
                    index,
                    element_count: slide.elements.len(),
                });
            }
        }
        let branches = self.branches(id)?;
        let current_branch = current_branch(&repo)?;
        Ok(DeckDetail {
            id: id.to_string(),
            deck,
            slides,
            current_branch,
            branches,
            dirty: repo_dirty(&repo)?,
        })
    }

    pub fn update_deck(&self, id: &str, req: UpdateDeckRequest) -> AppResult<DeckDetail> {
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?.to_path_buf();
        let path = workdir.join("deck.json");
        let mut deck: Deck = read_json(&path)?;
        if let Some(title) = req.title {
            let title = title.trim();
            if title.is_empty() {
                return Err(AppError::BadRequest("title cannot be empty".into()));
            }
            deck.title = title.to_string();
        }
        if let Some(tokens) = req.tokens {
            deck.tokens = tokens;
        }
        write_json_atomic(&path, &deck)?;
        self.deck_detail(id)
    }

    pub fn read_slide(&self, id: &str, slide_id: &str) -> AppResult<SlidePayload> {
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?;
        let dir = slide_dir(workdir, slide_id)?;
        let slide: Slide = read_json(&dir.join("slide.json"))?;
        let notes = fs::read_to_string(dir.join("notes.md")).unwrap_or_default();
        let assets = list_assets(workdir, id, slide_id)?;
        Ok(SlidePayload {
            slide,
            notes,
            assets,
        })
    }

    pub fn write_slide(
        &self,
        id: &str,
        slide_id: &str,
        req: WriteSlideRequest,
    ) -> AppResult<SlidePayload> {
        if req.slide.id != slide_id {
            return Err(AppError::BadRequest(
                "slide id in body does not match route".into(),
            ));
        }
        self.validate_session(id, req.session_id.as_deref())?;
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?;
        let deck: Deck = read_json(&workdir.join("deck.json"))?;
        if !deck.slides.iter().any(|s| s == slide_id) {
            return Err(AppError::NotFound(format!(
                "slide '{slide_id}' not in deck"
            )));
        }
        let dir = slide_dir(workdir, slide_id)?;
        write_json_atomic(&dir.join("slide.json"), &req.slide)?;
        self.touch_session(req.session_id.as_deref());
        self.read_slide(id, slide_id)
    }

    pub fn write_notes(
        &self,
        id: &str,
        slide_id: &str,
        req: WriteNotesRequest,
    ) -> AppResult<SlidePayload> {
        self.validate_session(id, req.session_id.as_deref())?;
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?;
        let dir = slide_dir(workdir, slide_id)?;
        write_atomic(&dir.join("notes.md"), req.notes.as_bytes())?;
        self.touch_session(req.session_id.as_deref());
        self.read_slide(id, slide_id)
    }

    pub fn create_slide(&self, id: &str, req: CreateSlideRequest) -> AppResult<SlidePayload> {
        self.validate_session(id, req.session_id.as_deref())?;
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?;
        let deck_path = workdir.join("deck.json");
        let mut deck: Deck = read_json(&deck_path)?;

        let mut n = deck.slides.len() + 1;
        let slide_id = loop {
            let candidate = format!("s_{n:02}_{}", &short_id()[..4]);
            if !deck.slides.iter().any(|s| s == &candidate) {
                break candidate;
            }
            n += 1;
        };
        let name = req
            .name
            .unwrap_or_else(|| format!("Slide {}", deck.slides.len() + 1));
        let mut slide = Slide::blank(&slide_id, &name);
        slide.background = "#fff6e9".into();
        let mut style = BTreeMap::new();
        style.insert("fontSize".into(), json!(72));
        style.insert("fontWeight".into(), json!(700));
        style.insert("color".into(), json!("#3d2a20"));
        slide.elements.insert(
            "el_title".into(),
            Element {
                id: "el_title".into(),
                kind: "text".into(),
                x: 160.0,
                y: 140.0,
                w: 1200.0,
                h: 140.0,
                z: 0,
                text: Some(name.clone()),
                style,
                ..Default::default()
            },
        );

        let dir = workdir.join("slides").join(&slide_id);
        write_json_atomic(&dir.join("slide.json"), &slide)?;
        write_atomic(&dir.join("notes.md"), b"")?;
        fs::create_dir_all(dir.join("assets"))?;
        write_atomic(&dir.join("assets/.gitkeep"), b"")?;

        let index = match req.after {
            Some(after) => deck
                .slides
                .iter()
                .position(|s| s == &after)
                .map(|i| i + 1)
                .unwrap_or(deck.slides.len()),
            None => deck.slides.len(),
        };
        deck.slides.insert(index, slide_id.clone());
        write_json_atomic(&deck_path, &deck)?;
        self.touch_session(req.session_id.as_deref());
        self.read_slide(id, &slide_id)
    }

    pub fn delete_slide(&self, id: &str, slide_id: &str) -> AppResult<DeckDetail> {
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?;
        let deck_path = workdir.join("deck.json");
        let mut deck: Deck = read_json(&deck_path)?;
        if deck.slides.len() <= 1 {
            return Err(AppError::BadRequest(
                "a deck must contain at least one slide".into(),
            ));
        }
        let before = deck.slides.len();
        deck.slides.retain(|s| s != slide_id);
        if deck.slides.len() == before {
            return Err(AppError::NotFound("slide not found".into()));
        }
        write_json_atomic(&deck_path, &deck)?;
        let dir = workdir.join("slides").join(slide_id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        self.deck_detail(id)
    }

    pub fn reorder_slides(&self, id: &str, req: ReorderRequest) -> AppResult<DeckDetail> {
        self.validate_session(id, req.session_id.as_deref())?;
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?;
        let deck_path = workdir.join("deck.json");
        let mut deck: Deck = read_json(&deck_path)?;
        let existing: HashSet<_> = deck.slides.iter().cloned().collect();
        let incoming: HashSet<_> = req.slides.iter().cloned().collect();
        if existing != incoming || req.slides.len() != deck.slides.len() {
            return Err(AppError::BadRequest(
                "reorder must contain every slide exactly once".into(),
            ));
        }
        deck.slides = req.slides;
        write_json_atomic(&deck_path, &deck)?;
        self.touch_session(req.session_id.as_deref());
        self.deck_detail(id)
    }

    pub fn list_assets(&self, id: &str, slide_id: &str) -> AppResult<Vec<AssetInfo>> {
        let repo = self.open_repo(id)?;
        list_assets(workdir(&repo)?, id, slide_id)
    }

    pub fn upload_asset(
        &self,
        id: &str,
        slide_id: &str,
        filename: &str,
        bytes: &[u8],
    ) -> AppResult<AssetInfo> {
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?;
        let dir = slide_dir(workdir, slide_id)?;
        let name = sanitize_asset_name(filename)?;
        let path = dir.join("assets").join(&name);
        write_atomic(&path, bytes)?;
        Ok(AssetInfo {
            name: name.clone(),
            url: asset_url(id, slide_id, &name),
        })
    }

    pub fn read_asset(&self, id: &str, slide_id: &str, name: &str) -> AppResult<(Vec<u8>, String)> {
        let repo = self.open_repo(id)?;
        let workdir = workdir(&repo)?;
        let dir = slide_dir(workdir, slide_id)?;
        let name = sanitize_asset_name(name)?;
        let path = dir.join("assets").join(&name);
        let bytes =
            fs::read(&path).map_err(|_| AppError::NotFound(format!("asset '{name}' not found")))?;
        let mime = mime_guess::from_path(&name)
            .first_or_octet_stream()
            .to_string();
        Ok((bytes, mime))
    }

    pub fn commits(&self, id: &str, limit: usize) -> AppResult<Vec<CommitInfo>> {
        let repo = self.open_repo(id)?;
        let mut walk = repo.revwalk()?;
        walk.push_head()?;
        let mut out = Vec::new();
        for oid in walk.take(limit.max(1).min(200)) {
            let oid = oid?;
            let commit = repo.find_commit(oid)?;
            out.push(commit_info(&commit, true)?);
        }
        Ok(out)
    }

    pub fn branches(&self, id: &str) -> AppResult<Vec<BranchInfo>> {
        let repo = self.open_repo(id)?;
        let current = current_branch(&repo)?;
        let mut out = Vec::new();
        for branch in repo.branches(Some(BranchType::Local))? {
            let (branch, _) = branch?;
            let Some(name) = branch.name()?.map(str::to_owned) else {
                continue;
            };
            let commit = branch.get().peel_to_commit()?;
            out.push(BranchInfo {
                is_current: name == current,
                name,
                commit_id: commit.id().to_string(),
                summary: commit.summary()?.unwrap_or_default().to_string(),
                time: commit.time().seconds(),
            });
        }
        out.sort_by(|a, b| {
            b.is_current
                .cmp(&a.is_current)
                .then_with(|| b.time.cmp(&a.time))
        });
        Ok(out)
    }

    pub fn create_branch(&self, id: &str, req: CreateBranchRequest) -> AppResult<DeckDetail> {
        if req.name.trim().is_empty() {
            return Err(AppError::BadRequest("branch name is required".into()));
        }
        self.validate_session(id, req.session_id.as_deref())?;
        let repo = self.open_repo(id)?;

        // Fold any pending work into the current branch before forking, so a
        // branch created "from current" starts at the latest session commit.
        if req.checkout {
            if let Some(session_id) = req.session_id.as_deref() {
                self.commit_session(session_id, Some("Checkpoint before branch switch".into()))?;
            } else {
                commit_all(&repo, "Checkpoint before branch switch", &[])?;
            }
        }

        let from_commit = match req.from.as_deref() {
            Some(from) => repo
                .find_branch(from, BranchType::Local)?
                .get()
                .peel_to_commit()?,
            None => repo.head()?.peel_to_commit()?,
        };
        repo.branch(req.name.trim(), &from_commit, false)?;
        if req.checkout {
            checkout_branch(&repo, req.name.trim())?;
            if let Some(session_id) = req.session_id.as_deref() {
                self.set_session_branch(session_id, req.name.trim());
            }
        }
        self.deck_detail(id)
    }

    pub fn checkout(&self, id: &str, req: CheckoutRequest) -> AppResult<DeckDetail> {
        self.validate_session(id, req.session_id.as_deref())?;
        let repo = self.open_repo(id)?;
        if let Some(session_id) = req.session_id.as_deref() {
            self.commit_session(session_id, Some("Checkpoint before branch switch".into()))?;
        } else {
            commit_all(&repo, "Checkpoint before branch switch", &[])?;
        }
        checkout_branch(&repo, &req.branch)?;
        if let Some(session_id) = req.session_id.as_deref() {
            self.set_session_branch(session_id, &req.branch);
        }
        self.deck_detail(id)
    }

    pub fn checkpoint(&self, id: &str, message: Option<String>) -> AppResult<CommitInfo> {
        let repo = self.open_repo(id)?;
        commit_all(
            &repo,
            message.as_deref().unwrap_or("Manual checkpoint"),
            &[],
        )
    }

    // ---------------------------------------------------------------------
    // Sessions
    // ---------------------------------------------------------------------

    pub fn create_session(&self, id: &str, req: CreateSessionRequest) -> AppResult<SessionInfo> {
        let repo = self.open_repo(id)?;
        let branch = match req.branch {
            Some(branch) => {
                repo.find_branch(&branch, BranchType::Local)?;
                branch
            }
            None => current_branch(&repo)?,
        };
        let info = SessionInfo {
            id: format!("ses_{}", Uuid::new_v4().simple()),
            deck_id: id.to_string(),
            branch,
            opened_at: now_secs(),
        };
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.insert(
            info.id.clone(),
            Session {
                info: info.clone(),
                last_activity: Instant::now(),
                dirty: false,
            },
        );
        Ok(info)
    }

    fn validate_session(&self, deck_id: &str, session_id: Option<&str>) -> AppResult<()> {
        let Some(session_id) = session_id else {
            return Ok(());
        };
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get(session_id) {
            Some(session) if session.info.deck_id == deck_id => Ok(()),
            Some(_) => Err(AppError::BadRequest(
                "session belongs to another deck".into(),
            )),
            None => Err(AppError::BadRequest("unknown or expired session".into())),
        }
    }

    fn touch_session(&self, session_id: Option<&str>) {
        let Some(session_id) = session_id else {
            return;
        };
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = sessions.get_mut(session_id) {
            session.last_activity = Instant::now();
            session.dirty = true;
        }
    }

    fn set_session_branch(&self, session_id: &str, branch: &str) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = sessions.get_mut(session_id) {
            session.info.branch = branch.to_string();
            session.dirty = false;
            session.last_activity = Instant::now();
        }
    }

    pub fn commit_session(
        &self,
        session_id: &str,
        message: Option<String>,
    ) -> AppResult<CommitInfo> {
        let (deck_id, branch) = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = sessions
                .get(session_id)
                .ok_or_else(|| AppError::NotFound("session not found".into()))?;
            (session.info.deck_id.clone(), session.info.branch.clone())
        };
        let repo = self.open_repo(&deck_id)?;
        let current = current_branch(&repo)?;
        if current != branch {
            return Err(AppError::Conflict(
                "session branch no longer matches the checked-out branch".into(),
            ));
        }
        let info = commit_all(
            &repo,
            message.as_deref().unwrap_or("Session checkpoint"),
            &[],
        )?;
        self.set_session_branch(session_id, &branch);
        Ok(info)
    }

    pub fn close_session(&self, session_id: &str) -> AppResult<()> {
        let exists = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.contains_key(session_id)
        };
        if !exists {
            return Ok(());
        }
        if let Err(err) = self.commit_session(session_id, Some("Close editing session".into())) {
            tracing::warn!(session = %session_id, error = %err, "could not commit session on close");
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.remove(session_id);
        Ok(())
    }

    /// Commit and drop every in-memory editing session. Used during graceful
    /// shutdown so Docker's `SIGTERM` does not lose the last debounce window.
    pub fn close_all_sessions(&self) {
        let ids: Vec<String> = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.keys().cloned().collect()
        };
        for id in ids {
            if let Err(err) = self.close_session(&id) {
                tracing::warn!(session = %id, error = %err, "could not close session");
            }
        }
    }

    pub fn expire_sessions(&self, max_idle: Duration) {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<String> = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions
                .iter()
                .filter(|(_, s)| s.last_activity.elapsed() >= max_idle)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in ids {
            tracing::info!(session = %id, "expiring idle session");
            let _ = self.close_session(&id);
        }
    }
}

// ---------------------------------------------------------------------------
// Filesystem / repository helpers
// ---------------------------------------------------------------------------

pub fn workdir(repo: &Repository) -> AppResult<&Path> {
    repo.workdir()
        .ok_or_else(|| AppError::Internal("deck repository has no working tree".into()))
}

pub fn slide_dir(workdir: &Path, slide_id: &str) -> AppResult<PathBuf> {
    if !valid_id(slide_id) {
        return Err(AppError::BadRequest("invalid slide id".into()));
    }
    Ok(workdir.join("slides").join(slide_id))
}

pub fn current_branch(repo: &Repository) -> AppResult<String> {
    match repo.head() {
        Ok(head) => Ok(head.shorthand()?.to_string()),
        Err(err) if is_unborn(&err) => Ok("main".into()),
        Err(err) => Err(err.into()),
    }
}

fn is_unborn(err: &git2::Error) -> bool {
    matches!(
        err.code(),
        git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
    )
}

fn head_commit(repo: &Repository) -> AppResult<Option<git2::Commit<'_>>> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_commit()?)),
        Err(err) if is_unborn(&err) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn repo_dirty(repo: &Repository) -> AppResult<bool> {
    Ok(repo
        .statuses(None)?
        .iter()
        .any(|entry| entry.status() != git2::Status::CURRENT))
}

fn head_info(repo: &Repository) -> AppResult<(String, i64)> {
    let branch = current_branch(repo)?;
    let time = head_commit(repo)?
        .map(|commit| commit.time().seconds())
        .unwrap_or(0);
    Ok((branch, time))
}

fn short_id() -> String {
    let mut id = Uuid::new_v4().simple().to_string();
    id.truncate(6);
    id
}

fn signature() -> AppResult<Signature<'static>> {
    Ok(Signature::now("Present", "present@local")?)
}

/// Stage every change in the work tree and create a commit on HEAD.
///
/// Returns `committed: false` when the tree is unchanged and no extra parents
/// were requested.
pub fn commit_all(
    repo: &Repository,
    message: &str,
    extra_parents: &[Oid],
) -> AppResult<CommitInfo> {
    let mut index = repo.index()?;
    index.update_all(["*"], None)?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let head = head_commit(repo)?;
    if extra_parents.is_empty() {
        if let Some(head) = &head {
            if head.tree_id() == tree_id {
                return commit_info(head, false);
            }
        }
    }

    let mut parents: Vec<git2::Commit> = Vec::new();
    if let Some(head) = head {
        parents.push(head);
    }
    for oid in extra_parents {
        if parents.iter().any(|p| p.id() == *oid) {
            continue;
        }
        parents.push(repo.find_commit(*oid)?);
    }
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let sig = signature()?;
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)?;
    let commit = repo.find_commit(oid)?;
    commit_info(&commit, true)
}

pub fn merge_commit(
    repo: &Repository,
    message: &str,
    ours: Oid,
    theirs: Oid,
) -> AppResult<CommitInfo> {
    let mut index = repo.index()?;
    index.update_all(["*"], None)?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let ours_commit = repo.find_commit(ours)?;
    let theirs_commit = repo.find_commit(theirs)?;
    let sig = signature()?;
    let oid = repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        message,
        &tree,
        &[&ours_commit, &theirs_commit],
    )?;
    commit_info(&repo.find_commit(oid)?, true)
}

fn commit_info(commit: &git2::Commit, committed: bool) -> AppResult<CommitInfo> {
    Ok(CommitInfo {
        id: commit.id().to_string(),
        summary: commit.summary()?.unwrap_or("(no message)").to_string(),
        author: commit.author().name().unwrap_or("Present").to_string(),
        time: commit.time().seconds(),
        committed,
    })
}

pub fn checkout_branch(repo: &Repository, branch: &str) -> AppResult<()> {
    let branch_ref = repo.find_branch(branch, BranchType::Local)?;
    let reference = branch_ref.into_reference();
    let tree = reference.peel_to_commit()?.tree()?;
    let name = reference.name()?;
    repo.set_head(name)?;
    repo.checkout_tree(
        tree.as_object(),
        Some(git2::build::CheckoutBuilder::new().force()),
    )?;
    Ok(())
}

fn sanitize_asset_name(filename: &str) -> AppResult<String> {
    let base = Path::new(filename)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::BadRequest("invalid file name".into()))?;
    let mut out = String::new();
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else if ch == ' ' {
            out.push('-');
        }
    }
    if out.is_empty() || out.starts_with('.') || out.len() > 120 {
        return Err(AppError::BadRequest("invalid file name".into()));
    }
    Ok(out)
}

fn asset_url(deck_id: &str, slide_id: &str, name: &str) -> String {
    format!("/api/decks/{deck_id}/slides/{slide_id}/assets/{name}")
}

fn list_assets(workdir: &Path, deck_id: &str, slide_id: &str) -> AppResult<Vec<AssetInfo>> {
    let dir = slide_dir(workdir, slide_id)?.join("assets");
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        out.push(AssetInfo {
            url: asset_url(deck_id, slide_id, &name),
            name,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Seed content
// ---------------------------------------------------------------------------

fn seed_deck(path: &Path, id: &str, title: &str) -> AppResult<()> {
    let mut deck = Deck::new(title);
    let mut tokens = BTreeMap::new();
    tokens.insert(
        "fontFamily".into(),
        json!("Inter, ui-sans-serif, system-ui"),
    );
    tokens.insert("accent".into(), json!("#e06d4f"));
    tokens.insert("ink".into(), json!("#3d2a20"));
    deck.tokens = tokens;
    deck.slides = vec![
        "s_01_title".into(),
        "s_02_repository".into(),
        "s_03_merge".into(),
    ];
    write_json_atomic(&path.join("deck.json"), &deck)?;

    let title_slide = Slide {
        version: 1,
        id: "s_01_title".into(),
        name: "Title".into(),
        background: "#ffe4d2".into(),
        elements: [
            (
                "el_glow_a".to_string(),
                ellipse("el_glow_a", 1360.0, -220.0, 760.0, 760.0, "#ffd0c2", 0),
            ),
            (
                "el_glow_b".to_string(),
                ellipse("el_glow_b", -180.0, 760.0, 560.0, 560.0, "#ffe8a8", 0),
            ),
            (
                "el_accent".to_string(),
                rect("el_accent", 160.0, 224.0, 110.0, 12.0, "#e06d4f", 1),
            ),
            (
                "el_title".to_string(),
                text(
                    "el_title", title, 160.0, 272.0, 1300.0, 190.0, 148.0, "#3d2a20", 700, 1,
                ),
            ),
            (
                "el_subtitle".to_string(),
                text(
                    "el_subtitle",
                    "A git-native presentation platform",
                    164.0,
                    500.0,
                    1100.0,
                    70.0,
                    44.0,
                    "#7a5f4a",
                    400,
                    2,
                ),
            ),
            (
                "el_footer".to_string(),
                text(
                    "el_footer",
                    "Every save is a repo change. Every session is a commit.",
                    164.0,
                    920.0,
                    1200.0,
                    44.0,
                    24.0,
                    "#b08a6b",
                    400,
                    3,
                ),
            ),
        ]
        .into_iter()
        .collect(),
    };

    let repo_slide = Slide {
        version: 1,
        id: "s_02_repository".into(),
        name: "A deck is a repository".into(),
        background: "#eee7ff".into(),
        elements: [
            (
                "el_glow".to_string(),
                ellipse("el_glow", 1460.0, -260.0, 640.0, 640.0, "#fff0b8", 0),
            ),
            (
                "el_heading".to_string(),
                text(
                    "el_heading",
                    "A deck is a repository",
                    160.0,
                    120.0,
                    1200.0,
                    100.0,
                    72.0,
                    "#3d2a20",
                    700,
                    3,
                ),
            ),
            (
                "el_card".to_string(),
                rect("el_card", 160.0, 300.0, 780.0, 560.0, "#d5c7f7", 0),
            ),
            (
                "el_tree".to_string(),
                text(
                    "el_tree",
                    "deck-repo/\n├── deck.json\n└── slides/\n    ├── s_01_title/\n    │   ├── slide.json\n    │   └── notes.md\n    └── s_02_repository/",
                    220.0,
                    360.0,
                    680.0,
                    440.0,
                    34.0,
                    "#3d2a20",
                    500,
                    1,
                ),
            ),
            (
                "el_body".to_string(),
                text(
                    "el_body",
                    "Slides live in isolated folders, so two people editing different slides never touch the same file.\n\nElements are a flat id → node map with sorted keys. Reordering layers cannot cascade a diff through the whole file.",
                    1020.0,
                    330.0,
                    720.0,
                    470.0,
                    34.0,
                    "#654b39",
                    400,
                    2,
                ),
            ),
            (
                "el_accent2".to_string(),
                rect("el_accent2", 1020.0, 280.0, 80.0, 8.0, "#e06d4f", 3),
            ),
        ]
        .into_iter()
        .collect(),
    };

    let merge_slide = Slide {
        version: 1,
        id: "s_03_merge".into(),
        name: "Merge without fear".into(),
        background: "#ddf4e8".into(),
        elements: [
            (
                "el_glow".to_string(),
                ellipse("el_glow", -240.0, -260.0, 640.0, 640.0, "#ffd7e2", 0),
            ),
            (
                "el_heading".to_string(),
                text(
                    "el_heading",
                    "Merge without fear",
                    160.0,
                    120.0,
                    1300.0,
                    100.0,
                    72.0,
                    "#3d2a20",
                    700,
                    3,
                ),
            ),
            (
                "el_a".to_string(),
                rect("el_a", 160.0, 300.0, 760.0, 460.0, "#fff8ed", 0),
            ),
            (
                "el_b".to_string(),
                rect("el_b", 1000.0, 300.0, 760.0, 460.0, "#fff8ed", 1),
            ),
            (
                "el_a_label".to_string(),
                text(
                    "el_a_label",
                    "Branch A  ·  styling",
                    220.0,
                    350.0,
                    640.0,
                    60.0,
                    34.0,
                    "#b85c43",
                    700,
                    2,
                ),
            ),
            (
                "el_b_label".to_string(),
                text(
                    "el_b_label",
                    "Branch B  ·  position",
                    1060.0,
                    350.0,
                    640.0,
                    60.0,
                    34.0,
                    "#7b5ea7",
                    700,
                    2,
                ),
            ),
            (
                "el_a_body".to_string(),
                text(
                    "el_a_body",
                    "fontSize: 72 → 84\nfontWeight: 400 → 700\n\nThe merge driver sees a style-only change.",
                    220.0,
                    430.0,
                    620.0,
                    270.0,
                    34.0,
                    "#654b39",
                    400,
                    3,
                ),
            ),
            (
                "el_b_body".to_string(),
                text(
                    "el_b_body",
                    "x: 160 → 420\ny: 300 → 260\n\nThe merge driver sees a transform-only change.",
                    1060.0,
                    430.0,
                    620.0,
                    270.0,
                    34.0,
                    "#654b39",
                    400,
                    3,
                ),
            ),
            (
                "el_result".to_string(),
                text(
                    "el_result",
                    "Orthogonal changes merge cleanly. Overlapping properties surface as a visual conflict.",
                    160.0,
                    860.0,
                    1600.0,
                    80.0,
                    36.0,
                    "#2f755b",
                    600,
                    4,
                ),
            ),
        ]
        .into_iter()
        .collect(),
    };

    let slides = [title_slide, repo_slide, merge_slide];
    let notes = [
        "Welcome. This deck is a Git repository. Try a checkpoint, create a branch, then merge it back.",
        "Each slide has its own directory. Assets and notes are co-located with the slide.",
        "The merge driver is a 3-way AST merge. Property collisions are resolved visually.",
    ];
    for (slide, note) in slides.iter().zip(notes) {
        let dir = path.join("slides").join(&slide.id);
        write_json_atomic(&dir.join("slide.json"), slide)?;
        write_atomic(&dir.join("notes.md"), note.as_bytes())?;
        fs::create_dir_all(dir.join("assets"))?;
        write_atomic(&dir.join("assets/.gitkeep"), b"")?;
    }

    let _ = id;
    Ok(())
}

fn text(
    id: &str,
    value: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    size: f64,
    color: &str,
    weight: i64,
    z: i64,
) -> Element {
    let mut style = BTreeMap::new();
    style.insert("fontSize".into(), json!(size));
    style.insert("fontWeight".into(), json!(weight));
    style.insert("color".into(), json!(color));
    style.insert("align".into(), json!("left"));
    style.insert("lineHeight".into(), json!(1.25));
    Element {
        id: id.into(),
        kind: "text".into(),
        x,
        y,
        w,
        h,
        rotation: 0.0,
        z,
        text: Some(value.into()),
        fill: None,
        stroke: None,
        stroke_width: None,
        src: None,
        opacity: None,
        style,
        extra: BTreeMap::new(),
    }
}

fn rect(id: &str, x: f64, y: f64, w: f64, h: f64, fill: &str, z: i64) -> Element {
    Element {
        id: id.into(),
        kind: "rect".into(),
        x,
        y,
        w,
        h,
        rotation: 0.0,
        z,
        text: None,
        fill: Some(fill.into()),
        stroke: None,
        stroke_width: None,
        src: None,
        opacity: None,
        style: BTreeMap::new(),
        extra: BTreeMap::new(),
    }
}

fn ellipse(id: &str, x: f64, y: f64, w: f64, h: f64, fill: &str, z: i64) -> Element {
    Element {
        kind: "ellipse".into(),
        ..rect(id, x, y, w, h, fill, z)
    }
}
