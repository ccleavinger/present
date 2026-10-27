use git2::{BranchType, Oid, Repository, Tree};
use present_domain::*;
use present_store::error::{AppError, AppResult};
use present_store::jsonutil::{write_atomic, write_json_atomic};
use present_store::store::{commit_all_as, current_branch, merge_commit_as, workdir, AppState};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;

type Choice = ResolutionChoice;

type Choices = HashMap<(String, String), Choice>;

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub deck: Deck,
    pub slides: BTreeMap<String, Slide>,
    pub notes: BTreeMap<String, String>,
    pub slide_ids: BTreeSet<String>,
}

struct MergeCtx {
    conflicts: Vec<MergeConflict>,
    choices: Choices,
    record: bool,
}

impl MergeCtx {
    fn new(choices: Choices, record: bool) -> Self {
        Self {
            conflicts: Vec::new(),
            choices,
            record,
        }
    }
}

/// 3-way merge of JSON-shaped documents. Disjoint property edits on the same
/// entity merge cleanly; overlapping edits become conflicts.
fn merge_optional(
    base: &Option<Value>,
    ours: &Option<Value>,
    theirs: &Option<Value>,
    path: &mut Vec<String>,
    scope: &str,
    root: &str,
    ctx: &mut MergeCtx,
) -> Option<Value> {
    if ours == theirs {
        return ours.clone();
    }
    if base == ours {
        return theirs.clone();
    }
    if base == theirs {
        return ours.clone();
    }

    // Both sides added an object (or all three are objects): merge fields.
    let empty = serde_json::Map::new();
    let base_obj = match base {
        Some(Value::Object(map)) => Some(map),
        None => Some(&empty),
        _ => None,
    };
    let ours_obj = ours.as_ref().and_then(Value::as_object);
    let theirs_obj = theirs.as_ref().and_then(Value::as_object);
    if let (Some(base_obj), Some(ours_obj), Some(theirs_obj)) = (base_obj, ours_obj, theirs_obj) {
        let mut keys = BTreeSet::new();
        keys.extend(base_obj.keys().cloned());
        keys.extend(ours_obj.keys().cloned());
        keys.extend(theirs_obj.keys().cloned());
        let mut merged = serde_json::Map::new();
        for key in keys {
            path.push(key.clone());
            let child = merge_optional(
                &base_obj.get(&key).cloned(),
                &ours_obj.get(&key).cloned(),
                &theirs_obj.get(&key).cloned(),
                path,
                scope,
                root,
                ctx,
            );
            path.pop();
            if let Some(value) = child {
                merged.insert(key, value);
            }
        }
        return Some(Value::Object(merged));
    }

    let path_str = if path.is_empty() {
        root.to_string()
    } else {
        path.join("/")
    };
    let choice = ctx
        .choices
        .get(&(scope.to_string(), path_str.clone()))
        .copied();
    match choice {
        Some(Choice::Theirs) => return theirs.clone(),
        Some(Choice::Ours) => return ours.clone(),
        None => {}
    }
    if ctx.record {
        let element_id = if path.first().map(String::as_str) == Some("elements") {
            path.get(1).cloned()
        } else {
            None
        };
        ctx.conflicts.push(MergeConflict {
            path: path_str,
            scope: scope.to_string(),
            element_id,
            base: base.clone().unwrap_or(Value::Null),
            ours: ours.clone().unwrap_or(Value::Null),
            theirs: theirs.clone().unwrap_or(Value::Null),
        });
    }
    ours.clone()
}

fn json_opt<T: serde::Serialize>(value: Option<&T>) -> AppResult<Option<Value>> {
    value
        .map(serde_json::to_value)
        .transpose()
        .map_err(Into::into)
}

fn status_for(
    merged: &Option<Value>,
    base: &Option<Value>,
    ours: &Option<Value>,
    conflicts: bool,
) -> MergeStatus {
    if conflicts {
        MergeStatus::Conflict
    } else if merged == base {
        MergeStatus::Unchanged
    } else if merged == ours {
        MergeStatus::Modified
    } else {
        MergeStatus::Merged
    }
}

