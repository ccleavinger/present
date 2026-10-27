use crate::error::{AppError, AppResult};
use crate::jsonutil::{
    now_secs, read_json, read_json_opt, slugify, valid_id, write_atomic, write_json_atomic,
};
use base64::Engine;
use git2::{BranchType, IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature};
use hashbrown::{HashMap, HashSet};
use parking_lot::Mutex;
use present_domain::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::hash::{BuildHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub struct Session {
    pub info: SessionInfo,
    pub actor: DemoUser,
    pub last_activity: Instant,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeckCollaborationFile {
    owner_id: String,
    #[serde(default)]
    members: HashMap<String, BTreeMap<String, DeckRole>>,
    #[serde(default)]
    comments: Vec<StoredComment>,
    #[serde(default)]
    share_links: Vec<StoredShareLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredShareLink {
    id: String,
    token: String,
    branch: String,
    role: DeckRole,
    created_at: i64,
    #[serde(default)]
    member_ids: HashSet<String>,
}

impl StoredShareLink {
    fn public(&self) -> ShareLink {
        ShareLink {
            id: self.id.clone(),
            token: self.token.clone(),
            branch: self.branch.clone(),
            role: self.role,
            created_at: self.created_at,
            joined_count: self.member_ids.len(),
        }
    }
}

impl DeckCollaborationFile {
    fn member_branches(&self, user_id: &str) -> BTreeMap<String, DeckRole> {
        let mut branches = self.members.get(user_id).cloned().unwrap_or_default();
        for link in self
            .share_links
            .iter()
            .filter(|link| link.member_ids.contains(user_id))
        {
            branches
                .entry(link.branch.clone())
                .and_modify(|role| *role = (*role).max(link.role))
                .or_insert(link.role);
        }
        branches
    }

    fn effective_members(&self) -> HashMap<String, BTreeMap<String, DeckRole>> {
        let mut users: HashSet<String> = self.members.keys().cloned().collect();
        for link in &self.share_links {
            users.extend(link.member_ids.iter().cloned());
        }
        users
            .into_iter()
            .map(|id| {
                let branches = self.member_branches(&id);
                (id, branches)
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredComment {
    branch: String,
    slide_id: String,
    object_id: String,
    root_id: String,
    comment: ObjectComment,
}

struct EditBatch {
    started: Instant,
    last_edit: Instant,
    points: usize,
    slides: HashSet<String>,
    actor: DemoUser,
}

pub struct AppState {
    pub decks_root: PathBuf,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub write_lock: Mutex<()>,
    demo_users_path: PathBuf,
    demo_users: Mutex<Option<Vec<DemoUser>>>,
    collaboration_root: PathBuf,
    object_locks: Mutex<HashMap<(String, String, String), (String, Option<String>, Instant)>>,
    live_presence: Mutex<HashMap<(String, String), HashMap<String, (String, serde_json::Value)>>>,
    edit_batches: Mutex<HashMap<(String, String), EditBatch>>,
}

impl AppState {
    pub fn new(decks_root: PathBuf) -> Self {
        let data_root = decks_root.parent().unwrap_or_else(|| Path::new("."));
        Self {
            demo_users_path: data_root.join("users.json"),
            demo_users: Mutex::new(None),
            collaboration_root: data_root.join("collaboration"),
            object_locks: Mutex::new(HashMap::new()),
            live_presence: Mutex::new(HashMap::new()),
            decks_root,
            sessions: Mutex::new(HashMap::new()),
            write_lock: Mutex::new(()),
            edit_batches: Mutex::new(HashMap::new()),
        }
    }

    fn load_demo_users(&self) -> AppResult<Vec<DemoUser>> {
        let mut users = self.demo_users.lock();
        if users.is_none() {
            *users = read_json_opt(&self.demo_users_path)?;
            if users.is_none() {
                *users = Some(Vec::new());
            }
        }
        Ok(users.as_ref().expect("demo users initialized").clone())
    }

    pub fn demo_users(&self) -> AppResult<Vec<DemoUser>> {
        self.load_demo_users()
    }

    pub fn demo_user(&self, id: &str) -> AppResult<DemoUser> {
        self.load_demo_users()?
            .into_iter()
            .find(|user| user.id == id)
            .ok_or_else(|| AppError::Unauthorized("unknown demo profile".into()))
    }

    pub fn create_demo_user(&self, username: &str) -> AppResult<DemoUser> {
        let username = username.trim();
        if username.is_empty()
            || username.chars().count() > 32
            || !username
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(AppError::BadRequest(
                "username must be 1-32 letters, numbers, underscores, or hyphens".into(),
            ));
        }
        let mut users = self.demo_users.lock();
        if users.is_none() {
            *users = read_json_opt(&self.demo_users_path)?;
            if users.is_none() {
                *users = Some(Vec::new());
            }
        }
        let current = users.as_mut().expect("demo users initialized");
        if current
            .iter()
            .any(|user| user.username.eq_ignore_ascii_case(username))
        {
            return Err(AppError::Conflict("that username is already taken".into()));
        }
        let user = DemoUser {
            id: format!("usr_{}", Uuid::new_v4().simple()),
            username: username.to_ascii_lowercase(),
            display_name: username.to_string(),
        };
        current.push(user.clone());
        if let Err(error) = write_json_atomic(&self.demo_users_path, current) {
            current.pop();
            return Err(error);
        }
        Ok(user)
    }

    pub fn sign_in_demo_user(&self, username: &str) -> AppResult<DemoUser> {
        let username = username.trim();
        self.load_demo_users()?
            .into_iter()
            .find(|user| {
                user.username.eq_ignore_ascii_case(username)
                    || (user.username.is_empty()
                        && user.display_name.eq_ignore_ascii_case(username))
            })
            .ok_or_else(|| AppError::NotFound("no account exists with that username".into()))
    }

    fn collaboration_path(&self, deck_id: &str) -> AppResult<PathBuf> {
        if !valid_id(deck_id) {
            return Err(AppError::BadRequest("invalid deck id".into()));
        }
        Ok(self.collaboration_root.join(format!("{deck_id}.json")))
    }

    fn load_collaboration(&self, deck_id: &str) -> AppResult<DeckCollaborationFile> {
        read_json(&self.collaboration_path(deck_id)?)
    }

    fn save_collaboration(&self, deck_id: &str, data: &DeckCollaborationFile) -> AppResult<()> {
        fs::create_dir_all(&self.collaboration_root)?;
        write_json_atomic(&self.collaboration_path(deck_id)?, data)
    }

    pub fn deck_role(
        &self,
        deck_id: &str,
        user_id: &str,
        branch: &str,
    ) -> AppResult<Option<DeckRole>> {
        let data = self.load_collaboration(deck_id)?;
        if data.owner_id == user_id {
            return Ok(Some(DeckRole::Edit));
        }
        Ok(data.member_branches(user_id).get(branch).copied())
    }

    pub fn is_deck_owner(&self, deck_id: &str, user: &DemoUser) -> AppResult<bool> {
        Ok(self.load_collaboration(deck_id)?.owner_id == user.id)
    }

    pub fn preferred_branch(&self, deck_id: &str, user: &DemoUser) -> AppResult<String> {
        let current = current_branch(&self.open_repo(deck_id)?)?;
        let acl = self.load_collaboration(deck_id)?;
        if acl.owner_id == user.id {
            return Ok(current);
        }
        let branches = acl.member_branches(&user.id);
        if branches.contains_key(&current) {
            return Ok(current);
        }
        branches
            .keys()
            .next()
            .cloned()
            .ok_or_else(|| AppError::Forbidden("you do not have access to any branches".into()))
    }

    pub fn deck_detail_for_user(&self, deck_id: &str, user: &DemoUser) -> AppResult<DeckDetail> {
        let branch = self.preferred_branch(deck_id, user)?;
        let repo = self.repo_for_branch(deck_id, &branch)?;
        self.deck_detail_from_repo(deck_id, &repo)
    }

    pub fn deck_detail_for_branch(&self, deck_id: &str, branch: &str) -> AppResult<DeckDetail> {
        let repo = self.repo_for_branch(deck_id, branch)?;
        self.deck_detail_from_repo(deck_id, &repo)
    }

    pub fn session_branch(&self, session_id: &str) -> AppResult<(String, String, DemoUser)> {
        let sessions = self.sessions.lock();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| AppError::NotFound("editing session not found".into()))?;
        Ok((
            session.info.deck_id.clone(),
            session.info.branch.clone(),
            session.actor.clone(),
        ))
    }

    pub fn require_deck_role(
        &self,
        deck_id: &str,
        user: &DemoUser,
        branch: &str,
        required: DeckRole,
    ) -> AppResult<()> {
        let role = self.deck_role(deck_id, &user.id, branch)?;
        let allowed = match required {
            DeckRole::View => role.is_some(),
            DeckRole::Comment => matches!(role, Some(DeckRole::Comment | DeckRole::Edit)),
            DeckRole::Edit => matches!(role, Some(DeckRole::Edit)),
        };
        if allowed {
            Ok(())
        } else {
            Err(AppError::Forbidden(
                "you do not have permission for this branch".into(),
            ))
        }
    }

    pub fn deck_collaboration(
        &self,
        deck_id: &str,
        actor: &DemoUser,
    ) -> AppResult<DeckCollaboration> {
        let data = self.load_collaboration(deck_id)?;
        let owner = self.demo_user(&data.owner_id)?;
        let owner_view = data.owner_id == actor.id;
        let visible_branches: HashSet<String> = if owner_view {
            HashSet::new()
        } else {
            let branches = data.member_branches(&actor.id);
            if branches.is_empty() {
                return Err(AppError::Forbidden(
                    "you are not a member of this presentation".into(),
                ));
            }
            branches.keys().cloned().collect()
        };
        let mut members = Vec::new();
        let effective = data.effective_members();
        for (user_id, branches) in &effective {
            let visible: BTreeMap<_, _> = if owner_view {
                branches.clone()
            } else {
                branches
                    .iter()
                    .filter(|(branch, _)| visible_branches.contains(*branch))
                    .map(|(branch, role)| (branch.clone(), role.clone()))
                    .collect()
            };
            if !visible.is_empty() {
                if let Ok(user) = self.demo_user(user_id) {
                    members.push(DeckMember {
                        user,
                        branches: visible,
                    });
                }
            }
        }
        Ok(DeckCollaboration { owner, members })
    }

    pub fn set_deck_member(
        &self,
        deck_id: &str,
        actor: &DemoUser,
        request: SetDeckMemberRequest,
    ) -> AppResult<DeckCollaboration> {
        let mut data = self.load_collaboration(deck_id)?;
        if data.owner_id != actor.id {
            return Err(AppError::Forbidden(
                "only the presentation creator can manage collaborators".into(),
            ));
        }
        let user = self.sign_in_demo_user(&request.username)?;
        self.open_repo(deck_id)?
            .find_branch(&request.branch, BranchType::Local)
            .map_err(|_| AppError::NotFound(format!("branch '{}' not found", request.branch)))?;
        if user.id == data.owner_id {
            return Err(AppError::BadRequest(
                "the presentation owner already has full access".into(),
            ));
        }
        data.members
            .entry(user.id.clone())
            .or_default()
            .insert(request.branch.clone(), request.role);
        for link in data
            .share_links
            .iter_mut()
            .filter(|link| link.branch == request.branch)
        {
            link.member_ids.remove(&user.id);
        }
        self.save_collaboration(deck_id, &data)?;
        self.deck_collaboration(deck_id, actor)
    }

    pub fn remove_deck_member(
        &self,
        deck_id: &str,
        actor: &DemoUser,
        username: &str,
        branch: &str,
    ) -> AppResult<DeckCollaboration> {
        let mut data = self.load_collaboration(deck_id)?;
        if data.owner_id != actor.id {
            return Err(AppError::Forbidden(
                "only the presentation creator can manage collaborators".into(),
            ));
        }
        let user = self.sign_in_demo_user(username)?;
        if let Some(branches) = data.members.get_mut(&user.id) {
            branches.remove(branch);
            if branches.is_empty() {
                data.members.remove(&user.id);
            }
        }
        for link in data
            .share_links
            .iter_mut()
            .filter(|link| link.branch == branch)
        {
            link.member_ids.remove(&user.id);
        }
        self.save_collaboration(deck_id, &data)?;
        self.deck_collaboration(deck_id, actor)
    }

    pub fn share_links(&self, deck_id: &str, actor: &DemoUser) -> AppResult<Vec<ShareLink>> {
        let data = self.load_collaboration(deck_id)?;
        if data.owner_id != actor.id {
            return Err(AppError::Forbidden(
                "only the presentation creator can manage share links".into(),
            ));
        }
        Ok(data
            .share_links
            .iter()
            .map(StoredShareLink::public)
            .collect())
    }

    pub fn create_share_link(
        &self,
        deck_id: &str,
        actor: &DemoUser,
        request: CreateShareLinkRequest,
    ) -> AppResult<ShareLink> {
        let mut data = self.load_collaboration(deck_id)?;
        if data.owner_id != actor.id {
            return Err(AppError::Forbidden(
                "only the presentation creator can manage share links".into(),
            ));
        }
        if data.share_links.len() >= 50 {
            return Err(AppError::BadRequest(
                "Revoke an existing link before creating more share links.".into(),
            ));
        }
        self.open_repo(deck_id)?
            .find_branch(&request.branch, BranchType::Local)
            .map_err(|_| AppError::NotFound("the selected branch no longer exists".into()))?;
        let link = StoredShareLink {
            id: format!("link_{}", Uuid::new_v4().simple()),
            token: Uuid::new_v4().simple().to_string(),
            branch: request.branch,
            role: request.role,
            created_at: now_secs(),
            member_ids: HashSet::new(),
        };
        let result = link.public();
        data.share_links.push(link);
        self.save_collaboration(deck_id, &data)?;
        Ok(result)
    }

    pub fn revoke_share_link(
        &self,
        deck_id: &str,
        actor: &DemoUser,
        link_id: &str,
    ) -> AppResult<()> {
        let mut data = self.load_collaboration(deck_id)?;
        if data.owner_id != actor.id {
            return Err(AppError::Forbidden(
                "only the presentation creator can manage share links".into(),
            ));
        }
        let previous = data.share_links.len();
        data.share_links.retain(|link| link.id != link_id);
        if previous == data.share_links.len() {
            return Err(AppError::NotFound("share link not found".into()));
        }
        self.save_collaboration(deck_id, &data)
    }

    pub fn share_link_preview(&self, deck_id: &str, token: &str) -> AppResult<ShareLinkPreview> {
        let unavailable =
            || AppError::NotFound("This sharing link is invalid or has been revoked.".into());
        if token.len() != 32 || !token.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(unavailable());
        }
        let data = self
            .load_collaboration(deck_id)
            .map_err(|_| unavailable())?;
        let link = data
            .share_links
            .iter()
            .find(|link| link.token == token)
            .ok_or_else(unavailable)?;
        let repo = self
            .repo_for_branch(deck_id, &link.branch)
            .map_err(|_| unavailable())?;
        let deck: Deck = read_json(&workdir(&repo)?.join("deck.json"))?;
        Ok(ShareLinkPreview {
            deck_id: deck_id.to_owned(),
            title: deck.title,
            branch: link.branch.clone(),
            role: link.role,
            owner: self.demo_user(&data.owner_id)?,
        })
    }

    pub fn join_share_link(
        &self,
        deck_id: &str,
        token: &str,
        actor: &DemoUser,
    ) -> AppResult<ShareLinkPreview> {
        let preview = self.share_link_preview(deck_id, token)?;
        let mut data = self.load_collaboration(deck_id)?;
        if data.owner_id == actor.id {
            return Ok(preview);
        }
        let link = data
            .share_links
            .iter_mut()
            .find(|link| link.token == token)
            .ok_or_else(|| {
                AppError::NotFound("This sharing link is invalid or has been revoked.".into())
            })?;
        if link.member_ids.insert(actor.id.clone()) {
            self.save_collaboration(deck_id, &data)?;
        }
        Ok(preview)
    }

    pub fn comments(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
    ) -> AppResult<Vec<ObjectComment>> {
        self.require_deck_role(deck_id, user, branch, DeckRole::View)?;
        Ok(self
            .load_collaboration(deck_id)?
            .comments
            .into_iter()
            .filter(|comment| comment.branch == branch)
            .map(|comment| comment.comment)
            .collect())
    }

    pub fn add_comment(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        request: CreateObjectCommentRequest,
    ) -> AppResult<ObjectComment> {
        self.require_deck_role(deck_id, user, branch, DeckRole::Comment)?;
        let message = request.message.trim();
        if message.is_empty() || message.chars().count() > 500 {
            return Err(AppError::BadRequest(
                "comment messages must be 1-500 characters".into(),
            ));
        }
        let mut data = self.load_collaboration(deck_id)?;
        let repo = self.repo_for_branch(deck_id, branch)?;
        let slide = self
            .read_slide_from_repo(deck_id, &request.slide_id, &repo)?
            .slide;
        if !slide.elements.contains_key(&request.object_id) {
            return Err(AppError::NotFound(
                "object not found on the requested slide".into(),
            ));
        }
        let existing_parent = if let Some(parent_id) = request.parent_id.as_deref() {
            let parent = data
                .comments
                .iter()
                .find(|entry| {
                    entry.branch == branch
                        && entry.slide_id == request.slide_id
                        && entry.comment.id == parent_id
                        && entry.object_id == request.object_id
                })
                .ok_or_else(|| AppError::NotFound("parent comment not found".into()))?;
            if parent.comment.parent_id.is_some() {
                return Err(AppError::BadRequest(
                    "replies must attach to the thread's root comment".into(),
                ));
            }
            Some(parent.root_id.clone())
        } else {
            None
        };
        if let Some(root_id) = existing_parent.as_deref() {
            let thread_count = data
                .comments
                .iter()
                .filter(|entry| {
                    entry.branch == branch
                        && entry.slide_id == request.slide_id
                        && entry.object_id == request.object_id
                        && entry.root_id == root_id
                })
                .count();
            if thread_count >= 25 {
                return Err(AppError::Conflict(
                    "this comment thread has reached its 25 message limit".into(),
                ));
            }
        }
        let now = now_secs();
        let root_id = existing_parent.unwrap_or_else(|| Uuid::new_v4().to_string());
        let comment = ObjectComment {
            id: Uuid::new_v4().to_string(),
            slide_id: request.slide_id.clone(),
            object_id: request.object_id.clone(),
            author: user.clone(),
            message: message.into(),
            parent_id: request.parent_id,
            created_at: now,
            updated_at: now,
        };
        data.comments.push(StoredComment {
            branch: branch.into(),
            slide_id: request.slide_id,
            object_id: request.object_id,
            root_id,
            comment: comment.clone(),
        });
        self.save_collaboration(deck_id, &data)?;
        Ok(comment)
    }

    pub fn update_comment(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        comment_id: &str,
        message: &str,
    ) -> AppResult<ObjectComment> {
        self.require_deck_role(deck_id, user, branch, DeckRole::Comment)?;
        let message = message.trim();
        if message.is_empty() || message.chars().count() > 500 {
            return Err(AppError::BadRequest(
                "comment messages must be 1-500 characters".into(),
            ));
        }
        let mut data = self.load_collaboration(deck_id)?;
        let entry = data
            .comments
            .iter_mut()
            .find(|entry| entry.branch == branch && entry.comment.id == comment_id)
            .ok_or_else(|| AppError::NotFound("comment not found".into()))?;
        if entry.comment.author.id != user.id {
            return Err(AppError::Forbidden(
                "you can only edit your own comments".into(),
            ));
        }
        entry.comment.message = message.into();
        entry.comment.updated_at = now_secs();
        let result = entry.comment.clone();
        self.save_collaboration(deck_id, &data)?;
        Ok(result)
    }

    pub fn delete_comment(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        comment_id: &str,
    ) -> AppResult<()> {
        self.require_deck_role(deck_id, user, branch, DeckRole::Comment)?;
        let mut data = self.load_collaboration(deck_id)?;
        let owner = data.owner_id == user.id;
        let entry = data
            .comments
            .iter()
            .find(|entry| entry.branch == branch && entry.comment.id == comment_id)
            .ok_or_else(|| AppError::NotFound("comment not found".into()))?;
        if !owner && entry.comment.author.id != user.id {
            return Err(AppError::Forbidden(
                "you can only delete your own comments".into(),
            ));
        }
        let root_id = entry.root_id.clone();
        if entry.comment.parent_id.is_none() {
            data.comments
                .retain(|entry| !(entry.branch == branch && entry.root_id == root_id));
        } else {
            data.comments
                .retain(|entry| !(entry.branch == branch && entry.comment.id == comment_id));
        }
        self.save_collaboration(deck_id, &data)
    }

    pub fn acquire_object_locks(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        object_ids: &[String],
    ) -> AppResult<Vec<String>> {
        self.acquire_session_locks(deck_id, branch, user, None, object_ids)
    }

    pub fn acquire_session_locks(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        session_id: Option<&str>,
        object_ids: &[String],
    ) -> AppResult<Vec<String>> {
        self.require_deck_role(deck_id, user, branch, DeckRole::Edit)?;
        self.validate_session_actor(deck_id, session_id, user)?;
        if let Some(session) = session_id {
            if self.session_branch(session)?.1 != branch {
                return Err(AppError::BadRequest(
                    "session belongs to another branch".into(),
                ));
            }
        }
        let mut locks = self.object_locks.lock();
        let now = Instant::now();
        locks.retain(|_, (_, _, expiry)| *expiry > now);
        let mut acquired = Vec::new();
        for object_id in object_ids {
            let key = (deck_id.to_owned(), branch.to_owned(), object_id.clone());
            match locks.get_mut(&key) {
                Some((owner, session, expiry))
                    if owner == &user.id && session.as_deref() == session_id =>
                {
                    *expiry = now + Duration::from_secs(15);
                    acquired.push(object_id.clone());
                }
                Some(_) => {}
                None => {
                    locks.insert(
                        key,
                        (
                            user.id.clone(),
                            session_id.map(str::to_owned),
                            now + Duration::from_secs(15),
                        ),
                    );
                    acquired.push(object_id.clone());
                }
            }
        }
        Ok(acquired)
    }

    pub fn release_object_locks(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        object_ids: &[String],
    ) {
        self.release_session_locks(deck_id, branch, user, None, object_ids);
    }

    pub fn release_session_locks(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        session_id: Option<&str>,
        object_ids: &[String],
    ) {
        let mut locks = self.object_locks.lock();
        for object_id in object_ids {
            let key = (deck_id.to_owned(), branch.to_owned(), object_id.clone());
            if locks.get(&key).is_some_and(|(owner, session, _)| {
                owner == &user.id && session.as_deref() == session_id
            }) {
                locks.remove(&key);
            }
        }
    }

    pub fn owns_object_locks(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        session_id: Option<&str>,
        ids: &[String],
    ) -> bool {
        let locks = self.object_locks.lock();
        let now = Instant::now();
        ids.iter().all(|id| {
            locks
                .get(&(deck_id.to_owned(), branch.to_owned(), id.clone()))
                .is_some_and(|(owner, session, expiry)| {
                    owner == &user.id && session.as_deref() == session_id && *expiry > now
                })
        })
    }

    pub fn release_user_object_locks(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
    ) -> Vec<String> {
        let mut locks = self.object_locks.lock();
        let keys: Vec<_> = locks
            .iter()
            .filter(|((deck, room, _), (owner, _, _))| {
                deck == deck_id && room == branch && owner == &user.id
            })
            .map(|(key, _)| key.clone())
            .collect();
        let ids = keys.iter().map(|(_, _, id)| id.clone()).collect();
        for key in keys {
            locks.remove(&key);
        }
        ids
    }

    pub fn ensure_no_foreign_locks(
        &self,
        deck: &str,
        branch: &str,
        actor: &DemoUser,
        session: Option<&str>,
        objects: Option<&Slide>,
    ) -> AppResult<()> {
        let locks = self.object_locks.lock();
        if locks
            .iter()
            .any(|((id, room, object), (owner, owning_session, expiry))| {
                id == deck
                    && room == branch
                    && *expiry > Instant::now()
                    && (owner != &actor.id || owning_session.as_deref() != session)
                    && objects.map_or(true, |slide| slide.elements.contains_key(object))
            })
        {
            return Err(AppError::Conflict(
                "Another editor is working on these objects. Try again after they finish.".into(),
            ));
        }
        Ok(())
    }

    pub fn live_presence_snapshot(
        &self,
        deck_id: &str,
        branch: &str,
        except_connection: &str,
    ) -> Vec<serde_json::Value> {
        let rooms = self.live_presence.lock();
        rooms
            .get(&(deck_id.to_owned(), branch.to_owned()))
            .into_iter()
            .flat_map(|users| users.iter())
            .filter(|(connection, _)| connection.as_str() != except_connection)
            .map(|(_, (_, state))| state.clone())
            .collect()
    }

    pub fn set_live_presence(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        connection_id: &str,
        event: serde_json::Value,
    ) {
        self.live_presence
            .lock()
            .entry((deck_id.to_owned(), branch.to_owned()))
            .or_default()
            .insert(connection_id.to_owned(), (user.id.clone(), event));
    }

    pub fn remove_live_presence(
        &self,
        deck_id: &str,
        branch: &str,
        user: &DemoUser,
        connection_id: &str,
    ) -> bool {
        let mut rooms = self.live_presence.lock();
        if let Some(users) = rooms.get_mut(&(deck_id.to_owned(), branch.to_owned())) {
            if users
                .get(connection_id)
                .is_some_and(|(owner, _)| owner == &user.id)
            {
                users.remove(connection_id);
            } else {
                return false;
            }
            if users.is_empty() {
                rooms.remove(&(deck_id.to_owned(), branch.to_owned()));
            }
            return true;
        }
        false
    }

    pub fn active_object_locks(
        &self,
        deck_id: &str,
        branch: &str,
    ) -> Vec<(DemoUser, String, Option<String>)> {
        let snapshot: Vec<_> = {
            let mut locks = self.object_locks.lock();
            let now = Instant::now();
            locks.retain(|_, (_, _, expiry)| *expiry > now);
            locks
                .iter()
                .filter(|((deck, room, _), _)| deck == deck_id && room == branch)
                .map(|((_, _, id), (owner, session, _))| {
                    (owner.clone(), id.clone(), session.clone())
                })
                .collect()
        };
        snapshot
            .into_iter()
            .filter_map(|(owner, id, session)| {
                self.demo_user(&owner).ok().map(|user| (user, id, session))
            })
            .collect()
    }

    // Apply only the caller's delta to the latest slide, inside write_lock.
    // Comparing against its base prevents a stale tab from replacing another edit.
    pub fn rebase_slide_write(
        &self,
        deck_id: &str,
        slide_id: &str,
        mut req: WriteSlideRequest,
    ) -> AppResult<WriteSlideRequest> {
        let Some(mut base) = req.base_slide.take() else {
            return Ok(req);
        };
        if base.id != slide_id || req.slide.id != slide_id {
            return Err(AppError::BadRequest(
                "slide id does not match its base".into(),
            ));
        }
        let repo = match req.session_id.as_deref() {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(deck_id)?,
        };
        let dir = slide_dir(workdir(&repo)?, slide_id)?;
        let mut current: Slide = read_json(&dir.join("slide.json"))?;
        normalize_slide_for_storage(&mut base, deck_id, slide_id);
        normalize_slide_for_storage(&mut current, deck_id, slide_id);
        normalize_slide_for_storage(&mut req.slide, deck_id, slide_id);
        let ids: HashSet<_> = base
            .elements
            .keys()
            .chain(req.slide.elements.keys())
            .cloned()
            .collect();
        for id in ids {
            let before = base.elements.get(&id);
            let incoming = req.slide.elements.get(&id);
            if before == incoming {
                continue;
            }
            let latest = current.elements.get(&id);
            if latest != before && latest != incoming {
                return Err(AppError::Conflict(format!(
                    "object '{id}' changed in another editor; your local edit has been kept"
                )));
            }
            match incoming {
                Some(element) => {
                    current.elements.insert(id, element.clone());
                }
                None => {
                    current.elements.remove(&id);
                }
            }
        }
        macro_rules! merge_field {
            ($field:ident) => {
                if req.slide.$field != base.$field {
                    if current.$field != base.$field && current.$field != req.slide.$field {
                        return Err(AppError::Conflict(
                            concat!(
                                stringify!($field),
                                " changed in another editor; your local edit has been kept"
                            )
                            .into(),
                        ));
                    }
                    current.$field = req.slide.$field.clone();
                }
            };
        }
        merge_field!(name);
        merge_field!(background);
        merge_field!(version);
        merge_field!(animations);
        merge_field!(transition);
        if let (Some(incoming), Some(base_notes)) = (&req.notes, &req.base_notes) {
            let latest = fs::read_to_string(dir.join("notes.md")).unwrap_or_default();
            if &latest != base_notes && &latest != incoming {
                return Err(AppError::Conflict(
                    "Notes changed in another editor; your local notes have been kept".into(),
                ));
            }
        }
        req.slide = current;
        Ok(req)
    }

    pub fn assert_slide_locks(
        &self,
        deck_id: &str,
        slide_id: &str,
        session_id: Option<&str>,
        user: &DemoUser,
        candidate: &Slide,
    ) -> AppResult<()> {
        let branch = match session_id {
            Some(session) => self.session_branch(session)?.1,
            None => self.preferred_branch(deck_id, user)?,
        };
        self.require_deck_role(deck_id, user, &branch, DeckRole::Edit)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.repo_for_branch(deck_id, &branch)?,
        };
        let mut old: Slide = read_json(&slide_dir(workdir(&repo)?, slide_id)?.join("slide.json"))?;
        let mut candidate = candidate.clone();
        normalize_slide_for_storage(&mut old, deck_id, slide_id);
        normalize_slide_for_storage(&mut candidate, deck_id, slide_id);
        let locks = self.object_locks.lock();
        let now = Instant::now();
        for (id, element) in &old.elements {
            if candidate.elements.get(id) == Some(element) {
                continue;
            }
            let owned = locks
                .get(&(deck_id.to_owned(), branch.clone(), id.clone()))
                .is_some_and(|(owner, session, expiry)| {
                    owner == &user.id && session.as_deref() == session_id && *expiry > now
                });
            if !owned {
                return Err(AppError::Conflict(format!(
                    "object '{id}' is not locked by you; select it before editing"
                )));
            }
        }
        Ok(())
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

    fn repo_for_branch(&self, deck_id: &str, branch: &str) -> AppResult<Repository> {
        let root = self.open_repo(deck_id)?;
        if branch == "main" {
            return Ok(root);
        }
        let reference = root
            .find_branch(branch, BranchType::Local)
            .map_err(|_| AppError::NotFound(format!("branch '{branch}' not found")))?;
        let room_root = self.decks_root.join(".worktrees").join(deck_id);
        fs::create_dir_all(&room_root)?;
        let key = worktree_name(&room_root, branch);
        let path = room_root.join(&key);
        if !path.exists() {
            let mut opts = git2::WorktreeAddOptions::new();
            opts.reference(Some(reference.get()));
            root.worktree(&key, &path, Some(&opts))?;
        }
        Repository::open(path).map_err(Into::into)
    }

    pub fn repo_for_session(&self, session_id: &str) -> AppResult<Repository> {
        let info = {
            let sessions = self.sessions.lock();
            sessions
                .get(session_id)
                .map(|session| session.info.clone())
                .ok_or_else(|| AppError::BadRequest("unknown or expired session".into()))?
        };
        self.repo_for_branch(&info.deck_id, &info.branch)
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

    pub fn list_decks_for_user(&self, actor: &DemoUser) -> AppResult<Vec<DeckSummary>> {
        let mut visible = Vec::new();
        for mut deck in self.list_decks()? {
            let acl = match self.load_collaboration(&deck.id) {
                Ok(acl) => acl,
                Err(_) => continue,
            };
            let effective = acl.effective_members();
            let branches = effective.get(&actor.id);
            let is_owner = acl.owner_id == actor.id;
            let role = if is_owner {
                Some(DeckRole::Edit)
            } else {
                branches
                    .and_then(|map| map.get(&deck.current_branch))
                    .cloned()
                    .or_else(|| branches.and_then(|map| map.values().next().cloned()))
            };
            if role.is_none() {
                continue;
            }
            deck.current_user_role = role;
            deck.is_owner = is_owner;
            if !is_owner
                && branches
                    .and_then(|map| map.get(&deck.current_branch))
                    .is_none()
            {
                if let Some((branch, _)) = branches.and_then(|map| map.iter().next()) {
                    deck.current_branch = branch.clone();
                    if let Ok(repo) = self.repo_for_branch(&deck.id, branch) {
                        if let Ok(manifest) = read_json::<Deck>(&workdir(&repo)?.join("deck.json"))
                        {
                            deck.first_slide_id = manifest.slides.first().cloned();
                        }
                    }
                }
            }
            let mut collaborators = Vec::new();
            for user_id in effective.keys().chain(std::iter::once(&acl.owner_id)) {
                if let Ok(user) = self.demo_user(user_id) {
                    collaborators.push(user);
                }
            }
            deck.collaborators = collaborators;
            visible.push(deck);
        }
        Ok(visible)
    }

    fn deck_summary(&self, id: &str) -> AppResult<DeckSummary> {
        let repo = self.open_repo(id)?;
        let deck: Deck = read_json(&workdir(&repo)?.join("deck.json"))?;
        let (branch, updated_at) = head_info(&repo)?;
        let first_slide_id = deck.slides.first().cloned();
        let owner_id = self
            .load_collaboration(id)
            .map(|acl| acl.owner_id)
            .unwrap_or_default();
        let collaborators = self
            .demo_users()
            .unwrap_or_default()
            .into_iter()
            .filter(|user| user.id == owner_id)
            .collect();
        Ok(DeckSummary {
            id: id.to_string(),
            title: deck.title,
            slide_count: deck.slides.len(),
            current_branch: branch,
            updated_at,
            dirty: repo_dirty(&repo)?,
            current_user_role: None,
            is_owner: false,
            collaborators,
            first_slide_id,
        })
    }

    pub fn create_deck(&self, req: CreateDeckRequest) -> AppResult<DeckDetail> {
        self.create_deck_inner(req, None)
    }

    pub fn create_deck_as(
        &self,
        req: CreateDeckRequest,
        actor: &DemoUser,
    ) -> AppResult<DeckDetail> {
        self.create_deck_inner(req, Some(actor))
    }

    fn create_deck_inner(
        &self,
        req: CreateDeckRequest,
        actor: Option<&DemoUser>,
    ) -> AppResult<DeckDetail> {
        let title = req.title.trim();
        if title.is_empty() {
            return Err(AppError::BadRequest("title is required".into()));
        }
        let template_id = req.template_id.as_deref().unwrap_or("starter");
        let template_bundle = match req.template_bundle {
            Some(bundle) => Some(bundle),
            None if matches!(template_id, "starter" | "blank") => None,
            None => Some(
                self.template_bundle(template_id)
                    .map_err(|_| AppError::BadRequest("unknown repository template".into()))?,
            ),
        };
        if let Some(bundle) = template_bundle.as_ref() {
            validate_template_bundle(bundle)?;
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
        if let Some(bundle) = template_bundle {
            seed_bundle_deck(&path, &id, title, &bundle)?;
        } else {
            match template_id {
                "starter" => seed_deck(&path, &id, title)?,
                "blank" => seed_blank_deck(&path, title)?,
                _ => unreachable!(),
            }
        }

        match actor {
            Some(actor) => commit_all_as(&repo, "Initialize deck", &[], actor)?,
            None => commit_all(&repo, "Initialize deck", &[])?,
        };
        let owner = actor.cloned().unwrap_or(DemoUser {
            id: "usr_system".into(),
            username: "system".into(),
            display_name: "Present".into(),
        });
        self.save_collaboration(
            &id,
            &DeckCollaborationFile {
                owner_id: owner.id,
                members: HashMap::new(),
                comments: Vec::new(),
                share_links: Vec::new(),
            },
        )?;
        self.deck_detail(&id)
    }

    pub fn template_bundles(&self) -> AppResult<Vec<TemplateBundleSummary>> {
        let dir = self.decks_root.join(".template-library");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut bundles = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Ok(bundle) = read_json::<TemplateBundle>(&entry.path()) {
                bundles.push(bundle);
            }
        }
        bundles.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(bundles.iter().map(TemplateBundleSummary::from).collect())
    }

    pub fn template_bundle(&self, template_id: &str) -> AppResult<TemplateBundle> {
        if !valid_id(template_id) {
            return Err(AppError::BadRequest("invalid template id".into()));
        }
        read_json(
            &self
                .decks_root
                .join(".template-library")
                .join(format!("{template_id}.json")),
        )
        .map_err(|_| AppError::NotFound("template bundle not found".into()))
    }

    pub fn save_template_bundle(&self, mut bundle: TemplateBundle) -> AppResult<TemplateBundle> {
        if bundle.id.trim().is_empty() {
            bundle.id = format!("tpl_{}", &short_id()[..8]);
        }
        validate_template_bundle(&bundle)?;
        let dir = self.decks_root.join(".template-library");
        fs::create_dir_all(&dir)?;
        write_json_atomic(&dir.join(format!("{}.json", bundle.id)), &bundle)?;
        Ok(bundle)
    }

    pub fn delete_template_bundle(&self, template_id: &str) -> AppResult<()> {
        if !valid_id(template_id) {
            return Err(AppError::BadRequest("invalid template id".into()));
        }
        let path = self
            .decks_root
            .join(".template-library")
            .join(format!("{template_id}.json"));
        fs::remove_file(path)
            .map_err(|_| AppError::NotFound("template bundle not found".into()))?;
        Ok(())
    }

    pub fn deck_template_bundle(
        &self,
        id: &str,
        session_id: Option<&str>,
    ) -> AppResult<Option<TemplateBundle>> {
        self.validate_session(id, session_id)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        read_json_opt::<TemplateBundle>(&workdir(&repo)?.join(".present/template-bundle.json"))
    }

    pub fn delete_deck(&self, id: &str) -> AppResult<()> {
        let actor = DemoUser {
            id: "usr_system".into(),
            username: "system".into(),
            display_name: "Present".into(),
        };
        self.delete_deck_as(id, &actor)
    }

    pub fn delete_deck_as(&self, id: &str, actor: &DemoUser) -> AppResult<()> {
        let acl = self.load_collaboration(id)?;
        if acl.owner_id != actor.id {
            return Err(AppError::Forbidden(
                "only the presentation creator can delete it".into(),
            ));
        }
        if self.sessions.lock().values().any(|s| s.info.deck_id == id) {
            return Err(AppError::Conflict(
                "close the deck's active editor sessions before deleting it".into(),
            ));
        }
        let path = self.deck_path(id)?;
        if !path.is_dir() {
            return Err(AppError::NotFound(format!("deck '{id}' not found")));
        }
        fs::remove_dir_all(path)?;
        let _ = fs::remove_file(self.collaboration_path(id)?);
        let rooms = self.decks_root.join(".worktrees").join(id);
        if rooms.exists() {
            fs::remove_dir_all(rooms)?;
        }
        Ok(())
    }

    pub fn deck_detail(&self, id: &str) -> AppResult<DeckDetail> {
        let repo = self.open_repo(id)?;
        self.deck_detail_from_repo(id, &repo)
    }

    pub fn session_deck_detail(&self, id: &str, session_id: &str) -> AppResult<DeckDetail> {
        self.validate_session(id, Some(session_id))?;
        let info = {
            let sessions = self.sessions.lock();
            sessions
                .get(session_id)
                .map(|session| session.info.clone())
                .ok_or_else(|| AppError::BadRequest("unknown or expired session".into()))?
        };
        let repo = self.repo_for_branch(id, &info.branch)?;
        self.deck_detail_from_repo(id, &repo)
    }

    fn deck_detail_from_repo(&self, id: &str, repo: &Repository) -> AppResult<DeckDetail> {
        let workdir = workdir(repo)?.to_path_buf();
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
        let current_branch = current_branch(repo)?;
        let mut branches = self.branches(id)?;
        for branch in &mut branches {
            branch.is_current = branch.name == current_branch;
        }
        Ok(DeckDetail {
            id: id.to_string(),
            deck,
            slides,
            current_branch,
            branches,
            dirty: repo_dirty(repo)?,
        })
    }

    pub fn slide_templates(
        &self,
        id: &str,
        session_id: Option<&str>,
    ) -> AppResult<Vec<SlideTemplate>> {
        self.validate_session(id, session_id)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        let templates_dir = workdir(&repo)?.join(".present/templates/slides");
        if !templates_dir.exists() {
            return Ok(Vec::new());
        }
        let mut templates = Vec::new();
        for entry in fs::read_dir(templates_dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(template) = read_json::<SlideTemplate>(&entry.path()) {
                templates.push(template);
            }
        }
        templates.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(templates)
    }

    pub fn save_slide_template(
        &self,
        id: &str,
        req: SaveSlideTemplateRequest,
        session_id: Option<&str>,
        actor: &DemoUser,
    ) -> AppResult<SlideTemplate> {
        let name = req.name.trim();
        if name.is_empty() {
            return Err(AppError::BadRequest("template name is required".into()));
        }
        self.validate_session_actor(id, session_id, actor)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        let dir = workdir(&repo)?.join(".present/templates/slides");
        fs::create_dir_all(&dir)?;
        let template = SlideTemplate {
            id: format!("tpl_{}", &short_id()[..8]),
            name: name.to_string(),
            slide: req.slide,
        };
        write_json_atomic(&dir.join(format!("{}.json", template.id)), &template)?;
        self.record_semantic_edit(id, session_id, &template.id, 1, actor)?;
        Ok(template)
    }

    pub fn delete_slide_template(
        &self,
        id: &str,
        template_id: &str,
        session_id: Option<&str>,
        actor: &DemoUser,
    ) -> AppResult<()> {
        if !valid_id(template_id) {
            return Err(AppError::BadRequest("invalid template id".into()));
        }
        self.validate_session_actor(id, session_id, actor)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        let path = workdir(&repo)?
            .join(".present/templates/slides")
            .join(format!("{template_id}.json"));
        fs::remove_file(&path)
            .map_err(|_| AppError::NotFound("slide template not found".into()))?;
        self.record_semantic_edit(id, session_id, template_id, 1, actor)?;
        Ok(())
    }

    pub fn update_deck(
        &self,
        id: &str,
        req: UpdateDeckRequest,
        actor: &DemoUser,
    ) -> AppResult<DeckDetail> {
        self.validate_session_actor(id, req.session_id.as_deref(), actor)?;
        let repo = match req.session_id.as_deref() {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        let workdir = workdir(&repo)?.to_path_buf();
        let path = workdir.join("deck.json");
        let mut deck: Deck = read_json(&path)?;
        let mut changed = false;
        if let Some(title) = req.title {
            let title = title.trim();
            if title.is_empty() {
                return Err(AppError::BadRequest("title cannot be empty".into()));
            }
            if deck.title != title {
                deck.title = title.to_string();
                changed = true;
            }
        }
        if let Some(tokens) = req.tokens {
            if deck.tokens != tokens {
                deck.tokens = tokens;
                changed = true;
            }
        }
        write_json_atomic(&path, &deck)?;
        if changed {
            self.touch_session(req.session_id.as_deref());
            self.record_semantic_edit(id, req.session_id.as_deref(), "__deck__", 1, actor)?;
        }
        match req.session_id.as_deref() {
            Some(session) => self.session_deck_detail(id, session),
            None => self.deck_detail(id),
        }
    }

    pub fn read_slide(&self, id: &str, slide_id: &str) -> AppResult<SlidePayload> {
        let repo = self.open_repo(id)?;
        self.read_slide_from_repo(id, slide_id, &repo)
    }

    pub fn read_slide_for_branch(
        &self,
        id: &str,
        slide_id: &str,
        branch: &str,
        actor: &DemoUser,
    ) -> AppResult<SlidePayload> {
        self.require_deck_role(id, actor, branch, DeckRole::View)?;
        let repo = self.repo_for_branch(id, branch)?;
        let mut payload = self.read_slide_from_repo(id, slide_id, &repo)?;
        for asset in &mut payload.assets {
            asset.url = asset_url_in_context(id, slide_id, &asset.name, branch, actor);
        }
        rewrite_local_asset_sources(&mut payload.slide, id, slide_id, branch, actor);
        Ok(payload)
    }

    pub fn read_slide_for_session(
        &self,
        id: &str,
        slide_id: &str,
        session_id: &str,
    ) -> AppResult<SlidePayload> {
        self.validate_session(id, Some(session_id))?;
        let (branch, actor) = {
            let sessions = self.sessions.lock();
            let session = sessions
                .get(session_id)
                .ok_or_else(|| AppError::BadRequest("unknown or expired session".into()))?;
            (session.info.branch.clone(), session.actor.clone())
        };
        let repo = self.repo_for_session(session_id)?;
        let mut payload = self.read_slide_from_repo(id, slide_id, &repo)?;
        for asset in &mut payload.assets {
            asset.url = asset_url_in_context(id, slide_id, &asset.name, &branch, &actor);
        }
        rewrite_local_asset_sources(&mut payload.slide, id, slide_id, &branch, &actor);
        Ok(payload)
    }

    fn read_slide_from_repo(
        &self,
        id: &str,
        slide_id: &str,
        repo: &Repository,
    ) -> AppResult<SlidePayload> {
        let workdir = workdir(repo)?;
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
        mut req: WriteSlideRequest,
        actor: &DemoUser,
    ) -> AppResult<SlidePayload> {
        if req.slide.id != slide_id {
            return Err(AppError::BadRequest(
                "slide id in body does not match route".into(),
            ));
        }
        self.validate_session_actor(id, req.session_id.as_deref(), actor)?;
        let repo = match req.session_id.as_deref() {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        let workdir = workdir(&repo)?;
        let deck: Deck = read_json(&workdir.join("deck.json"))?;
        if !deck.slides.iter().any(|s| s == slide_id) {
            return Err(AppError::NotFound(format!(
                "slide '{slide_id}' not in deck"
            )));
        }
        let dir = slide_dir(workdir, slide_id)?;
        if let (Some(incoming), Some(base_notes)) = (&req.notes, &req.base_notes) {
            let latest = fs::read_to_string(dir.join("notes.md")).unwrap_or_default();
            if &latest != base_notes && &latest != incoming {
                return Err(AppError::Conflict(
                    "Notes changed in another editor; your local notes have been kept".into(),
                ));
            }
        }
        let mut previous: Slide = read_json(&dir.join("slide.json"))?;
        normalize_slide_for_storage(&mut previous, id, slide_id);
        normalize_slide_for_storage(&mut req.slide, id, slide_id);
        if previous != req.slide {
            let old_ids: HashSet<_> = previous.elements.keys().collect();
            let new_ids: HashSet<_> = req.slide.elements.keys().collect();
            let structural_changes =
                old_ids.difference(&new_ids).count() + new_ids.difference(&old_ids).count();
            let weight = (structural_changes * 5
                + usize::from(previous.elements.iter().any(|(key, value)| {
                    req.slide
                        .elements
                        .get(key)
                        .is_some_and(|next| next != value)
                })))
            .max(1);
            self.record_semantic_edit(id, req.session_id.as_deref(), slide_id, weight, actor)?;
            write_json_atomic(&dir.join("slide.json"), &req.slide)?;
        }
        if let Some(notes) = req.notes {
            let path = dir.join("notes.md");
            if fs::read_to_string(&path).unwrap_or_default() != notes {
                self.record_semantic_edit(id, req.session_id.as_deref(), slide_id, 1, actor)?;
                write_atomic(&path, notes.as_bytes())?;
            }
        }
        self.touch_session(req.session_id.as_deref());
        self.read_slide_from_repo(id, slide_id, &repo)
    }

    pub fn write_notes(
        &self,
        id: &str,
        slide_id: &str,
        req: WriteNotesRequest,
        actor: &DemoUser,
    ) -> AppResult<SlidePayload> {
        self.validate_session_actor(id, req.session_id.as_deref(), actor)?;
        let repo = match req.session_id.as_deref() {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        let workdir = workdir(&repo)?;
        let dir = slide_dir(workdir, slide_id)?;
        let path = dir.join("notes.md");
        let previous = fs::read_to_string(&path).unwrap_or_default();
        if req
            .base_notes
            .as_ref()
            .is_some_and(|base| base != &previous && req.notes != previous)
        {
            return Err(AppError::Conflict(
                "Notes changed in another editor; your local notes have been kept".into(),
            ));
        }
        if previous != req.notes {
            self.record_semantic_edit(id, req.session_id.as_deref(), slide_id, 1, actor)?;
        }
        write_atomic(&path, req.notes.as_bytes())?;
        self.touch_session(req.session_id.as_deref());
        self.read_slide_from_repo(id, slide_id, &repo)
    }

    pub fn create_slide(
        &self,
        id: &str,
        req: CreateSlideRequest,
        actor: &DemoUser,
    ) -> AppResult<SlidePayload> {
        self.validate_session_actor(id, req.session_id.as_deref(), actor)?;
        let repo = match req.session_id.as_deref() {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
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
        let mut slide = if let Some(template) = req.template {
            template
        } else {
            let name = req
                .name
                .clone()
                .unwrap_or_else(|| format!("Slide {}", deck.slides.len() + 1));
            let mut slide = Slide::blank(&slide_id, &name);
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
                    text: Some(name),
                    style,
                    ..Default::default()
                },
            );
            slide
        };
        if let Some(name) = req.name {
            slide.name = name;
        }
        slide.id = slide_id.clone();
        let old_elements = std::mem::take(&mut slide.elements);
        for (_, mut element) in old_elements {
            let element_id = format!("el_{}", &short_id()[..8]);
            element.id = element_id.clone();
            slide.elements.insert(element_id, element);
        }

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
        self.record_semantic_edit(id, req.session_id.as_deref(), &slide_id, 10, actor)?;
        self.read_slide_from_repo(id, &slide_id, &repo)
    }

    pub fn delete_slide(
        &self,
        id: &str,
        slide_id: &str,
        session_id: Option<&str>,
        actor: &DemoUser,
    ) -> AppResult<DeckDetail> {
        self.validate_session_actor(id, session_id, actor)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
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
        self.record_semantic_edit(id, session_id, slide_id, 10, actor)?;
        let dir = workdir.join("slides").join(slide_id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        match session_id {
            Some(session) => self.session_deck_detail(id, session),
            None => self.deck_detail(id),
        }
    }

    pub fn reorder_slides(
        &self,
        id: &str,
        req: ReorderRequest,
        actor: &DemoUser,
    ) -> AppResult<DeckDetail> {
        self.validate_session_actor(id, req.session_id.as_deref(), actor)?;
        let repo = match req.session_id.as_deref() {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        let workdir = workdir(&repo)?;
        let deck_path = workdir.join("deck.json");
        let mut deck: Deck = read_json(&deck_path)?;
        let previous_order = deck.slides.clone();
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
        if deck.slides != previous_order {
            let changed: Vec<_> = deck
                .slides
                .iter()
                .enumerate()
                .filter(|(index, slide)| previous_order.get(*index) != Some(*slide))
                .map(|(_, slide)| slide.clone())
                .collect();
            for (index, slide_id) in changed.iter().enumerate() {
                self.record_semantic_edit(
                    id,
                    req.session_id.as_deref(),
                    slide_id,
                    if index == 0 { 10 } else { 0 },
                    actor,
                )?;
            }
        }
        match req.session_id.as_deref() {
            Some(session) => self.session_deck_detail(id, session),
            None => self.deck_detail(id),
        }
    }

    pub fn list_assets(
        &self,
        id: &str,
        slide_id: &str,
        session_id: Option<&str>,
    ) -> AppResult<Vec<AssetInfo>> {
        self.validate_session(id, session_id)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        list_assets(workdir(&repo)?, id, slide_id)
    }

    pub fn upload_asset(
        &self,
        id: &str,
        slide_id: &str,
        filename: &str,
        bytes: &[u8],
        session_id: Option<&str>,
        actor: &DemoUser,
    ) -> AppResult<AssetInfo> {
        self.validate_session_actor(id, session_id, actor)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
        let workdir = workdir(&repo)?;
        let dir = slide_dir(workdir, slide_id)?;
        let name = sanitize_asset_name(filename)?;
        let path = dir.join("assets").join(&name);
        write_atomic(&path, bytes)?;
        if let Some(session) = session_id {
            self.touch_session(Some(session));
        }
        self.record_semantic_edit(id, session_id, slide_id, 1, actor)?;
        Ok(AssetInfo {
            name: name.clone(),
            url: asset_url(id, slide_id, &name),
        })
    }

    pub fn read_asset(
        &self,
        id: &str,
        slide_id: &str,
        name: &str,
        session_id: Option<&str>,
    ) -> AppResult<(Vec<u8>, String)> {
        self.validate_session(id, session_id)?;
        let repo = match session_id {
            Some(session) => self.repo_for_session(session)?,
            None => self.open_repo(id)?,
        };
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

    pub fn asset_branch(&self, id: &str, session_id: Option<&str>) -> AppResult<String> {
        if let Some(session_id) = session_id {
            self.validate_session(id, Some(session_id))?;
            let sessions = self.sessions.lock();
            return sessions
                .get(session_id)
                .map(|session| session.info.branch.clone())
                .ok_or_else(|| AppError::BadRequest("unknown or expired session".into()));
        }
        current_branch(&self.open_repo(id)?)
    }

    pub fn read_asset_for_branch(
        &self,
        id: &str,
        slide_id: &str,
        name: &str,
        branch: &str,
    ) -> AppResult<(Vec<u8>, String)> {
        let repo = self.repo_for_branch(id, branch)?;
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

    pub fn commits_for_session(
        &self,
        id: &str,
        session_id: &str,
        limit: usize,
    ) -> AppResult<Vec<CommitInfo>> {
        self.validate_session(id, Some(session_id))?;
        let repo = self.repo_for_session(session_id)?;
        let mut walk = repo.revwalk()?;
        walk.push_head()?;
        let mut out = Vec::new();
        for oid in walk.take(limit.max(1).min(200)) {
            let commit = repo.find_commit(oid?)?;
            out.push(commit_info(&commit, true)?);
        }
        Ok(out)
    }

    // Restrict historical reads to commits reachable from the authorized branch.
    fn history_commit<'repo>(
        &self,
        repo: &'repo Repository,
        branch: &str,
        revision: &str,
    ) -> AppResult<git2::Commit<'repo>> {
        let oid = Oid::from_str(revision)
            .map_err(|_| AppError::BadRequest("invalid commit id".into()))?;
        let tip = repo
            .find_branch(branch, BranchType::Local)?
            .get()
            .peel_to_commit()?
            .id();
        let commit = repo
            .find_commit(oid)
            .map_err(|_| AppError::NotFound("commit not found".into()))?;
        if oid != tip && !repo.graph_descendant_of(tip, oid)? {
            return Err(AppError::Forbidden(
                "commit is not in this branch's history".into(),
            ));
        }
        Ok(commit)
    }

    pub fn branch_tip(&self, id: &str, branch: &str) -> AppResult<String> {
        let repo = self.open_repo(id)?;
        let tip = repo
            .find_branch(branch, BranchType::Local)?
            .get()
            .peel_to_commit()?
            .id()
            .to_string();
        Ok(tip)
    }

    pub fn history_page(
        &self,
        id: &str,
        branch: &str,
        actor: &DemoUser,
        before: Option<&str>,
        limit: usize,
    ) -> AppResult<HistoryPage> {
        self.require_deck_role(id, actor, branch, DeckRole::View)?;
        let repo = self.open_repo(id)?;
        if let Some(cursor) = before {
            self.history_commit(&repo, branch, cursor)?;
        }
        let tip = repo
            .find_branch(branch, BranchType::Local)?
            .get()
            .peel_to_commit()?
            .id();
        let mut walk = repo.revwalk()?;
        walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
        walk.push(tip)?;
        let mut passed_cursor = before.is_none();
        let mut commits = Vec::new();
        let limit = limit.clamp(1, 100);
        let mut more = false;
        for oid in walk {
            let commit = repo.find_commit(oid?)?;
            if !passed_cursor {
                passed_cursor = Some(commit.id().to_string().as_str()) == before;
                continue;
            }
            if commits.len() == limit {
                more = true;
                break;
            }
            commits.push(commit_info(&commit, true)?);
        }
        let next_cursor = if more {
            commits.last().map(|commit| commit.id.clone())
        } else {
            None
        };
        Ok(HistoryPage {
            commits,
            next_cursor,
        })
    }

    pub fn commit_snapshot(
        &self,
        id: &str,
        branch: &str,
        revision: &str,
        actor: &DemoUser,
    ) -> AppResult<CommitSnapshot> {
        self.require_deck_role(id, actor, branch, DeckRole::View)?;
        let repo = self.open_repo(id)?;
        let commit = self.history_commit(&repo, branch, revision)?;
        let tree = commit.tree()?;
        let deck: Deck = serde_json::from_slice(&history_blob(&repo, &tree, "deck.json")?)?;
        let mut slides = Vec::new();
        let mut notes = BTreeMap::new();
        for slide_id in &deck.slides {
            if !valid_id(slide_id) {
                return Err(AppError::BadRequest("invalid historical slide id".into()));
            }
            let mut slide: Slide = serde_json::from_slice(&history_blob(
                &repo,
                &tree,
                &format!("slides/{slide_id}/slide.json"),
            )?)?;
            let note_path = format!("slides/{slide_id}/notes.md");
            let note = match tree.get_path(Path::new(&note_path)) {
                Ok(_) => {
                    String::from_utf8_lossy(&history_blob(&repo, &tree, &note_path)?).into_owned()
                }
                Err(error) if error.code() == git2::ErrorCode::NotFound => String::new(),
                Err(error) => return Err(error.into()),
            };
            notes.insert(slide_id.clone(), note);
            rewrite_local_asset_sources(&mut slide, id, slide_id, branch, actor);
            let prefix = format!("/api/decks/{id}/slides/{slide_id}/assets/");
            for element in slide.elements.values_mut() {
                if let Some(source) = element.src.as_mut() {
                    if source.starts_with(&prefix) {
                        source.push_str(&format!("&commit={}", commit.id()));
                    }
                }
            }
            slides.push(slide);
        }
        Ok(CommitSnapshot {
            commit: commit_info(&commit, true)?,
            deck,
            slides,
            notes,
        })
    }

    pub fn read_asset_at_commit(
        &self,
        id: &str,
        slide_id: &str,
        name: &str,
        branch: &str,
        revision: &str,
        actor: &DemoUser,
    ) -> AppResult<(Vec<u8>, String)> {
        self.require_deck_role(id, actor, branch, DeckRole::View)?;
        if !valid_id(slide_id) {
            return Err(AppError::BadRequest("invalid slide id".into()));
        }
        let name = sanitize_asset_name(name)?;
        let repo = self.open_repo(id)?;
        let commit = self.history_commit(&repo, branch, revision)?;
        let bytes = history_blob(
            &repo,
            &commit.tree()?,
            &format!("slides/{slide_id}/assets/{name}"),
        )?;
        Ok((
            bytes,
            mime_guess::from_path(name)
                .first_or_octet_stream()
                .to_string(),
        ))
    }

    // Caller holds write_lock. Keep history intact by restoring the tree into a
    // new commit; checkpoint the working tree first so the action is reversible.
    pub fn restore_commit(
        &self,
        id: &str,
        branch: &str,
        revision: &str,
        expected_head: &str,
        actor: &DemoUser,
    ) -> AppResult<CommitInfo> {
        self.require_deck_role(id, actor, branch, DeckRole::Edit)?;
        let repo = self.repo_for_branch(id, branch)?;
        if current_branch(&repo)? != branch {
            return Err(AppError::Conflict(
                "branch changed; refresh the timeline".into(),
            ));
        }
        let target = self.history_commit(&repo, branch, revision)?;
        let current = repo.head()?.peel_to_commit()?;
        if current.id().to_string() != expected_head {
            return Err(AppError::Conflict(
                "New history was saved. Refresh the timeline before restoring.".into(),
            ));
        }
        // Prevent new lock acquisitions until the branch has been restored.
        let locks = self.object_locks.lock();
        if locks.iter().any(|((deck, room, _), (owner, _, expiry))| {
            deck == id && room == branch && owner != &actor.id && *expiry > Instant::now()
        }) {
            return Err(AppError::Conflict(
                "Another editor is changing this branch. Try restoring after they finish.".into(),
            ));
        }
        commit_all_as(&repo, "Checkpoint before restoring a version", &[], actor)?;
        let backup = repo.head()?.peel_to_commit()?;
        let target_tree = target.tree()?;
        let mut options = git2::build::CheckoutBuilder::new();
        options.force().remove_untracked(true);
        let result = (|| -> AppResult<CommitInfo> {
            repo.checkout_tree(target_tree.as_object(), Some(&mut options))?;
            commit_all_as(
                &repo,
                &format!(
                    "Restore {}: {}",
                    &target.id().to_string()[..8],
                    target.summary()?.unwrap_or("Saved version")
                ),
                &[],
                actor,
            )
        })();
        if result.is_err() {
            // Recover the checkpointed content if checkout or committing fails.
            let mut recovery = git2::build::CheckoutBuilder::new();
            recovery.force().remove_untracked(true);
            if let Err(error) = repo.checkout_tree(backup.tree()?.as_object(), Some(&mut recovery))
            {
                tracing::error!(error = %error, "could not recover working tree after failed restore");
            }
        } else {
            self.edit_batches
                .lock()
                .remove(&(id.to_owned(), branch.to_owned()));
            for session in self.sessions.lock().values_mut() {
                if session.info.deck_id == id && session.info.branch == branch {
                    session.dirty = false;
                }
            }
        }
        drop(locks);
        result
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

    pub fn branches_for_user(&self, id: &str, actor: &DemoUser) -> AppResult<Vec<BranchInfo>> {
        let branches = self.branches(id)?;
        let acl = self.load_collaboration(id)?;
        if acl.owner_id == actor.id {
            return Ok(branches);
        }
        let allowed = acl.member_branches(&actor.id);
        Ok(branches
            .into_iter()
            .filter(|branch| allowed.contains_key(&branch.name))
            .collect())
    }

    pub fn create_branch(
        &self,
        id: &str,
        req: CreateBranchRequest,
        actor: &DemoUser,
    ) -> AppResult<DeckDetail> {
        let branch_name = req.name.split_whitespace().collect::<Vec<_>>().join("-");
        if branch_name.is_empty() {
            return Err(AppError::BadRequest("branch name is required".into()));
        }
        if branch_name.starts_with('/')
            || branch_name.ends_with('/')
            || branch_name.ends_with('.')
            || branch_name.contains("..")
            || branch_name.contains("//")
            || branch_name.contains("@{")
            || !branch_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
        {
            return Err(AppError::BadRequest(
                "branch name contains characters Git cannot use".into(),
            ));
        }
        self.validate_session_actor(id, req.session_id.as_deref(), actor)?;
        let repo = self.open_repo(id)?;
        if repo.find_branch(&branch_name, BranchType::Local).is_ok() {
            return Err(AppError::Conflict(format!(
                "branch '{branch_name}' already exists"
            )));
        }
        let session_branch = req.session_id.as_deref().map(|session_id| {
            let sessions = self.sessions.lock();
            sessions
                .get(session_id)
                .expect("validated session")
                .info
                .branch
                .clone()
        });
        let base_branch = req
            .from
            .clone()
            .or_else(|| session_branch.clone())
            .unwrap_or(current_branch(&repo)?);
        self.require_deck_role(id, actor, &base_branch, DeckRole::Edit)?;
        repo.find_branch(&base_branch, BranchType::Local)?;
        if req.session_id.is_some() && session_branch.as_deref() == Some(base_branch.as_str()) {
            self.commit_session(
                req.session_id.as_deref().unwrap(),
                Some("Checkpoint before branch creation".into()),
            )?;
        } else {
            let base_repo = self.repo_for_branch(id, &base_branch)?;
            commit_all_as(&base_repo, "Checkpoint before branch creation", &[], actor)?;
        }

        let from_commit = repo
            .find_branch(&base_branch, BranchType::Local)?
            .get()
            .peel_to_commit()?;
        repo.branch(&branch_name, &from_commit, false)?;
        let mut acl = self.load_collaboration(id)?;
        if acl.owner_id != actor.id {
            acl.members
                .entry(actor.id.clone())
                .or_default()
                .insert(branch_name.clone(), DeckRole::Edit);
            self.save_collaboration(id, &acl)?;
        }
        if req.checkout {
            if let Some(session_id) = req.session_id.as_deref() {
                self.set_session_branch(session_id, &branch_name);
                self.repo_for_branch(id, &branch_name)?;
            } else {
                checkout_branch(&repo, &branch_name)?;
            }
        }
        match req.session_id.as_deref() {
            Some(session) => self.session_deck_detail(id, session),
            None => self.deck_detail(id),
        }
    }

    pub fn delete_branch(&self, id: &str, name: &str, actor: &DemoUser) -> AppResult<()> {
        self.require_deck_role(id, actor, name, DeckRole::Edit)?;
        if name == "main" {
            return Err(AppError::Conflict("the main branch is protected".into()));
        }
        let repo = self.open_repo(id)?;
        let in_use = self
            .sessions
            .lock()
            .values()
            .any(|session| session.info.deck_id == id && session.info.branch == name);
        if in_use {
            return Err(AppError::Conflict(
                "this branch still has active editor sessions".into(),
            ));
        }
        if current_branch(&repo)? == name {
            return Err(AppError::Conflict(
                "switch branches before deleting the current branch".into(),
            ));
        }
        let room_root = self.decks_root.join(".worktrees").join(id);
        let worktree_name = worktree_name(&room_root, name);
        let worktree_path = room_root.join(&worktree_name);
        if worktree_path.exists() {
            let room = Repository::open(&worktree_path)?;
            if repo_dirty(&room)? {
                return Err(AppError::Conflict(
                    "this branch has uncommitted edits; open and checkpoint it before deleting"
                        .into(),
                ));
            }
            fs::remove_dir_all(&worktree_path)?;
            if let Ok(worktree) = repo.find_worktree(&worktree_name) {
                worktree.prune(None)?;
            }
        }
        let mut branch = repo
            .find_branch(name, BranchType::Local)
            .map_err(|_| AppError::NotFound(format!("branch '{name}' not found")))?;
        branch.delete()?;
        let mut acl = self.load_collaboration(id)?;
        for permissions in acl.members.values_mut() {
            permissions.remove(name);
        }
        acl.share_links.retain(|link| link.branch != name);
        self.save_collaboration(id, &acl)?;
        Ok(())
    }

    pub fn checkout(
        &self,
        id: &str,
        req: CheckoutRequest,
        actor: &DemoUser,
    ) -> AppResult<DeckDetail> {
        self.validate_session_actor(id, req.session_id.as_deref(), actor)?;
        self.require_deck_role(id, actor, &req.branch, DeckRole::Edit)?;
        let repo = self.open_repo(id)?;
        if let Some(session_id) = req.session_id.as_deref() {
            self.commit_session(session_id, Some("Checkpoint before branch switch".into()))?;
            repo.find_branch(&req.branch, BranchType::Local)?;
            self.repo_for_branch(id, &req.branch)?;
            self.set_session_branch(session_id, &req.branch);
            return self.session_deck_detail(id, session_id);
        } else {
            commit_all_as(&repo, "Checkpoint before branch switch", &[], actor)?;
        }
        checkout_branch(&repo, &req.branch)?;
        self.deck_detail(id)
    }

    pub fn checkpoint(&self, id: &str, message: Option<String>) -> AppResult<CommitInfo> {
        let actor = DemoUser {
            id: "usr_system".into(),
            username: "system".into(),
            display_name: "Present".into(),
        };
        self.checkpoint_as(id, message, &actor)
    }

    pub fn checkpoint_as(
        &self,
        id: &str,
        message: Option<String>,
        actor: &DemoUser,
    ) -> AppResult<CommitInfo> {
        let repo = self.open_repo(id)?;
        commit_all_as(
            &repo,
            message.as_deref().unwrap_or("Manual checkpoint"),
            &[],
            actor,
        )
    }

    // ---------------------------------------------------------------------
    // Sessions
    // ---------------------------------------------------------------------

    pub fn create_session(&self, id: &str, req: CreateSessionRequest) -> AppResult<SessionInfo> {
        let actor = DemoUser {
            id: "usr_system".into(),
            username: "system".into(),
            display_name: "Present".into(),
        };
        self.create_session_as(id, req, &actor)
    }

    pub fn create_session_as(
        &self,
        id: &str,
        req: CreateSessionRequest,
        actor: &DemoUser,
    ) -> AppResult<SessionInfo> {
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
        self.repo_for_branch(id, &info.branch)?;
        let mut sessions = self.sessions.lock();
        sessions.insert(
            info.id.clone(),
            Session {
                info: info.clone(),
                actor: actor.clone(),
                last_activity: Instant::now(),
                dirty: false,
            },
        );
        Ok(info)
    }

    pub fn validate_session(&self, deck_id: &str, session_id: Option<&str>) -> AppResult<()> {
        let Some(session_id) = session_id else {
            return Ok(());
        };
        let sessions = self.sessions.lock();
        match sessions.get(session_id) {
            Some(session) if session.info.deck_id == deck_id => Ok(()),
            Some(_) => Err(AppError::BadRequest(
                "session belongs to another deck".into(),
            )),
            None => Err(AppError::BadRequest("unknown or expired session".into())),
        }
    }

    pub fn validate_session_actor(
        &self,
        deck_id: &str,
        session_id: Option<&str>,
        actor: &DemoUser,
    ) -> AppResult<()> {
        self.validate_session(deck_id, session_id)?;
        if let Some(session_id) = session_id {
            let sessions = self.sessions.lock();
            if sessions
                .get(session_id)
                .is_some_and(|session| session.actor.id != actor.id)
            {
                return Err(AppError::Unauthorized(
                    "editor session belongs to another demo profile".into(),
                ));
            }
        }
        Ok(())
    }

    fn touch_session(&self, session_id: Option<&str>) {
        let Some(session_id) = session_id else {
            return;
        };
        let mut sessions = self.sessions.lock();
        if let Some(session) = sessions.get_mut(session_id) {
            session.last_activity = Instant::now();
            session.dirty = true;
        }
    }

    fn set_session_branch(&self, session_id: &str, branch: &str) {
        let mut sessions = self.sessions.lock();
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
        let (deck_id, branch, actor) = {
            let sessions = self.sessions.lock();
            let session = sessions
                .get(session_id)
                .ok_or_else(|| AppError::NotFound("session not found".into()))?;
            (
                session.info.deck_id.clone(),
                session.info.branch.clone(),
                session.actor.clone(),
            )
        };
        let repo = self.repo_for_branch(&deck_id, &branch)?;
        let current = current_branch(&repo)?;
        if current != branch {
            return Err(AppError::Conflict(
                "session branch no longer matches the checked-out branch".into(),
            ));
        }
        let info = commit_all_as(
            &repo,
            message.as_deref().unwrap_or("Session checkpoint"),
            &[],
            &actor,
        )?;
        self.set_session_branch(session_id, &branch);
        Ok(info)
    }

    pub fn close_session(&self, session_id: &str) -> AppResult<()> {
        let should_commit = {
            let sessions = self.sessions.lock();
            let Some(session) = sessions.get(session_id) else {
                return Ok(());
            };
            session.dirty
        };
        if should_commit {
            if let Err(err) = self.commit_session(session_id, Some("Close editing session".into()))
            {
                tracing::warn!(session = %session_id, error = %err, "could not commit session on close");
            }
        }
        let mut sessions = self.sessions.lock();
        sessions.remove(session_id);
        drop(sessions);
        self.object_locks
            .lock()
            .retain(|_, (_, session, _)| session.as_deref() != Some(session_id));
        Ok(())
    }

    /// Commit and drop every in-memory editing session. Used during graceful
    /// shutdown so Docker's `SIGTERM` does not lose the last debounce window.
    pub fn close_all_sessions(&self) {
        let ids: Vec<String> = {
            let sessions = self.sessions.lock();
            sessions.keys().cloned().collect()
        };
        for id in ids {
            if let Err(err) = self.close_session(&id) {
                tracing::warn!(session = %id, error = %err, "could not close session");
            }
        }
    }

    pub fn expire_sessions(&self, max_idle: Duration) {
        let _guard = self.write_lock.lock();
        let ids: Vec<String> = {
            let sessions = self.sessions.lock();
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

    fn record_semantic_edit(
        &self,
        deck_id: &str,
        session_id: Option<&str>,
        slide_id: &str,
        weight: usize,
        actor: &DemoUser,
    ) -> AppResult<()> {
        let branch = if let Some(session_id) = session_id {
            let sessions = self.sessions.lock();
            sessions
                .get(session_id)
                .map(|session| session.info.branch.clone())
                .ok_or_else(|| AppError::BadRequest("unknown or expired session".into()))?
        } else {
            current_branch(&self.open_repo(deck_id)?)?
        };
        let now = Instant::now();
        let mut batches = self.edit_batches.lock();
        let batch = batches
            .entry((deck_id.to_string(), branch))
            .or_insert_with(|| EditBatch {
                started: now,
                last_edit: now,
                points: 0,
                slides: HashSet::new(),
                actor: actor.clone(),
            });
        batch.last_edit = now;
        batch.actor = actor.clone();
        batch.points += weight;
        batch.slides.insert(slide_id.to_string());
        Ok(())
    }

    /// Applies the agreed semantic auto-commit thresholds. Called by the server's
    /// periodic idle worker; a batch is only committed after three seconds without edits.
    pub fn auto_commit_due(&self) -> AppResult<Vec<CommitInfo>> {
        let _write = self.write_lock.lock();
        let now = Instant::now();
        let ready: Vec<_> = {
            let batches = self.edit_batches.lock();
            batches
                .iter()
                .filter_map(|(key, batch)| {
                    if now.duration_since(batch.last_edit) < Duration::from_secs(3) {
                        return None;
                    }
                    let age = now.duration_since(batch.started);
                    let slide_limit = if age < Duration::from_secs(60) { 5 } else { 7 };
                    let due = (batch.points >= 30
                        && now.duration_since(batch.last_edit) >= Duration::from_secs(3))
                        || batch.slides.len() >= slide_limit
                        || (age >= Duration::from_secs(120)
                            && now.duration_since(batch.last_edit) >= Duration::from_secs(3));
                    due.then(|| {
                        (
                            key.clone(),
                            batch.points,
                            batch.slides.len(),
                            batch.actor.clone(),
                        )
                    })
                })
                .collect()
        };
        let mut commits = Vec::new();
        for ((deck_id, branch), points, slides, actor) in ready {
            let repo = self.repo_for_branch(&deck_id, &branch)?;
            if current_branch(&repo)? != branch {
                continue;
            }
            let message = format!("Auto-save: {slides} slides, {points} edit points");
            let commit = commit_all_as(&repo, &message, &[], &actor)?;
            self.edit_batches.lock().remove(&(deck_id, branch));
            if commit.committed {
                commits.push(commit);
            }
        }
        Ok(commits)
    }
}

// ---------------------------------------------------------------------------
// Filesystem / repository helpers
// ---------------------------------------------------------------------------

fn history_blob(repo: &Repository, tree: &git2::Tree<'_>, path: &str) -> AppResult<Vec<u8>> {
    let entry = tree
        .get_path(Path::new(path))
        .map_err(|_| AppError::NotFound(format!("'{path}' not found in this version")))?;
    let blob = repo.find_blob(entry.id())?;
    Ok(blob.content().to_vec())
}

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

fn worktree_name(room_root: &Path, branch: &str) -> String {
    // Worktree paths must be stable across process restarts. Keep using the
    // existing path for branches created before the ahash switch.
    let mut legacy = std::collections::hash_map::DefaultHasher::new();
    branch.hash(&mut legacy);
    let legacy_name = format!("room-{:016x}", legacy.finish());
    if room_root.join(&legacy_name).exists() {
        return legacy_name;
    }

    let mut hasher = ahash::RandomState::with_seeds(1, 2, 3, 4).build_hasher();
    branch.hash(&mut hasher);
    format!("room-{:016x}", hasher.finish())
}

fn short_id() -> String {
    let mut id = Uuid::new_v4().simple().to_string();
    id.truncate(8);
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
    let sig = signature()?;
    commit_all_with_signature(repo, message, extra_parents, &sig)
}

pub fn commit_all_as(
    repo: &Repository,
    message: &str,
    extra_parents: &[Oid],
    actor: &DemoUser,
) -> AppResult<CommitInfo> {
    let email = format!("{}@present.invalid", actor.id);
    let sig = Signature::now(&actor.display_name, &email)?;
    commit_all_with_signature(repo, message, extra_parents, &sig)
}

fn commit_all_with_signature(
    repo: &Repository,
    message: &str,
    extra_parents: &[Oid],
    sig: &Signature<'_>,
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
    let oid = repo.commit(Some("HEAD"), sig, sig, message, &tree, &parent_refs)?;
    let commit = repo.find_commit(oid)?;
    commit_info(&commit, true)
}

pub fn merge_commit(
    repo: &Repository,
    message: &str,
    ours: Oid,
    theirs: Oid,
) -> AppResult<CommitInfo> {
    let sig = signature()?;
    merge_commit_with_signature(repo, message, ours, theirs, &sig)
}

pub fn merge_commit_as(
    repo: &Repository,
    message: &str,
    ours: Oid,
    theirs: Oid,
    actor: &DemoUser,
) -> AppResult<CommitInfo> {
    let email = format!("{}@present.invalid", actor.id);
    let sig = Signature::now(&actor.display_name, &email)?;
    merge_commit_with_signature(repo, message, ours, theirs, &sig)
}

fn merge_commit_with_signature(
    repo: &Repository,
    message: &str,
    ours: Oid,
    theirs: Oid,
    sig: &Signature<'_>,
) -> AppResult<CommitInfo> {
    let mut index = repo.index()?;
    index.update_all(["*"], None)?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let ours_commit = repo.find_commit(ours)?;
    let theirs_commit = repo.find_commit(theirs)?;
    let oid = repo.commit(
        Some("HEAD"),
        sig,
        sig,
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

fn asset_url_in_context(
    deck_id: &str,
    slide_id: &str,
    name: &str,
    branch: &str,
    actor: &DemoUser,
) -> String {
    format!(
        "{}?branch={branch}&demoUserId={}",
        asset_url(deck_id, slide_id, name),
        actor.id
    )
}

// JavaScript JSON.stringify emits integral floats as integers. Normalize only
// exact integers in its safe range so transport formatting is not an edit.
fn normalize_json_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(number) if number.is_f64() => {
            if let Some(float) = number.as_f64() {
                if float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_991.0 {
                    *value = json!(float as i64);
                }
            }
        }
        serde_json::Value::Object(map) => map.values_mut().for_each(normalize_json_numbers),
        serde_json::Value::Array(array) => array.iter_mut().for_each(normalize_json_numbers),
        _ => {}
    }
}

// Branch and identity parameters are transport context, not persisted slide edits.
fn normalize_slide_for_storage(slide: &mut Slide, deck_id: &str, slide_id: &str) {
    let prefix = format!("/api/decks/{deck_id}/slides/{slide_id}/assets/");
    for element in slide.elements.values_mut() {
        for value in element.style.values_mut().chain(element.extra.values_mut()) {
            normalize_json_numbers(value);
        }
        if let Some(source) = element.src.as_ref() {
            let path = source.split('?').next().unwrap_or(source);
            if let Some(name) = path.strip_prefix(&prefix) {
                if !name.is_empty() && !name.contains('/') {
                    element.src = Some(path.to_owned());
                }
            }
        }
    }
}

fn rewrite_local_asset_sources(
    slide: &mut Slide,
    deck_id: &str,
    slide_id: &str,
    branch: &str,
    actor: &DemoUser,
) {
    let prefix = format!("/api/decks/{deck_id}/slides/{slide_id}/assets/");
    for element in slide.elements.values_mut() {
        let Some(source) = element.src.as_deref() else {
            continue;
        };
        let path = source.split('?').next().unwrap_or(source);
        let Some(name) = path.strip_prefix(&prefix) else {
            continue;
        };
        if name.is_empty() || name.contains('/') {
            continue;
        }
        element.src = Some(asset_url_in_context(deck_id, slide_id, name, branch, actor));
    }
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

fn seed_blank_deck(path: &Path, title: &str) -> AppResult<()> {
    let mut deck = Deck::new(title);
    deck.slides = vec!["s_01_blank".into()];
    write_json_atomic(&path.join("deck.json"), &deck)?;
    let slide_dir = path.join("slides/s_01_blank");
    fs::create_dir_all(slide_dir.join("assets"))?;
    write_json_atomic(
        &slide_dir.join("slide.json"),
        &Slide::blank("s_01_blank", "Slide 1"),
    )?;
    write_atomic(&slide_dir.join("notes.md"), b"")?;
    write_atomic(&slide_dir.join("assets/.gitkeep"), b"")?;
    Ok(())
}

fn validate_template_bundle(bundle: &TemplateBundle) -> AppResult<()> {
    if bundle.id.trim().is_empty()
        || bundle.id.len() > 128
        || !bundle
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::BadRequest("template id is invalid".into()));
    }
    if bundle.name.trim().is_empty() {
        return Err(AppError::BadRequest("template name is required".into()));
    }
    if bundle.kind == TemplateBundleKind::Code
        && bundle.generator.as_deref().is_none_or(str::is_empty)
    {
        return Err(AppError::BadRequest(
            "code template generator is required".into(),
        ));
    }
    if bundle.slide_options.len() > 10 {
        return Err(AppError::BadRequest(
            "a template can have at most 10 slide options".into(),
        ));
    }
    if bundle
        .generator
        .as_ref()
        .is_some_and(|source| source.len() > 256_000)
    {
        return Err(AppError::BadRequest(
            "template generator exceeds 256 KB".into(),
        ));
    }
    if bundle.initial_slides.len() > 100
        || bundle
            .slide_options
            .iter()
            .any(|option| option.slides.is_empty() || option.slides.len() > 20)
    {
        return Err(AppError::BadRequest(
            "template slide output is empty or too large".into(),
        ));
    }
    if bundle.custom_object_types.len() > 50
        || bundle
            .custom_object_types
            .iter()
            .any(|definition| definition.generator.len() > 128_000 || definition.inputs.len() > 50)
    {
        return Err(AppError::BadRequest(
            "custom object definition exceeds limits".into(),
        ));
    }
    if bundle.custom_object_types.iter().any(|definition| {
        !valid_id(&definition.id)
            || definition.name.trim().is_empty()
            || definition.generator.trim().is_empty()
            || definition
                .inputs
                .iter()
                .any(|input| !valid_id(&input.id) || input.label.trim().is_empty())
    }) {
        return Err(AppError::BadRequest(
            "custom object definition is invalid".into(),
        ));
    }
    let slide_count = bundle.initial_slides.len()
        + bundle
            .slide_options
            .iter()
            .map(|option| option.slides.len())
            .sum::<usize>();
    if slide_count > 300
        || bundle
            .initial_slides
            .iter()
            .chain(
                bundle
                    .slide_options
                    .iter()
                    .flat_map(|option| option.slides.iter()),
            )
            .any(|slide| slide.elements.len() > 2000)
    {
        return Err(AppError::BadRequest(
            "template output contains too many slides or objects".into(),
        ));
    }
    let mut option_ids = HashSet::new();
    if bundle.slide_options.iter().any(|option| {
        !valid_id(&option.id) || option.name.trim().is_empty() || !option_ids.insert(&option.id)
    }) {
        return Err(AppError::BadRequest(
            "slide option id or name is invalid".into(),
        ));
    }
    Ok(())
}

fn seed_bundle_deck(
    path: &Path,
    deck_id: &str,
    title: &str,
    bundle: &TemplateBundle,
) -> AppResult<()> {
    let slides = if bundle.initial_slides.is_empty() {
        vec![Slide::blank("s_01_blank", "Slide 1")]
    } else {
        bundle.initial_slides.clone()
    };
    let mut deck = Deck::new(title);
    for (index, mut slide) in slides.into_iter().enumerate() {
        let id = format!("s_{:02}_{}", index + 1, &short_id()[..4]);
        slide.id = id.clone();
        slide.name = slide.name.trim().to_owned();
        if slide.name.is_empty() {
            slide.name = format!("Slide {}", index + 1);
        }
        let slide_dir = path.join("slides").join(&id);
        fs::create_dir_all(slide_dir.join("assets"))?;
        let mut elements = BTreeMap::new();
        let mut element_ids = HashMap::new();
        for (old_key, mut element) in std::mem::take(&mut slide.elements) {
            let old_id = element.id.clone();
            element.id = format!("el_{}", &short_id()[..8]);
            element_ids.insert(old_key, element.id.clone());
            element_ids.insert(old_id, element.id.clone());
            if element.kind == "image" {
                if let Some(src) = element
                    .src
                    .as_deref()
                    .filter(|src| src.starts_with("data:"))
                {
                    let (header, encoded) = src.split_once(";base64,").ok_or_else(|| {
                        AppError::BadRequest("Embedded images must use base64 data URLs".into())
                    })?;
                    let extension = match header {
                        "data:image/png" => "png",
                        "data:image/jpeg" => "jpg",
                        "data:image/gif" => "gif",
                        "data:image/webp" => "webp",
                        "data:image/svg+xml" => "svg",
                        "data:image/avif" => "avif",
                        "data:image/bmp" => "bmp",
                        "data:image/tiff" => "tiff",
                        _ => {
                            return Err(AppError::BadRequest(
                                "Unsupported embedded image format".into(),
                            ))
                        }
                    };
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .map_err(|_| {
                            AppError::BadRequest(
                                "An embedded image contains invalid base64 data".into(),
                            )
                        })?;
                    if bytes.len() > 100 * 1024 * 1024 {
                        return Err(AppError::BadRequest(
                            "Embedded images must be 100 MiB or smaller".into(),
                        ));
                    }
                    let name = format!("imported-{}.{}", element.id, extension);
                    write_atomic(&slide_dir.join("assets").join(&name), &bytes)?;
                    element.src = Some(asset_url(deck_id, &id, &name));
                }
            }
            elements.insert(element.id.clone(), element);
        }
        slide.elements = elements;
        for animation in &mut slide.animations {
            if let Some(element_id) = element_ids.get(&animation.element_id) {
                animation.element_id = element_id.clone();
            }
        }
        deck.slides.push(id.clone());
        write_json_atomic(&slide_dir.join("slide.json"), &slide)?;
        write_atomic(&slide_dir.join("notes.md"), b"")?;
        write_atomic(&slide_dir.join("assets/.gitkeep"), b"")?;
    }
    write_json_atomic(&path.join("deck.json"), &deck)?;
    let present_dir = path.join(".present");
    fs::create_dir_all(&present_dir)?;
    let mut deck_template = bundle.clone();
    if deck_template.kind == TemplateBundleKind::Pptx {
        // Initial slides are already stored as the deck's slide files. Keep
        // the editor's template metadata response limited to add-slide
        // options and custom object definitions.
        deck_template.initial_slides.clear();
    }
    write_json_atomic(&present_dir.join("template-bundle.json"), &deck_template)?;
    Ok(())
}

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
        animations: Vec::new(),
        transition: None,
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
        animations: Vec::new(),
        transition: None,
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
        animations: Vec::new(),
        transition: None,
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

#[cfg(test)]
mod demo_user_tests {
    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("present-{label}-{}", Uuid::new_v4().simple()))
    }

    #[test]
    fn demo_users_persist_and_names_are_unique_case_insensitively() {
        let root = temporary_root("users");
        let users = AppState::new(root.join("decks"));
        let created = users.create_demo_user(" Alice ").unwrap();
        assert_eq!(created.display_name, "Alice");
        assert!(matches!(
            users.create_demo_user("alice"),
            Err(AppError::Conflict(_))
        ));

        let restarted = AppState::new(root.join("decks"));
        assert_eq!(restarted.demo_users().unwrap(), vec![created]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_deck_commit_uses_the_active_demo_profile() {
        let root = temporary_root("author");
        let state = AppState::new(root.join("decks"));
        let user = state.create_demo_user("Riley_Example").unwrap();
        state
            .create_deck_as(
                CreateDeckRequest {
                    title: "Attributed deck".into(),
                    id: Some("attributed".into()),
                    template_id: Some("blank".into()),
                    template_bundle: None,
                },
                &user,
            )
            .unwrap();
        assert_eq!(
            state.commits("attributed", 1).unwrap()[0].author,
            "Riley_Example"
        );
        fs::remove_dir_all(root).unwrap();
    }
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

#[cfg(test)]
mod save_regression_tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        state: AppState,
        actor: DemoUser,
        slide: Slide,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("present-save-{}", Uuid::new_v4()));
            let state = AppState::new(root.join("decks"));
            let actor = state.create_demo_user("editor").unwrap();
            let req =
                serde_json::from_value(json!({"id": "deck", "title": "Save regression"})).unwrap();
            let detail = state.create_deck_as(req, &actor).unwrap();
            let slide = state
                .read_slide("deck", &detail.slides[0].id)
                .unwrap()
                .slide;
            Self {
                root,
                state,
                actor,
                slide,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn share_links_grant_scoped_access_persist_and_revoke_without_losing_direct_access() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let user = state.create_demo_user("link_recipient").unwrap();
        state
            .create_branch(
                "deck",
                CreateBranchRequest {
                    name: "feature/shared".into(),
                    from: Some("main".into()),
                    checkout: false,
                    session_id: None,
                },
                &fixture.actor,
            )
            .unwrap();
        let view = state
            .create_share_link(
                "deck",
                &fixture.actor,
                CreateShareLinkRequest {
                    branch: "feature/shared".into(),
                    role: DeckRole::View,
                },
            )
            .unwrap();
        let edit = state
            .create_share_link(
                "deck",
                &fixture.actor,
                CreateShareLinkRequest {
                    branch: "feature/shared".into(),
                    role: DeckRole::Edit,
                },
            )
            .unwrap();
        assert_ne!(view.token, edit.token);
        assert_eq!(
            state.deck_role("deck", &user.id, "feature/shared").unwrap(),
            None
        );
        let preview = state.share_link_preview("deck", &view.token).unwrap();
        assert_eq!(preview.branch, "feature/shared");
        assert_eq!(preview.role, DeckRole::View);
        state.join_share_link("deck", &view.token, &user).unwrap();
        state.join_share_link("deck", &view.token, &user).unwrap();
        assert_eq!(
            state.share_links("deck", &fixture.actor).unwrap()[0].joined_count,
            1
        );
        assert_eq!(
            state.deck_role("deck", &user.id, "feature/shared").unwrap(),
            Some(DeckRole::View)
        );
        assert_eq!(state.deck_role("deck", &user.id, "main").unwrap(), None);
        assert!(state
            .require_deck_role("deck", &user, "feature/shared", DeckRole::Edit)
            .is_err());
        assert_eq!(
            state.preferred_branch("deck", &user).unwrap(),
            "feature/shared"
        );
        assert_eq!(state.branches_for_user("deck", &user).unwrap().len(), 1);
        assert_eq!(
            state.list_decks_for_user(&user).unwrap()[0].current_branch,
            "feature/shared"
        );
        assert_eq!(
            state.deck_collaboration("deck", &user).unwrap().members[0].branches["feature/shared"],
            DeckRole::View
        );
        let restarted = AppState::new(fixture.root.join("decks"));
        assert_eq!(
            restarted
                .deck_role("deck", &user.id, "feature/shared")
                .unwrap(),
            Some(DeckRole::View)
        );
        state
            .revoke_share_link("deck", &fixture.actor, &view.id)
            .unwrap();
        assert_eq!(
            state.deck_role("deck", &user.id, "feature/shared").unwrap(),
            None
        );
        assert!(state.join_share_link("deck", &view.token, &user).is_err());
        assert!(state.list_decks_for_user(&user).unwrap().is_empty());
        state
            .set_deck_member(
                "deck",
                &fixture.actor,
                SetDeckMemberRequest {
                    username: user.username.clone(),
                    branch: "feature/shared".into(),
                    role: DeckRole::Comment,
                },
            )
            .unwrap();
        state.join_share_link("deck", &edit.token, &user).unwrap();
        assert_eq!(
            state.deck_role("deck", &user.id, "feature/shared").unwrap(),
            Some(DeckRole::Edit)
        );
        state
            .revoke_share_link("deck", &fixture.actor, &edit.id)
            .unwrap();
        assert_eq!(
            state.deck_role("deck", &user.id, "feature/shared").unwrap(),
            Some(DeckRole::Comment)
        );
        assert!(state.share_link_preview("other-deck", &edit.token).is_err());
    }

    #[test]
    fn only_owners_manage_links_and_member_removal_clears_link_membership() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let user = state.create_demo_user("shared_editor").unwrap();
        let link = state
            .create_share_link(
                "deck",
                &fixture.actor,
                CreateShareLinkRequest {
                    branch: "main".into(),
                    role: DeckRole::Edit,
                },
            )
            .unwrap();
        state.join_share_link("deck", &link.token, &user).unwrap();
        assert!(matches!(
            state.create_share_link(
                "deck",
                &user,
                CreateShareLinkRequest {
                    branch: "main".into(),
                    role: DeckRole::Edit
                }
            ),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            state.share_links("deck", &user),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            state.revoke_share_link("deck", &user, &link.id),
            Err(AppError::Forbidden(_))
        ));
        state
            .remove_deck_member("deck", &fixture.actor, &user.username, "main")
            .unwrap();
        assert_eq!(state.deck_role("deck", &user.id, "main").unwrap(), None);
        assert_eq!(
            state.share_links("deck", &fixture.actor).unwrap()[0].joined_count,
            0
        );
        state.join_share_link("deck", &link.token, &user).unwrap();
        state
            .set_deck_member(
                "deck",
                &fixture.actor,
                SetDeckMemberRequest {
                    username: user.username.clone(),
                    branch: "main".into(),
                    role: DeckRole::View,
                },
            )
            .unwrap();
        assert_eq!(
            state.deck_role("deck", &user.id, "main").unwrap(),
            Some(DeckRole::View)
        );
        state
            .revoke_share_link("deck", &fixture.actor, &link.id)
            .unwrap();
        assert_eq!(
            state.deck_role("deck", &user.id, "main").unwrap(),
            Some(DeckRole::View)
        );
    }

    #[test]
    fn deleting_a_branch_invalidates_its_share_links() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let user = state.create_demo_user("branch_viewer").unwrap();
        state
            .create_branch(
                "deck",
                CreateBranchRequest {
                    name: "temporary".into(),
                    from: Some("main".into()),
                    checkout: false,
                    session_id: None,
                },
                &fixture.actor,
            )
            .unwrap();
        let link = state
            .create_share_link(
                "deck",
                &fixture.actor,
                CreateShareLinkRequest {
                    branch: "temporary".into(),
                    role: DeckRole::View,
                },
            )
            .unwrap();
        state.join_share_link("deck", &link.token, &user).unwrap();
        state
            .delete_branch("deck", "temporary", &fixture.actor)
            .unwrap();
        assert!(state
            .share_links("deck", &fixture.actor)
            .unwrap()
            .is_empty());
        assert_eq!(
            state.deck_role("deck", &user.id, "temporary").unwrap(),
            None
        );
        assert!(state.share_link_preview("deck", &link.token).is_err());
    }

    #[test]
    fn concurrent_sessions_merge_disjoint_objects_and_reject_stale_overwrites() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let peer = state.create_demo_user("peer").unwrap();
        state
            .set_deck_member(
                "deck",
                &fixture.actor,
                SetDeckMemberRequest {
                    username: peer.username.clone(),
                    branch: "main".into(),
                    role: DeckRole::Edit,
                },
            )
            .unwrap();
        let a = state
            .create_session_as(
                "deck",
                CreateSessionRequest {
                    branch: Some("main".into()),
                },
                &fixture.actor,
            )
            .unwrap();
        let b = state
            .create_session_as(
                "deck",
                CreateSessionRequest {
                    branch: Some("main".into()),
                },
                &peer,
            )
            .unwrap();
        let ids: Vec<_> = fixture.slide.elements.keys().cloned().collect();
        let base = fixture.slide.clone();
        let mut ours = base.clone();
        ours.elements.get_mut(&ids[0]).unwrap().x += 25.0;
        let mut theirs = base.clone();
        theirs.elements.get_mut(&ids[1]).unwrap().y += 75.0;
        state
            .acquire_session_locks(
                "deck",
                "main",
                &fixture.actor,
                Some(&a.id),
                &[ids[0].clone()],
            )
            .unwrap();
        state
            .acquire_session_locks("deck", "main", &peer, Some(&b.id), &[ids[1].clone()])
            .unwrap();
        for (user, session, incoming) in [(&fixture.actor, &a.id, &ours), (&peer, &b.id, &theirs)] {
            let req: WriteSlideRequest = serde_json::from_value(
                json!({"slide":incoming,"baseSlide":base,"sessionId":session}),
            )
            .unwrap();
            let req = state.rebase_slide_write("deck", &base.id, req).unwrap();
            state
                .assert_slide_locks("deck", &base.id, Some(session), user, &req.slide)
                .unwrap();
            state.write_slide("deck", &base.id, req, user).unwrap();
        }
        let final_slide = state.read_slide("deck", &base.id).unwrap().slide;
        assert_eq!(final_slide.elements[&ids[0]].x, ours.elements[&ids[0]].x);
        assert_eq!(final_slide.elements[&ids[1]].y, theirs.elements[&ids[1]].y);
        theirs.elements.get_mut(&ids[0]).unwrap().x += 99.0;
        let stale: WriteSlideRequest =
            serde_json::from_value(json!({"slide":theirs,"baseSlide":base,"sessionId":b.id}))
                .unwrap();
        assert!(matches!(
            state.rebase_slide_write("deck", &base.id, stale),
            Err(AppError::Conflict(_))
        ));
    }

    #[test]
    fn animation_and_transition_edits_persist_through_rebased_session_saves() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let session = state
            .create_session_as(
                "deck",
                CreateSessionRequest { branch: None },
                &fixture.actor,
            )
            .unwrap();
        let base = fixture.slide.clone();
        let element_id = base.elements.keys().next().unwrap().clone();
        let save = |incoming: &Slide, before: &Slide| {
            let req: WriteSlideRequest = serde_json::from_value(json!({
                "slide": incoming, "baseSlide": before, "sessionId": session.id,
            }))
            .unwrap();
            let req = state.rebase_slide_write("deck", &base.id, req).unwrap();
            state
                .assert_slide_locks(
                    "deck",
                    &base.id,
                    Some(&session.id),
                    &fixture.actor,
                    &req.slide,
                )
                .unwrap();
            state
                .write_slide("deck", &base.id, req, &fixture.actor)
                .unwrap()
                .slide
        };
        let read = || {
            state
                .read_slide_for_session("deck", &base.id, &session.id)
                .unwrap()
                .slide
        };

        let mut draft = base.clone();
        draft.animations = serde_json::from_value(json!([{
            "id": "anim_entrance", "elementId": element_id, "effect": "fade",
            "order": 0, "durationMs": 500, "delayMs": 100,
            "trigger": "click", "direction": "up",
        }]))
        .unwrap();
        draft.transition = serde_json::from_value(json!({
            "effect": "push", "durationMs": 600, "direction": "left",
        }))
        .unwrap();
        let added = save(&draft, &base);
        assert_eq!(
            added.animations, draft.animations,
            "save response lost the animation"
        );
        assert_eq!(
            added.transition, draft.transition,
            "save response lost the transition"
        );
        assert_eq!(
            read().animations,
            draft.animations,
            "animation was not stored"
        );
        assert_eq!(
            read().transition,
            draft.transition,
            "transition was not stored"
        );

        // A stale object-only edit must retain playback settings it never changed.
        state
            .acquire_session_locks(
                "deck",
                "main",
                &fixture.actor,
                Some(&session.id),
                &[element_id.clone()],
            )
            .unwrap();
        let mut object_edit = base.clone();
        object_edit.elements.get_mut(&element_id).unwrap().x += 20.0;
        let latest = save(&object_edit, &base);
        assert_eq!(latest.animations, draft.animations);
        assert_eq!(latest.transition, draft.transition);

        let mut edited = latest.clone();
        edited.animations[0].duration_ms = 900;
        edited.transition.as_mut().unwrap().duration_ms = 1000;
        let updated = save(&edited, &latest);
        assert_eq!(updated.animations, edited.animations);
        assert_eq!(read().transition, edited.transition);

        let mut removed = updated.clone();
        removed.animations.clear();
        removed.transition = None;
        let deleted = save(&removed, &updated);
        assert!(deleted.animations.is_empty());
        assert!(deleted.transition.is_none());
        assert!(read().animations.is_empty());
        assert!(read().transition.is_none());
    }

    #[test]
    fn pptx_deck_creation_stores_embedded_images_and_remaps_animation_targets() {
        let fixture = Fixture::new();
        let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO9sAAAAASUVORK5CYII=";
        let req: CreateDeckRequest = serde_json::from_value(json!({
            "id": "imported-deck", "title": "Imported PowerPoint",
            "templateBundle": {
                "id": "pptx_import", "name": "PowerPoint", "description": "", "kind": "pptx", "version": 1,
                "initialSlides": [{
                    "id": "original_slide", "name": "Original slide", "background": "#ffffff",
                    "elements": {"original_image": {
                        "id": "original_image", "type": "image", "x": 0, "y": 0, "w": 100, "h": 100,
                        "src": format!("data:image/png;base64,{image}")
                    }},
                    "animations": [{"id": "entrance", "elementId": "original_image", "effect": "fade", "order": 0}]
                }],
                "slideOptions": [], "customObjectTypes": []
            }
        })).unwrap();
        let detail = fixture.state.create_deck_as(req, &fixture.actor).unwrap();
        assert_eq!(detail.slides.len(), 1);
        let payload = fixture
            .state
            .read_slide("imported-deck", &detail.slides[0].id)
            .unwrap();
        let element = payload.slide.elements.values().next().unwrap();
        assert_ne!(element.id, "original_image");
        assert_eq!(payload.slide.animations[0].element_id, element.id);
        assert_eq!(payload.assets.len(), 1);
        assert_eq!(element.src.as_deref(), Some(payload.assets[0].url.as_str()));
        let (bytes, mime) = fixture
            .state
            .read_asset(
                "imported-deck",
                &payload.slide.id,
                &payload.assets[0].name,
                None,
            )
            .unwrap();
        assert_eq!(
            bytes,
            base64::engine::general_purpose::STANDARD
                .decode(image)
                .unwrap()
        );
        assert_eq!(mime, "image/png");
        let metadata: TemplateBundle = read_json(
            &fixture
                .root
                .join("decks/imported-deck/.present/template-bundle.json"),
        )
        .unwrap();
        assert!(
            metadata.initial_slides.is_empty(),
            "image payloads should not be duplicated in template metadata"
        );
    }

    #[test]
    fn tabs_of_the_same_user_have_independent_leases_and_presence() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let a = state
            .create_session_as(
                "deck",
                CreateSessionRequest { branch: None },
                &fixture.actor,
            )
            .unwrap();
        let b = state
            .create_session_as(
                "deck",
                CreateSessionRequest { branch: None },
                &fixture.actor,
            )
            .unwrap();
        let id = fixture.slide.elements.keys().next().unwrap().clone();
        assert_eq!(
            state
                .acquire_session_locks("deck", "main", &fixture.actor, Some(&a.id), &[id.clone()])
                .unwrap(),
            vec![id.clone()]
        );
        assert!(state
            .acquire_session_locks("deck", "main", &fixture.actor, Some(&b.id), &[id.clone()])
            .unwrap()
            .is_empty());
        state.release_session_locks("deck", "main", &fixture.actor, Some(&b.id), &[id.clone()]);
        assert!(state.owns_object_locks(
            "deck",
            "main",
            &fixture.actor,
            Some(&a.id),
            &[id.clone()]
        ));
        state.set_live_presence(
            "deck",
            "main",
            &fixture.actor,
            "tab-a",
            json!({"connectionId":"tab-a"}),
        );
        state.set_live_presence(
            "deck",
            "main",
            &fixture.actor,
            "tab-b",
            json!({"connectionId":"tab-b"}),
        );
        assert_eq!(state.live_presence_snapshot("deck", "main", "").len(), 2);
        state.remove_live_presence("deck", "main", &fixture.actor, "tab-a");
        assert_eq!(
            state.live_presence_snapshot("deck", "main", "")[0]["connectionId"],
            "tab-b"
        );
        assert!(state.owns_object_locks(
            "deck",
            "main",
            &fixture.actor,
            Some(&a.id),
            &[id.clone()]
        ));
        state.close_session(&a.id).unwrap();
        assert_eq!(
            state
                .acquire_session_locks("deck", "main", &fixture.actor, Some(&b.id), &[id.clone()])
                .unwrap(),
            vec![id]
        );
    }

    #[test]
    fn concurrent_notes_are_rejected_without_losing_the_latest_notes() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let old = state.read_slide("deck", &fixture.slide.id).unwrap().notes;
        state
            .write_notes(
                "deck",
                &fixture.slide.id,
                WriteNotesRequest {
                    notes: "First edit".into(),
                    base_notes: Some(old.clone()),
                    session_id: None,
                },
                &fixture.actor,
            )
            .unwrap();
        let result = state.write_notes(
            "deck",
            &fixture.slide.id,
            WriteNotesRequest {
                notes: "Stale edit".into(),
                base_notes: Some(old),
                session_id: None,
            },
            &fixture.actor,
        );
        assert!(matches!(result, Err(AppError::Conflict(_))));
        assert_eq!(
            state.read_slide("deck", &fixture.slide.id).unwrap().notes,
            "First edit"
        );
    }

    #[test]
    fn history_previews_and_restore_include_notes_assets_and_preserve_current_work() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let mut slide = fixture.slide.clone();
        state
            .upload_asset(
                "deck",
                &slide.id,
                "photo.png",
                b"old image",
                None,
                &fixture.actor,
            )
            .unwrap();
        slide.elements.insert(
            "photo".into(),
            Element {
                id: "photo".into(),
                kind: "image".into(),
                src: Some(asset_url("deck", &slide.id, "photo.png")),
                ..Element::default()
            },
        );
        state
            .write_slide(
                "deck",
                &slide.id,
                WriteSlideRequest {
                    base_slide: None,
                    base_notes: None,
                    slide: slide.clone(),
                    notes: Some("Old notes".into()),
                    session_id: None,
                },
                &fixture.actor,
            )
            .unwrap();
        let old = state
            .checkpoint_as("deck", Some("Original version".into()), &fixture.actor)
            .unwrap();
        state
            .upload_asset(
                "deck",
                &slide.id,
                "photo.png",
                b"new image",
                None,
                &fixture.actor,
            )
            .unwrap();
        slide.name = "New name".into();
        state
            .write_slide(
                "deck",
                &slide.id,
                WriteSlideRequest {
                    base_slide: None,
                    base_notes: None,
                    slide: slide.clone(),
                    notes: Some("New notes".into()),
                    session_id: None,
                },
                &fixture.actor,
            )
            .unwrap();
        let added = state
            .create_slide(
                "deck",
                serde_json::from_value(json!({})).unwrap(),
                &fixture.actor,
            )
            .unwrap();
        let head = state
            .checkpoint_as("deck", Some("Added slide".into()), &fixture.actor)
            .unwrap();
        // Unsaved-to-Git work must also remain recoverable after restoration.
        state
            .write_notes(
                "deck",
                &slide.id,
                WriteNotesRequest {
                    base_notes: None,
                    notes: "Latest working notes".into(),
                    session_id: None,
                },
                &fixture.actor,
            )
            .unwrap();
        let snapshot = state
            .commit_snapshot("deck", "main", &old.id, &fixture.actor)
            .unwrap();
        assert_eq!(snapshot.notes[&slide.id], "Old notes");
        assert!(!snapshot.deck.slides.contains(&added.slide.id));
        let image = snapshot
            .slides
            .iter()
            .find(|item| item.id == slide.id)
            .unwrap()
            .elements["photo"]
            .src
            .as_ref()
            .unwrap();
        assert!(image.contains(&format!("commit={}", old.id)));
        assert_eq!(
            state
                .read_asset_at_commit(
                    "deck",
                    &slide.id,
                    "photo.png",
                    "main",
                    &old.id,
                    &fixture.actor
                )
                .unwrap()
                .0,
            b"old image"
        );
        let restored = state
            .restore_commit("deck", "main", &old.id, &head.id, &fixture.actor)
            .unwrap();
        assert_ne!(restored.id, old.id);
        let repo = state.open_repo("deck").unwrap();
        assert_eq!(
            repo.head().unwrap().peel_to_commit().unwrap().tree_id(),
            repo.find_commit(Oid::from_str(&old.id).unwrap())
                .unwrap()
                .tree_id()
        );
        assert!(!fixture
            .state
            .deck_path("deck")
            .unwrap()
            .join("slides")
            .join(&added.slide.id)
            .exists());
        assert_eq!(
            state.read_slide("deck", &slide.id).unwrap().notes,
            "Old notes"
        );
        let page = state
            .history_page("deck", "main", &fixture.actor, None, 40)
            .unwrap();
        let backup = page
            .commits
            .iter()
            .find(|commit| commit.summary == "Checkpoint before restoring a version")
            .unwrap();
        assert_eq!(
            state
                .commit_snapshot("deck", "main", &backup.id, &fixture.actor)
                .unwrap()
                .notes[&slide.id],
            "Latest working notes"
        );
        assert!(page.commits.iter().any(|commit| commit.id == head.id));
    }

    #[test]
    fn history_paginates_without_duplicates_and_enforces_branch_access() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        for index in 0..5 {
            let mut slide = fixture.slide.clone();
            slide.name = format!("Version {index}");
            state
                .write_slide(
                    "deck",
                    &slide.id,
                    WriteSlideRequest {
                        base_slide: None,
                        base_notes: None,
                        slide: slide.clone(),
                        notes: None,
                        session_id: None,
                    },
                    &fixture.actor,
                )
                .unwrap();
            state.checkpoint_as("deck", None, &fixture.actor).unwrap();
        }
        let mut ids = Vec::new();
        let mut cursor = None;
        loop {
            let page = state
                .history_page("deck", "main", &fixture.actor, cursor.as_deref(), 2)
                .unwrap();
            ids.extend(page.commits.into_iter().map(|commit| commit.id));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 6);
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 6);
        let stranger = state.create_demo_user("stranger").unwrap();
        assert!(matches!(
            state.history_page("deck", "main", &stranger, None, 40),
            Err(AppError::Forbidden(_))
        ));
        let root = state.open_repo("deck").unwrap();
        root.branch(
            "private",
            &root.head().unwrap().peel_to_commit().unwrap(),
            false,
        )
        .unwrap();
        let private = state.repo_for_branch("deck", "private").unwrap();
        fs::write(
            workdir(&private).unwrap().join("private.txt"),
            "private branch",
        )
        .unwrap();
        let secret = commit_all_as(&private, "Private version", &[], &fixture.actor).unwrap();
        assert!(matches!(
            state.commit_snapshot("deck", "main", &secret.id, &fixture.actor),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            state.read_asset_at_commit(
                "deck",
                &fixture.slide.id,
                "photo.png",
                "main",
                &secret.id,
                &fixture.actor
            ),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn restore_rejects_stale_history_and_other_editors_locks() {
        let fixture = Fixture::new();
        let state = &fixture.state;
        let head = state.commits("deck", 1).unwrap()[0].id.clone();
        assert!(matches!(
            state.restore_commit("deck", "main", &head, "outdated", &fixture.actor),
            Err(AppError::Conflict(_))
        ));
        state.object_locks.lock().insert(
            ("deck".into(), "main".into(), "busy-object".into()),
            (
                "another-user".into(),
                None,
                Instant::now() + Duration::from_secs(15),
            ),
        );
        assert!(matches!(
            state.restore_commit("deck", "main", &head, &head, &fixture.actor),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(state.commits("deck", 1).unwrap()[0].id, head);
        let viewer = state.create_demo_user("viewer").unwrap();
        state
            .set_deck_member(
                "deck",
                &fixture.actor,
                SetDeckMemberRequest {
                    username: viewer.username.clone(),
                    branch: "main".into(),
                    role: DeckRole::View,
                },
            )
            .unwrap();
        assert!(state
            .commit_snapshot("deck", "main", &head, &viewer)
            .is_ok());
        assert!(matches!(
            state.restore_commit("deck", "main", &head, &head, &viewer),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn dragging_one_shape_does_not_require_locks_on_unchanged_labels() {
        let fixture = Fixture::new();
        let original = fixture
            .state
            .read_slide("deck", "s_03_merge")
            .unwrap()
            .slide;
        assert_eq!(
            original.elements["el_a_label"].style["fontSize"],
            json!(34.0)
        );
        // JSON.parse/stringify in browsers emits 34 for the server's 34.0.
        fn browser_numbers(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Number(number) if number.is_f64() => {
                    let float = number.as_f64().unwrap();
                    if float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_991.0 {
                        *value = json!(float as i64);
                    }
                }
                serde_json::Value::Object(map) => map.values_mut().for_each(browser_numbers),
                serde_json::Value::Array(array) => array.iter_mut().for_each(browser_numbers),
                _ => {}
            }
        }
        let mut wire = serde_json::to_value(&original).unwrap();
        browser_numbers(&mut wire);
        let mut dragged: Slide = serde_json::from_value(wire).unwrap();
        dragged.elements.get_mut("el_a").unwrap().x += 50.0;
        fixture
            .state
            .acquire_object_locks("deck", "main", &fixture.actor, &["el_a".into()])
            .unwrap();
        fixture
            .state
            .assert_slide_locks("deck", &dragged.id, None, &fixture.actor, &dragged)
            .unwrap();
        let request = WriteSlideRequest {
            base_slide: None,
            base_notes: None,
            slide: dragged.clone(),
            notes: None,
            session_id: None,
        };
        fixture
            .state
            .write_slide("deck", &dragged.id, request, &fixture.actor)
            .unwrap();
        dragged.elements.get_mut("el_a").unwrap().x += 25.0;
        fixture
            .state
            .assert_slide_locks("deck", &dragged.id, None, &fixture.actor, &dragged)
            .unwrap();
        // A real label change must still need its own lock.
        dragged
            .elements
            .get_mut("el_a_label")
            .unwrap()
            .style
            .insert("fontSize".into(), json!(35));
        assert!(fixture
            .state
            .assert_slide_locks("deck", &dragged.id, None, &fixture.actor, &dragged)
            .is_err());
    }

    #[test]
    fn bulk_edits_and_deletions_save_with_all_changed_locks_and_notes() {
        let fixture = Fixture::new();
        let mut slide = fixture.slide.clone();
        let ids: Vec<_> = slide.elements.keys().cloned().collect();
        assert!(ids.len() > 1);
        for element in slide.elements.values_mut() {
            element.opacity = Some(0.5);
        }
        slide.elements.remove(&ids[0]);
        assert!(fixture
            .state
            .assert_slide_locks("deck", &slide.id, None, &fixture.actor, &slide)
            .is_err());
        fixture
            .state
            .acquire_object_locks("deck", "main", &fixture.actor, &ids)
            .unwrap();
        fixture
            .state
            .assert_slide_locks("deck", &slide.id, None, &fixture.actor, &slide)
            .unwrap();
        let req = WriteSlideRequest {
            base_slide: None,
            base_notes: None,
            slide: slide.clone(),
            notes: Some("Combined notes".into()),
            session_id: None,
        };
        let payload = fixture
            .state
            .write_slide("deck", &slide.id, req, &fixture.actor)
            .unwrap();
        assert!(!payload.slide.elements.contains_key(&ids[0]));
        assert!(payload
            .slide
            .elements
            .values()
            .all(|element| element.opacity == Some(0.5)));
        assert_eq!(payload.notes, "Combined notes");
        // A different active owner must still prevent writes.
        fixture.state.object_locks.lock().insert(
            ("deck".into(), "main".into(), ids[1].clone()),
            (
                "another-user".into(),
                None,
                Instant::now() + Duration::from_secs(15),
            ),
        );
        slide.elements.get_mut(&ids[1]).unwrap().opacity = Some(0.7);
        assert!(fixture
            .state
            .assert_slide_locks("deck", &slide.id, None, &fixture.actor, &slide)
            .is_err());
    }

    #[test]
    fn contextual_image_urls_do_not_require_locks_or_persist_identity() {
        let fixture = Fixture::new();
        let mut slide = fixture.slide.clone();
        let id = slide.elements.keys().next().unwrap().clone();
        let path = format!("/api/decks/deck/slides/{}/assets/photo.png", slide.id);
        slide.elements.get_mut(&id).unwrap().src = Some(path.clone());
        let disk_path = fixture
            .state
            .deck_path("deck")
            .unwrap()
            .join("slides")
            .join(&slide.id)
            .join("slide.json");
        write_json_atomic(&disk_path, &slide).unwrap();
        let mut loaded = fixture
            .state
            .read_slide_for_branch("deck", &slide.id, "main", &fixture.actor)
            .unwrap()
            .slide;
        assert!(loaded.elements[&id]
            .src
            .as_ref()
            .unwrap()
            .contains("demoUserId="));
        fixture
            .state
            .assert_slide_locks("deck", &slide.id, None, &fixture.actor, &loaded)
            .unwrap();
        // Also normalize a previously persisted URL from another profile.
        slide.elements.get_mut(&id).unwrap().src =
            Some(format!("{path}?branch=main&demoUserId=previous-user"));
        write_json_atomic(&disk_path, &slide).unwrap();
        loaded.name = "Renamed".into();
        fixture
            .state
            .assert_slide_locks("deck", &slide.id, None, &fixture.actor, &loaded)
            .unwrap();
        let req = WriteSlideRequest {
            base_slide: None,
            base_notes: None,
            slide: loaded.clone(),
            notes: None,
            session_id: None,
        };
        fixture
            .state
            .write_slide("deck", &loaded.id, req, &fixture.actor)
            .unwrap();
        let persisted: Slide = read_json(&disk_path).unwrap();
        assert_eq!(persisted.elements[&id].src.as_deref(), Some(path.as_str()));
    }
}
