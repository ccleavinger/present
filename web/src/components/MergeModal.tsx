import { For, Show, createSignal, onMount } from "solid-js";
import type {
  BranchInfo,
  DeckMerge,
  MergeConflict,
  MergePreview,
  NotesMerge,
  Resolution,
  Slide,
  SlideMerge,
} from "../types";
import { api } from "../api";
import { Modal } from "./Modal";
import { StaticSlide } from "./ElementView";

interface MergeModalProps {
  deckId: string;
  currentBranch: string;
  branches: BranchInfo[];
  onClose: () => void;
  onMerged: (summary: string) => void;
}

const MINI_WIDTH = 400;
const MINI_SCALE = MINI_WIDTH / 1920;

function conflictKey(conflict: MergeConflict): string {
  return `${conflict.scope}\u0000${conflict.path}`;
}

export function MergeModal(props: MergeModalProps) {
  const others = () => props.branches.filter((b) => b.name !== props.currentBranch);
  const [source, setSource] = createSignal(others()[0]?.name ?? "");
  const [preview, setPreview] = createSignal<MergePreview | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [choices, setChoices] = createSignal<Record<string, "ours" | "theirs">>({});
  const [selectedSlide, setSelectedSlide] = createSignal<string | null>(null);
  let requestSeq = 0;

  const load = async () => {
    if (!source()) return;
    const seq = ++requestSeq;
    setLoading(true);
    setError(null);
    try {
      const next = await api.mergePreview(props.deckId, source(), props.currentBranch);
      if (seq !== requestSeq) return;
      setPreview(next);
      const initial: Record<string, "ours" | "theirs"> = {};
      for (const conflict of allConflicts(next)) initial[conflictKey(conflict)] = "ours";
      setChoices(initial);
      const first = next.slides.find((s) => s.conflicts.length > 0) ?? next.slides.find((s) => s.status !== "unchanged");
      setSelectedSlide(first?.slideId ?? next.slides[0]?.slideId ?? null);
    } catch (err) {
      if (seq !== requestSeq) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === requestSeq) setLoading(false);
    }
  };

  const changeSource = (name: string) => {
    setSource(name);
    setPreview(null);
    setChoices({});
    setSelectedSlide(null);
    setError(null);
    void load();
  };

  onMount(load);

  const choiceFor = (conflict: MergeConflict) => choices()[conflictKey(conflict)] ?? "ours";
  const setChoice = (conflict: MergeConflict, choice: "ours" | "theirs") => {
    setChoices((previous) => ({ ...previous, [conflictKey(conflict)]: choice }));
  };

  const apply = async () => {
    const current = preview();
    if (!current) return;
    setApplying(true);
    setError(null);
    try {
      const resolutions: Resolution[] = allConflicts(current).map((conflict) => ({
        scope: conflict.scope,
        path: conflict.path,
        choice: choiceFor(conflict),
      }));
      const commit = await api.applyMerge(props.deckId, current.source, resolutions);
      props.onMerged(commit.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setApplying(false);
    }
  };

  const slideMerge = () => preview()?.slides.find((s) => s.slideId === selectedSlide());
  const notesMerge = () => preview()?.notes.find((n) => n.slideId === selectedSlide());

  return (
    <Modal
      title="Merge branches"
      subtitle={`3-way semantic AST merge · ${props.currentBranch} ← ${source() || "branch"}`}
      wide
      onClose={props.onClose}
      footer={
        <>
          <span class="muted small">
            <Show when={preview()} fallback="Pick a source branch to preview the merge.">
              {(value) => (
                <>
                  {value().conflictCount} conflict{value().conflictCount === 1 ? "" : "s"} ·{" "}
                  {value().changedCount} changed file{value().changedCount === 1 ? "" : "s"}
                </>
              )}
            </Show>
          </span>
          <div class="row-gap">
            <button class="btn ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button
              class="btn accent"
              disabled={
                !preview() ||
                applying() ||
                preview()!.changedCount === 0 ||
                preview()!.source === preview()!.target
              }
              onClick={apply}
            >
              {applying()
                ? "Merging…"
                : preview()?.conflictCount
                  ? "Resolve & merge"
                  : "Merge cleanly"}
            </button>
          </div>
        </>
      }
    >
      <div class="merge-source-bar">
        <label class="field inline">
          <span>Source branch</span>
          <select value={source()} onChange={(event) => changeSource(event.currentTarget.value)}>
            <For each={others()}>{(branch) => <option value={branch.name}>{branch.name}</option>}</For>
          </select>
        </label>
        <button class="btn ghost" onClick={load} disabled={loading() || !source()}>
          {loading() ? "Computing…" : "Preview merge"}
        </button>
        <Show when={preview()}>
          {(value) => (
            <span class="muted small merge-commits">
              base {value().baseCommit?.slice(0, 7) ?? "—"} · ours {value().oursCommit.slice(0, 7)} ·
              theirs {value().theirsCommit.slice(0, 7)}
            </span>
          )}
        </Show>
      </div>

      <Show when={error()}>
        <div class="alert error">{error()}</div>
      </Show>

      <Show when={preview()}>
        {(value) => (
          <Show
            when={value().changedCount > 0}
            fallback={<div class="merge-empty">These branches are already up to date.</div>}
          >
            <div class="merge-layout">
              <div class="merge-list">
                <Show when={value().deck.conflicts.length > 0}>
                  <div class="merge-group">
                    <h4>Deck manifest</h4>
                    <For each={value().deck.conflicts}>
                      {(conflict) => (
                        <ConflictCard
                          conflict={conflict}
                          choice={choiceFor(conflict)}
                          onChoice={(choice) => setChoice(conflict, choice)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
                <h4>Slides</h4>
                <For each={value().slides}>
                  {(slide) => (
                    <button
                      class="merge-slide-row"
                      classList={{
                        active: slide.slideId === selectedSlide(),
                        conflict: slide.conflicts.length > 0,
                      }}
                      onClick={() => setSelectedSlide(slide.slideId)}
                    >
                      <span class={`status-dot ${statusClass(slide)}`} />
                      <span class="merge-slide-name">{slide.slideId}</span>
                      <span class="merge-slide-status">
                        {slide.conflicts.length
                          ? `${slide.conflicts.length} conflict${slide.conflicts.length === 1 ? "" : "s"}`
                          : slide.status}
                      </span>
                    </button>
                  )}
                </For>
                <Show when={value().notes.some((n) => n.conflicts.length > 0)}>
                  <h4>Notes</h4>
                  <For each={value().notes.filter((n) => n.conflicts.length > 0)}>
                    {(note) => (
                      <button
                        class="merge-slide-row conflict"
                        classList={{ active: note.slideId === selectedSlide() }}
                        onClick={() => setSelectedSlide(note.slideId)}
                      >
                        <span class="status-dot conflict" />
                        <span class="merge-slide-name">notes · {note.slideId}</span>
                        <span class="merge-slide-status">{note.conflicts.length} conflict</span>
                      </button>
                    )}
                  </For>
                </Show>
              </div>

              <div class="merge-inspect">
                <div class="merge-preview-head">
                  <h3>{selectedSlide() ?? "Select a slide"}</h3>
                  <span class="muted small">Branch A (ours) vs Branch B (theirs)</span>
                </div>
                <div class="merge-canvases">
                  <MiniSlide slide={slideMerge()?.ours ?? null} label="Ours" />
                  <MiniSlide slide={slideMerge()?.theirs ?? null} label="Theirs" />
                </div>
                <Show when={slideMerge()}>
                  {(slide) => (
                    <Show when={slide().conflicts.length > 0}>
                      <div class="merge-group">
                        <h4>Property conflicts</h4>
                        <For each={slide().conflicts}>
                          {(conflict) => (
                            <ConflictCard
                              conflict={conflict}
                              choice={choiceFor(conflict)}
                              onChoice={(choice) => setChoice(conflict, choice)}
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                  )}
                </Show>
                <Show when={notesMerge()?.conflicts.length ? notesMerge() : undefined}>
                  {(note) => <NotesConflict note={note()} choiceFor={choiceFor} setChoice={setChoice} />}
                </Show>
                <Show when={value().deck.conflicts.length > 0 && selectedSlide() === null}>
                  <p class="muted small">Deck-level conflicts are listed on the left.</p>
                </Show>
              </div>
            </div>
          </Show>
        )}
      </Show>

      <Show when={!preview() && !loading() && !error()}>
        <div class="merge-empty">Choose a branch and preview the semantic merge.</div>
      </Show>
    </Modal>
  );
}

function allConflicts(preview: MergePreview): MergeConflict[] {
  return [
    ...preview.deck.conflicts,
    ...preview.slides.flatMap((s) => s.conflicts),
    ...preview.notes.flatMap((n) => n.conflicts),
  ];
}

function statusClass(slide: SlideMerge): string {
  if (slide.conflicts.length) return "conflict";
  if (slide.status === "unchanged") return "clean";
  return "changed";
}

function MiniSlide(props: { slide: Slide | null; label: string }) {
  return (
    <div class="mini-wrap">
      <div class="mini-label">{props.label}</div>
      <div class="mini-shot">
        <Show
          when={props.slide}
          fallback={<div class="mini-missing">No slide on this branch</div>}
        >
          {(slide) => (
            <div
              class="mini-inner"
              style={{
                transform: `scale(${MINI_SCALE})`,
                "transform-origin": "top left",
                width: "1920px",
                height: "1080px",
              }}
            >
              <StaticSlide slide={slide()} />
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

function ConflictCard(props: {
  conflict: MergeConflict;
  choice: "ours" | "theirs";
  onChoice: (choice: "ours" | "theirs") => void;
}) {
  const label = () => {
    if (props.conflict.path === "__slide__") return "Entire slide";
    if (props.conflict.path === "__deck__") return "Entire deck manifest";
    if (props.conflict.path === "__notes__") return "Notes document";
    const parts = props.conflict.path.split("/");
    if (parts[0] === "elements" && parts.length >= 3) {
      return `${parts[1]} · ${parts.slice(2).join(".")}`;
    }
    return props.conflict.path;
  };
  return (
    <div class="conflict-card">
      <div class="conflict-path">
        {label()}
        <Show when={props.conflict.elementId}>
          <span class="element-chip">{props.conflict.elementId}</span>
        </Show>
      </div>
      <div class="conflict-choices">
        <label classList={{ chosen: props.choice === "ours" }}>
          <input
            type="radio"
            name={conflictKey(props.conflict)}
            checked={props.choice === "ours"}
            onChange={() => props.onChoice("ours")}
          />
          <span class="choice-label">Keep mine</span>
          <code>{showValue(props.conflict.ours)}</code>
        </label>
        <label classList={{ chosen: props.choice === "theirs" }}>
          <input
            type="radio"
            name={conflictKey(props.conflict)}
            checked={props.choice === "theirs"}
            onChange={() => props.onChoice("theirs")}
          />
          <span class="choice-label">Take theirs</span>
          <code>{showValue(props.conflict.theirs)}</code>
        </label>
      </div>
    </div>
  );
}

function NotesConflict(props: {
  note: NotesMerge;
  choiceFor: (conflict: MergeConflict) => "ours" | "theirs";
  setChoice: (conflict: MergeConflict, choice: "ours" | "theirs") => void;
}) {
  return (
    <div class="merge-group notes-conflict">
      <h4>Speaker notes</h4>
      <Show when={props.note.conflicts.length > 0}>
        <For each={props.note.conflicts}>
          {(conflict) => (
            <ConflictCard
              conflict={conflict}
              choice={props.choiceFor(conflict)}
              onChoice={(choice) => props.setChoice(conflict, choice)}
            />
          )}
        </For>
      </Show>
      <div class="notes-diff">
        <div>
          <h5>Ours</h5>
          <pre>{props.note.ours || "(empty)"}</pre>
        </div>
        <div>
          <h5>Theirs</h5>
          <pre>{props.note.theirs || "(empty)"}</pre>
        </div>
      </div>
    </div>
  );
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > 120) return `${text.slice(0, 117)}…`;
  return text;
}