pub fn load_snapshot(repo: &Repository, branch: &str) -> AppResult<(Snapshot, Oid)> {
    let branch_ref = match repo.find_branch(branch, BranchType::Local) {
        Ok(branch) => branch,
        Err(err) if err.code() == git2::ErrorCode::NotFound => {
            return Err(AppError::NotFound(format!("branch '{branch}' not found")));
        }
        Err(err) => return Err(err.into()),
    };
    let commit = branch_ref.get().peel_to_commit()?;
    let oid = commit.id();
    let tree = commit.tree()?;
    let deck_bytes = blob_at(repo, &tree, "deck.json")?
        .ok_or_else(|| AppError::Internal(format!("branch '{branch}' has no deck.json")))?;
    let deck: Deck = serde_json::from_slice(&deck_bytes)?;

    let mut slide_ids: BTreeSet<String> = deck.slides.iter().cloned().collect();
    slide_ids.extend(slide_dirs(repo, &tree)?);

    let mut slides = BTreeMap::new();
    let mut notes = BTreeMap::new();
    for slide_id in &slide_ids {
        let slide_path = format!("slides/{slide_id}/slide.json");
        if let Some(bytes) = blob_at(repo, &tree, &slide_path)? {
            match serde_json::from_slice::<Slide>(&bytes) {
                Ok(slide) => {
                    slides.insert(slide_id.clone(), slide);
                }
                Err(err) => {
                    tracing::warn!(slide = %slide_id, error = %err, "skipping malformed slide")
                }
            }
        }
        let notes_path = format!("slides/{slide_id}/notes.md");
        if let Some(bytes) = blob_at(repo, &tree, &notes_path)? {
            notes.insert(
                slide_id.clone(),
                String::from_utf8_lossy(&bytes).to_string(),
            );
        }
    }

    Ok((
        Snapshot {
            deck,
            slides,
            notes,
            slide_ids,
        },
        oid,
    ))
}

fn preview(
    state: &AppState,
    deck_id: &str,
    source: &str,
    target: Option<&str>,
    choices: Choices,
) -> AppResult<(MergePreview, Oid, Oid, Option<Oid>)> {
    let repo = state.open_repo(deck_id)?;
    let target = target.map(str::to_owned).unwrap_or(current_branch(&repo)?);
    if source == target {
        return Err(AppError::BadRequest(
            "source and target branches must differ".into(),
        ));
    }
    let (ours_snap, ours_oid) = load_snapshot(&repo, &target)?;
    let (theirs_snap, theirs_oid) = load_snapshot(&repo, source)?;
    let base_oid = match repo.merge_base(ours_oid, theirs_oid) {
        Ok(oid) => Some(oid),
        Err(err) if err.code() == git2::ErrorCode::NotFound => None,
        Err(err) => return Err(err.into()),
    };
    let base_snap = match base_oid {
        Some(oid) => Some(snapshot_at(&repo, oid)?),
        None => None,
    };
    let preview = merge_snapshots(
        &target,
        source,
        &ours_snap,
        &theirs_snap,
        base_snap.as_ref(),
        ours_oid,
        theirs_oid,
        base_oid,
        choices,
    )?;
    Ok((preview, ours_oid, theirs_oid, base_oid))
}

pub fn preview_api(
    state: &AppState,
    deck_id: &str,
    source: &str,
    target: Option<&str>,
) -> AppResult<MergePreview> {
    Ok(preview(state, deck_id, source, target, HashMap::new())?.0)
}

fn snapshot_at(repo: &Repository, oid: Oid) -> AppResult<Snapshot> {
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let deck_bytes = blob_at(repo, &tree, "deck.json")?
        .ok_or_else(|| AppError::Internal("merge base has no deck.json".into()))?;
    let deck: Deck = serde_json::from_slice(&deck_bytes)?;
    let mut slide_ids: BTreeSet<String> = deck.slides.iter().cloned().collect();
    slide_ids.extend(slide_dirs(repo, &tree)?);
    let mut slides = BTreeMap::new();
    let mut notes = BTreeMap::new();
    for slide_id in &slide_ids {
        if let Some(bytes) = blob_at(repo, &tree, &format!("slides/{slide_id}/slide.json"))? {
            match serde_json::from_slice::<Slide>(&bytes) {
                Ok(slide) => {
                    slides.insert(slide_id.clone(), slide);
                }
                Err(err) => {
                    tracing::warn!(slide = %slide_id, error = %err, "skipping malformed slide")
                }
            }
        }
        if let Some(bytes) = blob_at(repo, &tree, &format!("slides/{slide_id}/notes.md"))? {
            notes.insert(
                slide_id.clone(),
                String::from_utf8_lossy(&bytes).to_string(),
            );
        }
    }
    Ok(Snapshot {
        deck,
        slides,
        notes,
        slide_ids,
    })
}

