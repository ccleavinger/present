use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const CANVAS_WIDTH: f64 = 1920.0;
pub const CANVAS_HEIGHT: f64 = 1080.0;

/// `deck.json` — the repository-level manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    #[serde(default = "one")]
    pub version: u32,
    pub title: String,
    #[serde(default = "canvas_width")]
    pub width: f64,
    #[serde(default = "canvas_height")]
    pub height: f64,
    #[serde(default)]
    pub slides: Vec<String>,
    #[serde(default)]
    pub tokens: BTreeMap<String, Value>,
}

fn one() -> u32 {
    1
}
fn canvas_width() -> f64 {
    CANVAS_WIDTH
}
fn canvas_height() -> f64 {
    CANVAS_HEIGHT
}

impl Deck {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            version: 1,
            title: title.into(),
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
            slides: Vec::new(),
            tokens: BTreeMap::new(),
        }
    }
}

/// `slides/<id>/slide.json` — a flat element AST map.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Slide {
    #[serde(default = "one")]
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default = "white")]
    pub background: String,
    #[serde(default)]
    pub elements: BTreeMap<String, Element>,
}

fn white() -> String {
    "#fff6e9".into()
}

impl Slide {
    pub fn blank(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            version: 1,
            id: id.into(),
            name: name.into(),
            background: "#fff6e9".into(),
            elements: BTreeMap::new(),
        }
    }
}

/// A single entity in a slide. Coordinates live in the fixed 1920x1080 space.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub z: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub style: BTreeMap<String, Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for Element {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "rect".into(),
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 100.0,
            rotation: 0.0,
            z: 0,
            text: None,
            fill: None,
            stroke: None,
            stroke_width: None,
            src: None,
            opacity: None,
            style: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideSummary {
    pub id: String,
    pub name: String,
    pub background: String,
    pub index: usize,
    pub element_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSummary {
    pub id: String,
    pub title: String,
    pub slide_count: usize,
    pub current_branch: String,
    pub updated_at: i64,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub commit_id: String,
    pub summary: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
    pub committed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDetail {
    pub id: String,
    pub deck: Deck,
    pub slides: Vec<SlideSummary>,
    pub current_branch: String,
    pub branches: Vec<BranchInfo>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidePayload {
    pub slide: Slide,
    pub notes: String,
    pub assets: Vec<AssetInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub deck_id: String,
    pub branch: String,
    pub opened_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeckRequest {
    pub title: String,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDeckRequest {
    pub title: Option<String>,
    pub tokens: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSlideRequest {
    pub slide: Slide,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteNotesRequest {
    pub notes: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlideRequest {
    pub name: Option<String>,
    pub after: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderRequest {
    pub slides: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchRequest {
    pub name: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub checkout: bool,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRequest {
    pub branch: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Semantic merge types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    /// Slash-separated JSON path, or `__slide__` / `__notes__`.
    pub path: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
    pub base: Value,
    pub ours: Value,
    pub theirs: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideMerge {
    pub slide_id: String,
    pub status: String,
    pub merged: Option<Slide>,
    pub ours: Option<Slide>,
    pub theirs: Option<Slide>,
    pub conflicts: Vec<MergeConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesMerge {
    pub slide_id: String,
    pub status: String,
    pub merged: String,
    pub ours: String,
    pub theirs: String,
    pub conflicts: Vec<MergeConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckMerge {
    pub status: String,
    pub merged: Deck,
    pub ours: Deck,
    pub theirs: Deck,
    pub conflicts: Vec<MergeConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub target: String,
    pub source: String,
    pub ours_commit: String,
    pub theirs_commit: String,
    pub base_commit: Option<String>,
    pub deck: DeckMerge,
    pub slides: Vec<SlideMerge>,
    pub notes: Vec<NotesMerge>,
    pub conflict_count: usize,
    pub changed_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    /// `deck`, `slide:<id>`, or `notes:<id>`.
    pub scope: String,
    /// JSON path within the document, `__slide__`, or `__notes__`.
    pub path: String,
    /// `ours` or `theirs`.
    pub choice: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMergeRequest {
    pub source: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub resolutions: Vec<Resolution>,
}
