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
  opacity?: number;
  style: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Slide {
  version: number;
  id: string;
  name: string;
  background: string;
  elements: Record<string, SlideElement>;
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
}

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
  status: string;
  merged: Slide | null;
  ours: Slide | null;
  theirs: Slide | null;
  conflicts: MergeConflict[];
}

export interface NotesMerge {
  slideId: string;
  status: string;
  merged: string;
  ours: string;
  theirs: string;
  conflicts: MergeConflict[];
}

export interface DeckMerge {
  status: string;
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