#[allow(clippy::too_many_arguments)]
fn merge_snapshots(
    target: &str,
    source: &str,
    ours: &Snapshot,
    theirs: &Snapshot,
    base: Option<&Snapshot>,
    ours_oid: Oid,
    theirs_oid: Oid,
    base_oid: Option<Oid>,
    choices: Choices,
) -> AppResult<MergePreview> {
    // ---- deck.json -----------------------------------------------------
    let base_deck = match base {
        Some(snap) => json_opt(Some(&snap.deck))?,
        None => None,
    };
    let ours_deck = json_opt(Some(&ours.deck))?;
    let theirs_deck = json_opt(Some(&theirs.deck))?;
    let mut deck_ctx = MergeCtx::new(choices.clone(), true);
    let merged_deck_value = merge_optional(
        &base_deck,
        &ours_deck,
        &theirs_deck,
        &mut Vec::new(),
        "deck",
        "__deck__",
        &mut deck_ctx,
    )
    .ok_or_else(|| AppError::Internal("merge produced no deck.json".into()))?;
    let merged_deck: Deck = serde_json::from_value(merged_deck_value)?;
    let deck_status = status_for(
        &json_opt(Some(&merged_deck))?,
        &base_deck,
        &ours_deck,
        !deck_ctx.conflicts.is_empty(),
    );

    let mut slide_ids = BTreeSet::new();
    slide_ids.extend(ours.slide_ids.iter().cloned());
    slide_ids.extend(theirs.slide_ids.iter().cloned());
    if let Some(base) = base {
        slide_ids.extend(base.slide_ids.iter().cloned());
    }
    slide_ids.extend(merged_deck.slides.iter().cloned());

    // ---- slides --------------------------------------------------------
    let mut slides = Vec::new();
    let mut notes_out = Vec::new();
    let mut conflict_count = deck_ctx.conflicts.len();
    let mut changed_count = if deck_status == MergeStatus::Unchanged {
        0
    } else {
        1
    };

    for slide_id in slide_ids {
        let scope = format!("slide:{slide_id}");
        let base_slide = base.and_then(|b| b.slides.get(&slide_id));
        let ours_slide = ours.slides.get(&slide_id);
        let theirs_slide = theirs.slides.get(&slide_id);
        let base_v = json_opt(base_slide)?;
        let ours_v = json_opt(ours_slide)?;
        let theirs_v = json_opt(theirs_slide)?;
        let mut ctx = MergeCtx::new(choices.clone(), true);
        let merged_v = merge_optional(
            &base_v,
            &ours_v,
            &theirs_v,
            &mut Vec::new(),
            &scope,
            "__slide__",
            &mut ctx,
        );
        let merged: Option<Slide> = match merged_v {
            Some(value) => Some(serde_json::from_value(value)?),
            None => None,
        };
        conflict_count += ctx.conflicts.len();
        let status = status_for(
            &json_opt(merged.as_ref())?,
            &base_v,
            &ours_v,
            !ctx.conflicts.is_empty(),
        );
        if status != MergeStatus::Unchanged {
            changed_count += 1;
        }
        slides.push(SlideMerge {
            slide_id: slide_id.clone(),
            status,
            merged,
            ours: ours_slide.cloned(),
            theirs: theirs_slide.cloned(),
            conflicts: ctx.conflicts,
        });

        // ---- notes.md --------------------------------------------------
        let scope = format!("notes:{slide_id}");
        let base_note = base.and_then(|b| b.notes.get(&slide_id)).cloned();
        let ours_note = ours.notes.get(&slide_id).cloned();
        let theirs_note = theirs.notes.get(&slide_id).cloned();
        let mut ctx = MergeCtx::new(choices.clone(), true);
        let merged_note = if ours_note == theirs_note {
            ours_note.clone()
        } else if base_note == ours_note {
            theirs_note.clone()
        } else if base_note == theirs_note {
            ours_note.clone()
        } else {
            let choice = ctx
                .choices
                .get(&(scope.clone(), "__notes__".to_string()))
                .copied();
            match choice {
                Some(Choice::Theirs) => theirs_note.clone(),
                Some(Choice::Ours) => ours_note.clone(),
                None => {
                    ctx.conflicts.push(MergeConflict {
                        path: "__notes__".into(),
                        scope: scope.clone(),
                        element_id: None,
                        base: base_note.clone().map(Value::String).unwrap_or(Value::Null),
                        ours: ours_note.clone().map(Value::String).unwrap_or(Value::Null),
                        theirs: theirs_note
                            .clone()
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    });
                    ours_note.clone()
                }
            }
        };
        let status = if !ctx.conflicts.is_empty() {
            MergeStatus::Conflict
        } else if merged_note == base_note {
            MergeStatus::Unchanged
        } else {
            MergeStatus::Modified
        };
        conflict_count += ctx.conflicts.len();
        if status != MergeStatus::Unchanged {
            changed_count += 1;
        }
        notes_out.push(NotesMerge {
            slide_id,
            status,
            merged: merged_note.unwrap_or_default(),
            ours: ours_note.unwrap_or_default(),
            theirs: theirs_note.unwrap_or_default(),
            conflicts: ctx.conflicts,
        });
    }

    slides.sort_by(|a, b| a.slide_id.cmp(&b.slide_id));
    notes_out.sort_by(|a, b| a.slide_id.cmp(&b.slide_id));

    Ok(MergePreview {
        target: target.to_string(),
        source: source.to_string(),
        ours_commit: ours_oid.to_string(),
        theirs_commit: theirs_oid.to_string(),
        base_commit: base_oid.map(|o| o.to_string()),
        deck: DeckMerge {
            status: deck_status,
            merged: merged_deck,
            ours: ours.deck.clone(),
            theirs: theirs.deck.clone(),
            conflicts: deck_ctx.conflicts,
        },
        slides,
        notes: notes_out,
        conflict_count,
        changed_count,
    })
}

