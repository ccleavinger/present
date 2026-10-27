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
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub animations: Vec<SlideAnimation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<SlideTransition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlideAnimation {
    pub id: String,
    pub element_id: String,
    pub effect: String,
    #[serde(default)]
    pub order: u32,
    #[serde(default = "default_animation_duration")]
    pub duration_ms: u32,
    #[serde(default)]
    pub delay_ms: u32,
    #[serde(default = "default_animation_trigger")]
    pub trigger: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlideTransition {
    pub effect: String,
    #[serde(default = "default_transition_duration")]
    pub duration_ms: u32,
    #[serde(default = "default_transition_direction")]
    pub direction: String,
}

fn default_animation_duration() -> u32 { 500 }
fn default_animation_trigger() -> String { "click".to_owned() }
fn default_transition_duration() -> u32 { 500 }
fn default_transition_direction() -> String { "left".to_owned() }

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
            animations: Vec::new(),
            transition: None,
        }
    }
}

/// A single entity in a slide. Coordinates live in the fixed 1920x1080 space.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    #[serde(default)]
    pub current_user_role: Option<DeckRole>,
    #[serde(default)]
    pub is_owner: bool,
    #[serde(default)]
    pub collaborators: Vec<DemoUser>,
    #[serde(default)]
    pub first_slide_id: Option<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub commits: Vec<CommitInfo>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSnapshot {
    pub commit: CommitInfo,
    pub deck: Deck,
    pub slides: Vec<Slide>,
    pub notes: BTreeMap<String, String>,
}

/// A password-free demo identity for local and trusted-network installations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DemoUser {
    pub id: String,
    #[serde(default)]
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDemoUserRequest {
    #[serde(default)]
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum DeckRole {
    View,
    Comment,
    Edit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckMember {
    pub user: DemoUser,
    pub branches: BTreeMap<String, DeckRole>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCollaboration {
    pub owner: DemoUser,
    pub members: Vec<DeckMember>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDeckMemberRequest {
    pub username: String,
    pub branch: String,
    pub role: DeckRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub id: String,
    pub token: String,
    pub branch: String,
    pub role: DeckRole,
    pub created_at: i64,
    pub joined_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareLinkRequest {
    pub branch: String,
    pub role: DeckRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkPreview {
    pub deck_id: String,
    pub title: String,
    pub branch: String,
    pub role: DeckRole,
    pub owner: DemoUser,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectComment {
    pub id: String,
    pub slide_id: String,
    pub object_id: String,
    pub author: DemoUser,
    pub message: String,
    pub parent_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateObjectCommentRequest {
    pub slide_id: String,
    pub object_id: String,
    pub message: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateObjectCommentRequest {
    pub message: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideTemplate {
    pub id: String,
    pub name: String,
    pub slide: Slide,
}

/// A reusable deck template. Script templates store both their generator and
/// its last concrete output; scripts are never needed while rendering slides.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TemplateBundleKind {
    Visual,
    Code,
    Pptx,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateBundle {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Kept for compatibility with template bundles imported by older builds.
    pub kind: TemplateBundleKind,
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub generator: Option<String>,
    #[serde(default)]
    pub initial_slides: Vec<Slide>,
    #[serde(default)]
    pub slide_options: Vec<TemplateSlideOption>,
    #[serde(default)]
    pub custom_object_types: Vec<CustomObjectDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateBundleSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: TemplateBundleKind,
    pub version: u32,
    pub initial_slide_count: usize,
    pub slide_option_count: usize,
    pub custom_object_type_count: usize,
}

impl From<&TemplateBundle> for TemplateBundleSummary {
    fn from(bundle: &TemplateBundle) -> Self {
        Self {
            id: bundle.id.clone(),
            name: bundle.name.clone(),
            description: bundle.description.clone(),
            kind: bundle.kind,
            version: bundle.version,
            initial_slide_count: bundle.initial_slides.len(),
            slide_option_count: bundle.slide_options.len(),
            custom_object_type_count: bundle.custom_object_types.len(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSlideOption {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub slides: Vec<Slide>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomObjectDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub inputs: Vec<CustomObjectInput>,
    /// Generates only renderer-safe drawing instructions, never markup.
    pub generator: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomObjectInput {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: CustomObjectInputKind,
    #[serde(default)]
    pub default_value: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CustomObjectInputKind {
    Text,
    Number,
    Color,
    Boolean,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeStatus {
    Conflict,
    Unchanged,
    Modified,
    Merged,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResolutionChoice {
    Ours,
    Theirs,
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
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub template_bundle: Option<TemplateBundle>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDeckRequest {
    pub title: Option<String>,
    pub tokens: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSlideRequest {
    pub slide: Slide,
    #[serde(default)]
    pub base_slide: Option<Slide>,
    #[serde(default)]
    pub base_notes: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteNotesRequest {
    pub notes: String,
    #[serde(default)]
    pub base_notes: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlideRequest {
    pub name: Option<String>,
    pub after: Option<String>,
    #[serde(default)]
    pub template: Option<Slide>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSlideTemplateRequest {
    pub name: String,
    pub slide: Slide,
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
    pub status: MergeStatus,
    pub merged: Option<Slide>,
    pub ours: Option<Slide>,
    pub theirs: Option<Slide>,
    pub conflicts: Vec<MergeConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesMerge {
    pub slide_id: String,
    pub status: MergeStatus,
    pub merged: String,
    pub ours: String,
    pub theirs: String,
    pub conflicts: Vec<MergeConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckMerge {
    pub status: MergeStatus,
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
    pub choice: ResolutionChoice,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMergeRequest {
    pub source: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub resolutions: Vec<Resolution>,
    #[serde(default)]
    pub session_id: Option<String>,
}
