export interface SlideElement {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  text?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  src?: string;
  imageCrop?: ImageCrop;
  opacity?: number;
  style: Record<string, unknown>;
  customType?: string;
  customProps?: Record<string, unknown>;
  renderData?: CustomDrawCommand[];
  shapeParams?: {
    cornerRadius?: number;
    points?: number;
    innerRadius?: number;
    shaftWidth?: number;
    headLength?: number;
    headWidth?: number;
    tailPosition?: number;
    tailWidth?: number;
    tailLength?: number;
  };
  [key: string]: unknown;
}

/** Fractional rectangle in the original image, retained without modifying it. */
export interface ImageCrop { x: number; y: number; w: number; h: number; }

export interface CustomDrawCommand {
  type: "rect" | "circle" | "line" | "text";
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  text?: string;
}

export interface CustomObjectInput {
  id: string;
  label: string;
  type: "text" | "number" | "color" | "boolean";
  defaultValue: unknown;
}

export interface CustomObjectDefinition {
  id: string;
  name: string;
  inputs: CustomObjectInput[];
  generator: string;
}

export interface TemplateSlideOption {
  id: string;
  name: string;
  slides: Slide[];
}

export interface TemplateBundle {
  id: string;
  name: string;
  description: string;
  kind: "visual" | "code" | "pptx";
  version: number;
  generator?: string;
  initialSlides: Slide[];
  slideOptions: TemplateSlideOption[];
  customObjectTypes: CustomObjectDefinition[];
}

export interface TemplateBundleSummary {
  id: string;
  name: string;
  description: string;
  kind: TemplateBundle["kind"];
  version: number;
  initialSlideCount: number;
  slideOptionCount: number;
  customObjectTypeCount: number;
}

export interface Slide {
  version: number;
  id: string;
  name: string;
  background: string;
  elements: Record<string, SlideElement>;
  animations?: SlideAnimation[];
  transition?: SlideTransition;
}

export type AnimationEffect = "fade" | "rise" | "zoom" | "pulse" | "move" | "exit-fade" | "exit-rise";
export type AnimationTrigger = "click" | "with-previous" | "after-previous";
export type AnimationDirection = "left" | "right" | "up" | "down";

export interface SlideTransition {
  effect: "none" | "fade" | "push" | "wipe";
  durationMs: number;
  direction: AnimationDirection;
}

export interface SlideAnimation {
  id: string;
  elementId: string;
  effect: AnimationEffect;
  order: number;
  durationMs: number;
  delayMs: number;
  trigger?: AnimationTrigger;
  direction?: AnimationDirection;
}

export interface Deck {
  version: number;
  title: string;
  width: number;
  height: number;
  slides: string[];
  tokens: Record<string, unknown>;
}

export interface SlideSummary {
  id: string;
  name: string;
  background: string;
  index: number;
  elementCount: number;
}

export interface DeckSummary {
  id: string;
  title: string;
  slideCount: number;
  currentBranch: string;
  updatedAt: number;
  dirty: boolean;
  currentUserRole?: DeckRole | null;
  isOwner?: boolean;
  collaborators?: DemoUser[];
  firstSlideId?: string | null;
}

export type DeckRole = "view" | "comment" | "edit";

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  commitId: string;
  summary: string;
  time: number;
}

export interface CommitInfo {
  id: string;
  summary: string;
  author: string;
  time: number;
  committed: boolean;
}

export interface HistoryPage {
  commits: CommitInfo[];
  nextCursor: string | null;
}

export interface CommitSnapshot {
  commit: CommitInfo;
  deck: { title: string; width: number; height: number; slides: string[] };
  slides: Slide[];
  notes: Record<string, string>;
}

export interface DemoUser {
  id: string;
  username: string;
  displayName: string;
}

export interface DeckCollaboration {
  owner: DemoUser;
  members: { user: DemoUser; branches: Record<string, DeckRole> }[];
}

export interface ShareLink {
  id: string;
  token: string;
  branch: string;
  role: DeckRole;
  createdAt: number;
  joinedCount: number;
}

export interface ShareLinkPreview {
  deckId: string;
  title: string;
  branch: string;
  role: DeckRole;
  owner: DemoUser;
}

export interface ObjectComment {
  id: string;
  slideId: string;
  objectId: string;
  author: DemoUser;
  message: string;
  parentId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PresenceEvent {
  type: "join" | "leave" | "cursor" | "presence" | "selection" | "lock" | "unlock" | "ready" | "locks_snapshot" | "invalidate" | "resync" | "preview";
  user?: DemoUser;
  userId?: string;
  connectionId?: string;
  sessionId?: string;
  scope?: "content" | "deck" | "comments" | "collaboration" | "history" | "deleted";
  users?: PresenceEvent[];
  locks?: { user: DemoUser; objectId: string; sessionId?: string }[];
  elements?: Record<string, SlideElement | null>;
  slideId?: string | null;
  x?: number | null;
  y?: number | null;
  objectIds?: string[];
}

export interface DeckDetail {
  id: string;
  deck: Deck;
  slides: SlideSummary[];
  currentBranch: string;
  branches: BranchInfo[];
  dirty: boolean;
}

export interface AssetInfo {
  name: string;
  url: string;
}

export interface SlidePayload {
  slide: Slide;
  notes: string;
  assets: AssetInfo[];
}

export interface SlideTemplate {
  id: string;
  name: string;
  slide: Slide;
}

export interface SessionInfo {
  id: string;
  deckId: string;
  branch: string;
  openedAt: number;
}

export interface MergeConflict {
  path: string;
  scope: string;
  elementId?: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export interface SlideMerge {
  slideId: string;
  status: "conflict" | "unchanged" | "modified" | "merged";
  merged: Slide | null;
  ours: Slide | null;
  theirs: Slide | null;
  conflicts: MergeConflict[];
}

export interface NotesMerge {
  slideId: string;
  status: "conflict" | "unchanged" | "modified" | "merged";
  merged: string;
  ours: string;
  theirs: string;
  conflicts: MergeConflict[];
}

export interface DeckMerge {
  status: "conflict" | "unchanged" | "modified" | "merged";
  merged: Deck;
  ours: Deck;
  theirs: Deck;
  conflicts: MergeConflict[];
}

export interface MergePreview {
  target: string;
  source: string;
  oursCommit: string;
  theirsCommit: string;
  baseCommit: string | null;
  deck: DeckMerge;
  slides: SlideMerge[];
  notes: NotesMerge[];
  conflictCount: number;
  changedCount: number;
}

export interface Resolution {
  scope: string;
  path: string;
  choice: "ours" | "theirs";
}

export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;