pub fn apply(
    state: &AppState,
    deck_id: &str,
    req: ApplyMergeRequest,
    actor: &DemoUser,
) -> AppResult<CommitInfo> {
    state.validate_session_actor(deck_id, req.session_id.as_deref(), actor)?;
    let repo = match req.session_id.as_deref() {
        Some(session) => state.repo_for_session(session)?,
        None => state.open_repo(deck_id)?,
    };
    let target = current_branch(&repo)?;
    state.require_deck_role(deck_id, actor, &req.source, present_domain::DeckRole::View)?;
    state.require_deck_role(deck_id, actor, &target, present_domain::DeckRole::Edit)?;
    if req.source == target {
        return Err(AppError::BadRequest(
            "source and target branches must differ".into(),
        ));
    }
    // Never merge over uncommitted work: fold it into a checkpoint first.
    commit_all_as(&repo, "Checkpoint before merge", &[], actor)?;

    let mut choices = Choices::new();
    for resolution in &req.resolutions {
        let choice = match resolution.choice {
            ResolutionChoice::Ours => Choice::Ours,
            ResolutionChoice::Theirs => Choice::Theirs,
        };
        choices.insert((resolution.scope.clone(), resolution.path.clone()), choice);
    }

    let (merged, ours_oid, theirs_oid, _) =
        preview(state, deck_id, &req.source, Some(&target), choices)?;

    write_merged_snapshot(&repo, &merged, theirs_oid)?;
    let message = req
        .message
        .unwrap_or_else(|| format!("Merge branch '{}' into {}", req.source, target));
    merge_commit_as(&repo, &message, ours_oid, theirs_oid, actor)
}

fn write_merged_snapshot(repo: &Repository, merged: &MergePreview, theirs: Oid) -> AppResult<()> {
    let workdir = workdir(repo)?.to_path_buf();
    write_json_atomic(&workdir.join("deck.json"), &merged.deck.merged)?;

    let mut final_slides = HashSet::new();
    let notes: HashMap<&str, &NotesMerge> = merged
        .notes
        .iter()
        .map(|n| (n.slide_id.as_str(), n))
        .collect();

    for slide_merge in &merged.slides {
        if !merged
            .deck
            .merged
            .slides
            .iter()
            .any(|s| s == &slide_merge.slide_id)
        {
            continue;
        }
        let Some(slide) = &slide_merge.merged else {
            continue;
        };
        final_slides.insert(slide_merge.slide_id.clone());
        let dir = workdir.join("slides").join(&slide_merge.slide_id);
        write_json_atomic(&dir.join("slide.json"), slide)?;
        if let Some(note) = notes.get(slide_merge.slide_id.as_str()) {
            write_atomic(&dir.join("notes.md"), note.merged.as_bytes())?;
        }
        fs::create_dir_all(dir.join("assets"))?;
        write_atomic(&dir.join("assets/.gitkeep"), b"")?;
    }

    // Remove slide folders that the merged deck no longer references.
    let slides_root = workdir.join("slides");
    if slides_root.is_dir() {
        for entry in fs::read_dir(&slides_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !final_slides.contains(&name) {
                fs::remove_dir_all(entry.path())?;
            }
        }
    }

    // Bring over assets introduced by the source branch. Existing files win,
    // so a merged slide keeps locally modified assets.
    let theirs_tree = repo.find_commit(theirs)?.tree()?;
    for slide_id in &final_slides {
        let prefix = format!("slides/{slide_id}/assets/");
        copy_missing_assets(repo, &theirs_tree, &prefix, &workdir)?;
    }
    Ok(())
}

fn copy_missing_assets(
    repo: &Repository,
    tree: &Tree,
    prefix: &str,
    workdir: &Path,
) -> AppResult<()> {
    let entry = match tree.get_path(Path::new(prefix.trim_end_matches('/'))) {
        Ok(entry) => entry,
        Err(err) if err.code() == git2::ErrorCode::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    let object = entry.to_object(repo)?;
    let Some(assets_tree) = object.as_tree() else {
        return Ok(());
    };
    for entry in assets_tree.iter() {
        if entry.kind() != Some(git2::ObjectType::Blob) {
            continue;
        }
        let name = entry.name()?;
        let entry_object = entry.to_object(repo)?;
        let Some(blob) = entry_object.as_blob() else {
            continue;
        };
        let dest = workdir.join(prefix).join(name);
        if !dest.exists() {
            write_atomic(&dest, blob.content())?;
        }
    }
    Ok(())
}

fn blob_at(repo: &Repository, tree: &Tree, path: &str) -> AppResult<Option<Vec<u8>>> {
    let entry = match tree.get_path(Path::new(path)) {
        Ok(entry) => entry,
        Err(err) if err.code() == git2::ErrorCode::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    let object = entry.to_object(repo)?;
    Ok(object.as_blob().map(|blob| blob.content().to_vec()))
}

fn slide_dirs(repo: &Repository, tree: &Tree) -> AppResult<Vec<String>> {
    let entry = match tree.get_path(Path::new("slides")) {
        Ok(entry) => entry,
        Err(err) if err.code() == git2::ErrorCode::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let object = entry.to_object(repo)?;
    let Some(tree) = object.as_tree() else {
        return Ok(Vec::new());
    };
    let mut dirs = Vec::new();
    for entry in tree.iter() {
        if entry.kind() == Some(git2::ObjectType::Tree) {
            dirs.push(entry.name()?.to_string());
        }
    }
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn merge(base: Value, ours: Value, theirs: Value) -> (Value, Vec<MergeConflict>) {
        let mut ctx = MergeCtx::new(HashMap::new(), true);
        let merged = merge_optional(
            &Some(base),
            &Some(ours),
            &Some(theirs),
            &mut Vec::new(),
            "slide:s1",
            "__slide__",
            &mut ctx,
        )
        .unwrap();
        (merged, ctx.conflicts)
    }

    #[test]
    fn merges_disjoint_properties() {
        let base = json!({"elements": {"el": {"x": 10, "style": {"fontSize": 20}}}});
        let ours = json!({"elements": {"el": {"x": 10, "style": {"fontSize": 42}}}});
        let theirs = json!({"elements": {"el": {"x": 90, "style": {"fontSize": 20}}}});
        let (merged, conflicts) = merge(base, ours, theirs);
        assert!(conflicts.is_empty());
        assert_eq!(merged["elements"]["el"]["x"], 90);
        assert_eq!(merged["elements"]["el"]["style"]["fontSize"], 42);
    }

    #[test]
    fn flags_overlapping_properties() {
        let base = json!({"elements": {"el": {"x": 10}}});
        let ours = json!({"elements": {"el": {"x": 20}}});
        let theirs = json!({"elements": {"el": {"x": 30}}});
        let (merged, conflicts) = merge(base, ours, theirs);
        assert_eq!(merged["elements"]["el"]["x"], 20);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].path, "elements/el/x");
        assert_eq!(conflicts[0].element_id.as_deref(), Some("el"));
    }

    #[test]
    fn resolution_takes_theirs() {
        let base = json!({"x": 1});
        let ours = json!({"x": 2});
        let theirs = json!({"x": 3});
        let mut choices = HashMap::new();
        choices.insert(("slide:s1".to_string(), "x".to_string()), Choice::Theirs);
        let mut ctx = MergeCtx::new(choices, true);
        let merged = merge_optional(
            &Some(base),
            &Some(ours),
            &Some(theirs),
            &mut Vec::new(),
            "slide:s1",
            "__slide__",
            &mut ctx,
        )
        .unwrap();
        assert_eq!(merged["x"], 3);
        assert!(ctx.conflicts.is_empty());
    }
}
