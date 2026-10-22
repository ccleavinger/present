import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type {
  CommitInfo,
  DeckDetail,
  Slide,
  SlideElement,
} from "../types";
import { ApiError, api } from "../api";
import {
  cloneSlide,
  createImageElement,
  createShapeElement,
  createTextElement,
  isEditableTarget,
  newElementId,
} from "../elements";
import { Stage } from "./Stage";
import { StaticSlide } from "./ElementView";
import { ThumbnailRail } from "./ThumbnailRail";
import { Toolbar } from "./Toolbar";
import { Inspector } from "./Inspector";
import { NotesDrawer } from "./NotesDrawer";
import { MergeModal } from "./MergeModal";
import { ScriptModal } from "./ScriptModal";
import { BranchModal } from "./BranchModal";

interface EditorProps {
  deckId: string;
  onBack: () => void;
}

type SaveState = "saved" | "dirty" | "saving" | "error";
type Toast = { message: string; kind: "info" | "success" | "error" };
const MAX_IMAGE_FILE_BYTES = 100 * 1024 * 1024;

export function Editor(props: EditorProps) {
  const [detail, setDetail] = createSignal<DeckDetail | null>(null);
  const [slide, setSlide] = createSignal<Slide | null>(null);
  const [slideId, setSlideId] = createSignal<string | null>(null);
  const [previews, setPreviews] = createSignal<Record<string, Slide>>({});
  const [notes, setNotes] = createSignal("");
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [commits, setCommits] = createSignal<CommitInfo[]>([]);
  const [saveState, setSaveState] = createSignal<SaveState>("saved");
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [notesOpen, setNotesOpen] = createSignal(false);
  const [scriptOpen, setScriptOpen] = createSignal(false);
  const [mergeOpen, setMergeOpen] = createSignal(false);
  const [branchOpen, setBranchOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [toast, setToast] = createSignal<Toast | null>(null);
  const [presenting, setPresenting] = createSignal(false);
  const [presentIndex, setPresentIndex] = createSignal(0);
  const [presentSlide, setPresentSlide] = createSignal<Slide | null>(null);
  const [historyTick, setHistoryTick] = createSignal(0);

  let saveTimer: number | undefined;
  let toastTimer: number | undefined;
  let flushing: Promise<void> | null = null;
  let notesDirty = false;
  let editRevision = 0;
  let suppressHistory = false;
  let lastHistoryAt = 0;
  let past: Slide[] = [];
  let future: Slide[] = [];
  let imageInput: HTMLInputElement | undefined;

  const selected = (): SlideElement | undefined => {
    const id = selectedId();
    if (!id) return undefined;
    return slide()?.elements[id];
  };

  const deck = () => detail();
  const currentBranch = () => detail()?.currentBranch ?? "main";
  const canUndo = () => {
    historyTick();
    return past.length > 0;
  };
  const canRedo = () => {
    historyTick();
    return future.length > 0;
  };

  function notify(message: string, kind: Toast["kind"] = "info") {
    setToast({ message, kind });
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(null), 3600);
  }

  async function withFreshSession<T>(fn: (sid: string | null) => Promise<T>): Promise<T> {
    try {
      return await fn(sessionId());
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && /session/i.test(err.message)) {
        const session = await api.createSession(props.deckId);
        setSessionId(session.id);
        return fn(session.id);
      }
      throw err;
    }
  }

  async function ensureSession() {
    if (sessionId()) return;
    try {
      const session = await api.createSession(props.deckId);
      setSessionId(session.id);
    } catch {
      // Saving still works without a session; commit-on-close will be skipped.
    }
  }

  async function refreshMeta() {
    const [next, nextCommits] = await Promise.all([
      api.getDeck(props.deckId),
      api.commits(props.deckId).catch(() => [] as CommitInfo[]),
    ]);
    setDetail(next);
    setCommits(nextCommits);
    return next;
  }

  async function loadPreviews(next: DeckDetail) {
    const missing = next.slides.filter((s) => !previews()[s.id]);
    const loaded = await Promise.all(
      missing.map(async (summary) => {
        try {
          const payload = await api.getSlide(props.deckId, summary.id);
          return [summary.id, payload.slide] as const;
        } catch {
          return null;
        }
      }),
    );
    setPreviews((previous) => {
      const map = { ...previous };
      for (const entry of loaded) if (entry) map[entry[0]] = entry[1];
      return map;
    });
  }

  async function loadSlide(id: string, force = false) {
    if (!force && id === slideId() && slide()) return;
    if (slideId() && id !== slideId()) await flush();
    const payload = await api.getSlide(props.deckId, id);
    setSlide(payload.slide);
    setNotes(payload.notes);
    notesDirty = false;
    setSlideId(payload.slide.id);
    setSelectedId(null);
    setSaveState("saved");
    setSaveError(null);
    past = [];
    future = [];
    setHistoryTick((v) => v + 1);
    setPreviews((previous) => ({ ...previous, [payload.slide.id]: payload.slide }));
  }

  async function loadDeck(preferredSlide?: string) {
    setLoading((value) => (detail() ? value : true));
    setLoadError(null);
    try {
      const next = await refreshMeta();
      setPreviews({});
      const target =
        preferredSlide && next.slides.some((s) => s.id === preferredSlide)
          ? preferredSlide
          : slideId() && next.slides.some((s) => s.id === slideId())
            ? slideId()!
            : next.slides[0]?.id;
      if (target) {
        await loadSlide(target, true);
      } else {
        setSlide(null);
        setSlideId(null);
      }
      await ensureSession();
      void loadPreviews(next);
      setLoading(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  onMount(() => {
    void loadDeck();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      if (toastTimer) window.clearTimeout(toastTimer);
      if (saveTimer) window.clearTimeout(saveTimer);
      const sid = sessionId();
      if (sid) {
        void flush().finally(() => {
          void api.closeSession(sid);
        });
      }
    });
  });

  function onBeforeUnload() {
    const current = slide();
    const sid = sessionId();
    if (!current || !sid) return;
    const base = `/api/decks/${props.deckId}/slides/${current.id}`;
    navigator.sendBeacon(
      base,
      new Blob([JSON.stringify({ slide: current, sessionId: sid })], {
        type: "application/json",
      }),
    );
    navigator.sendBeacon(
      `${base}/notes`,
      new Blob([JSON.stringify({ notes: notes(), sessionId: sid })], {
        type: "application/json",
      }),
    );
    navigator.sendBeacon(`/api/sessions/${sid}/close`);
  }

  function scheduleSave() {
    setSaveState("dirty");
    editRevision += 1;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void flush();
    }, 650);
  }

  async function flush(): Promise<void> {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (flushing) await flushing;
    const current = slide();
    if (!current) return;
    if (saveState() === "saved" && !notesDirty) return;

    const revision = editRevision;
    const snapshot = current;
    const noteSnapshot = notes();
    const saveNotes = notesDirty;
    const promise = (async () => {
      setSaveState("saving");
      try {
        if (saveNotes) {
          await withFreshSession((sid) =>
            api.writeNotes(props.deckId, snapshot.id, noteSnapshot, sid ?? undefined),
          );
          notesDirty = false;
        }
        await withFreshSession((sid) =>
          api.writeSlide(props.deckId, snapshot.id, snapshot, sid ?? undefined),
        );
        setPreviews((previous) => ({ ...previous, [snapshot.id]: snapshot }));
        setDetail((previous) =>
          previous
            ? {
                ...previous,
                dirty: true,
                slides: previous.slides.map((summary) =>
                  summary.id === snapshot.id
                    ? {
                        ...summary,
                        name: snapshot.name,
                        background: snapshot.background,
                        elementCount: Object.keys(snapshot.elements).length,
                      }
                    : summary,
                ),
              }
            : previous,
        );
        if (editRevision === revision) {
          setSaveState("saved");
          setSaveError(null);
        }
      } catch (err) {
        setSaveState("error");
        setSaveError(err instanceof Error ? err.message : String(err));
        notify(`Could not save: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    })();
    flushing = promise;
    try {
      await promise;
    } finally {
      if (flushing === promise) flushing = null;
    }
  }

  function recordHistory(previous: Slide | null, force = false) {
    if (!previous || suppressHistory) return;
    const now = Date.now();
    if (force || now - lastHistoryAt > 700) {
      past.push(cloneSlide(previous));
      if (past.length > 100) past.shift();
      future = [];
      lastHistoryAt = now;
      setHistoryTick((v) => v + 1);
    }
  }

  function applySlide(next: Slide, historySource?: Slide | null) {
    if (historySource) recordHistory(historySource);
    setSlide(next);
    scheduleSave();
  }

  function updateElement(id: string, patch: Partial<SlideElement>) {
    const previous = slide();
    if (!previous) return;
    const element = previous.elements[id];
    if (!element) return;
    const next: Slide = {
      ...previous,
      elements: {
        ...previous.elements,
        [id]: { ...element, ...patch, id: element.id },
      },
    };
    applySlide(next, previous);
  }

  function updateSlide(patch: Partial<Slide>) {
    const previous = slide();
    if (!previous) return;
    applySlide({ ...previous, ...patch }, previous);
  }

  function updateText(id: string, text: string) {
    const previous = slide();
    if (!previous) return;
    const element = previous.elements[id];
    if (!element) return;
    applySlide(
      {
        ...previous,
        elements: { ...previous.elements, [id]: { ...element, text } },
      },
      previous,
    );
  }

  function addElement(element: SlideElement) {
    const previous = slide();
    if (!previous) return;
    const maxZ = Object.values(previous.elements).reduce(
      (max, el) => Math.max(max, el.z ?? 0),
      0,
    );
    const next = { ...element, z: maxZ + 1 };
    applySlide(
      {
        ...previous,
        elements: { ...previous.elements, [next.id]: next },
      },
      previous,
    );
    setSelectedId(next.id);
  }

  function addText() {
    const previous = slide();
    const offset = previous ? Object.keys(previous.elements).length * 24 : 0;
    addElement(createTextElement(320 + offset, 260 + offset));
  }

  function addShape(kind: "rect" | "ellipse") {
    const previous = slide();
    const offset = previous ? Object.keys(previous.elements).length * 24 : 0;
    addElement(createShapeElement(kind, 420 + offset, 320 + offset));
  }

  function deleteSelected() {
    const previous = slide();
    const id = selectedId();
    if (!previous || !id || !previous.elements[id]) return;
    const elements = { ...previous.elements };
    delete elements[id];
    applySlide({ ...previous, elements }, previous);
    setSelectedId(null);
  }

  function duplicateSelected() {
    const previous = slide();
    const id = selectedId();
    if (!previous || !id) return;
    const element = previous.elements[id];
    if (!element) return;
    const maxZ = Object.values(previous.elements).reduce(
      (max, el) => Math.max(max, el.z ?? 0),
      0,
    );
    const copy: SlideElement = {
      ...structuredClone(element),
      id: newElementId(),
      x: element.x + 32,
      y: element.y + 32,
      z: maxZ + 1,
    };
    applySlide(
      { ...previous, elements: { ...previous.elements, [copy.id]: copy } },
      previous,
    );
    setSelectedId(copy.id);
  }

  function layerSelected(direction: "front" | "back") {
    const previous = slide();
    const id = selectedId();
    if (!previous || !id || !previous.elements[id]) return;
    const values = Object.values(previous.elements);
    const z = values.map((el) => el.z ?? 0);
    const nextZ =
      direction === "front" ? Math.max(...z, 0) + 1 : Math.min(...z, 0) - 1;
    updateElement(id, { z: nextZ });
  }

  function undo() {
    const previous = past.pop();
    if (!previous) return;
    const current = slide();
    if (current) future.push(cloneSlide(current));
    setSlide(previous);
    setSelectedId(null);
    setHistoryTick((v) => v + 1);
    scheduleSave();
  }

  function redo() {
    const next = future.pop();
    if (!next) return;
    const current = slide();
    if (current) past.push(cloneSlide(current));
    setSlide(next);
    setSelectedId(null);
    setHistoryTick((v) => v + 1);
    scheduleSave();
  }

  function nudge(dx: number, dy: number) {
    const element = selected();
    if (!element) return;
    updateElement(element.id, { x: element.x + dx, y: element.y + dy });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (presenting()) {
      if (event.key === "Escape") {
        event.preventDefault();
        void exitPresent();
      } else if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
        event.preventDefault();
        void showPresent(presentIndex() + 1);
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void showPresent(presentIndex() - 1);
      }
      return;
    }

    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void flush().then(() => notify("Flushed to disk", "success"));
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (!slide()) return;

    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelected();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selected()) {
        event.preventDefault();
        deleteSelected();
      }
      return;
    }
    if (event.key === "Escape") {
      setSelectedId(null);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (!selected()) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowLeft") nudge(-step, 0);
      if (event.key === "ArrowRight") nudge(step, 0);
      if (event.key === "ArrowUp") nudge(0, -step);
      if (event.key === "ArrowDown") nudge(0, step);
      return;
    }
    if (meta || event.altKey) return;
    if (event.key.toLowerCase() === "t") {
      event.preventDefault();
      addText();
    } else if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      addShape("rect");
    } else if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      addShape("ellipse");
    } else if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      void startPresent();
    }
  }

  async function addSlide() {
    try {
      await flush();
      const payload = await withFreshSession((sid) =>
        api.createSlide(props.deckId, slideId() ?? undefined, sid ?? undefined),
      );
      const next = await refreshMeta();
      setPreviews((previous) => ({ ...previous, [payload.slide.id]: payload.slide }));
      setDetail(next);
      await loadSlide(payload.slide.id, true);
      notify("Slide created");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function deleteSlide(id = slideId()) {
    if (!id || !detail() || detail()!.slides.length <= 1) return;
    const target = detail()!.slides.find((item) => item.id === id);
    if (!window.confirm(`Delete “${target?.name ?? "this slide"}” and its folder from the repository?`)) return;
    try {
      await flush();
      const previous = detail();
      const removedIndex = previous?.slides.findIndex((s) => s.id === id) ?? 0;
      const next = await api.deleteSlide(props.deckId, id);
      setDetail(next);
      setPreviews((old) => {
        const map = { ...old };
        delete map[id];
        return map;
      });
      if (id === slideId()) {
        const fallback =
          next.slides[Math.min(removedIndex, next.slides.length - 1)]?.id ?? next.slides[0]?.id;
        setDetail(next);
        if (fallback) await loadSlide(fallback, true);
      } else {
        setDetail(next);
      }
      notify("Slide deleted");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function reorder(ids: string[]) {
    const previous = detail();
    if (!previous) return;
    await flush();
    const byId = new Map(previous.slides.map((s) => [s.id, s]));
    setDetail({
      ...previous,
      slides: ids.map((id, index) => ({ ...byId.get(id)!, index })),
    });
    try {
      const next = await withFreshSession((sid) =>
        api.reorderSlides(props.deckId, ids, sid ?? undefined),
      );
      setDetail(next);
    } catch (err) {
      setDetail(previous);
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function checkpoint() {
    try {
      await flush();
      let commit: CommitInfo;
      try {
        commit = await withFreshSession((sid) =>
          sid ? api.commitSession(sid) : api.checkpoint(props.deckId),
        );
      } catch {
        commit = await api.checkpoint(props.deckId, "Manual checkpoint");
      }
      setDetail((previous) => (previous ? { ...previous, dirty: false } : previous));
      setCommits(await api.commits(props.deckId));
      notify(commit.committed ? `Committed ${commit.id.slice(0, 7)}` : "Nothing to commit", "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function openMerge() {
    // Merges use branch tips, so make sure the current working tree is
    // committed before the preview is computed.
    await flush();
    try {
      const commit = await withFreshSession((sid) =>
        sid ? api.commitSession(sid) : api.checkpoint(props.deckId),
      );
      if (commit.committed) {
        setDetail((previous) => (previous ? { ...previous, dirty: false } : previous));
        setCommits(await api.commits(props.deckId));
        notify(`Committed pending edits ${commit.id.slice(0, 7)} before merging`);
      }
    } catch (err) {
      notify(
        `Could not commit pending edits: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }
    setMergeOpen(true);
  }

  async function renameDeck(event: FocusEvent & { currentTarget: HTMLInputElement }) {
    const title = event.currentTarget.value.trim();
    const current = detail();
    if (!current || !title || title === current.deck.title) return;
    try {
      const next = await api.updateDeck(props.deckId, { title });
      setDetail(next);
      notify("Deck renamed", "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function switchBranch(branch: string) {
    if (!detail() || branch === detail()!.currentBranch) return;
    try {
      await flush();
      const next = await withFreshSession((sid) =>
        api.checkout(props.deckId, branch, sid ?? undefined),
      );
      setDetail(next);
      setPreviews({});
      await loadDeck(next.slides[0]?.id);
      notify(`Switched to ${branch}`, "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
      const next = await refreshMeta().catch(() => null);
      if (next) setDetail(next);
    }
  }

  async function createBranch(name: string, checkout: boolean) {
    await flush();
    const next = await withFreshSession((sid) =>
      api.createBranch(props.deckId, {
        name,
        checkout,
        sessionId: sid ?? undefined,
      }),
    );
    setDetail(next);
    if (checkout) {
      setPreviews({});
      await loadDeck(next.slides[0]?.id);
    }
    notify(checkout ? `Created and checked out ${name}` : `Created branch ${name}`, "success");
  }

  async function onMergeComplete(summary: string) {
    setMergeOpen(false);
    await loadDeck(slideId() ?? undefined);
    notify(summary, "success");
  }

  async function handleImage(file: File) {
    const current = slide();
    if (!current) return;
    if (!file.type.startsWith("image/")) {
      notify("Only image files can be dropped here", "error");
      return;
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      notify("Images must be 100 MiB or smaller", "error");
      return;
    }
    try {
      const asset = await api.uploadAsset(props.deckId, current.id, file);
      addElement(createImageElement(asset.url, 420, 260));
      notify(`Uploaded ${asset.name}`, "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function applyScript(next: Slide) {
    const previous = slide();
    if (!previous) return;
    applySlide({ ...next, id: previous.id }, previous);
    notify("Script applied");
  }

  async function startPresent() {
    const next = detail();
    if (!next?.slides.length) return;
    const index = Math.max(0, next.slides.findIndex((s) => s.id === slideId()));
    if (document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      } catch (err) {
        notify(
          `Could not enter browser full-screen: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    }
    setPresenting(true);
    await showPresent(index);
  }

  async function exitPresent() {
    setPresenting(false);
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // The browser may already have exited full-screen via Escape.
      }
    }
  }

  function onFullscreenChange() {
    if (!document.fullscreenElement) setPresenting(false);
  }

  async function showPresent(index: number) {
    const deck = detail();
    if (!deck) return;
    const bounded = Math.min(Math.max(index, 0), deck.slides.length - 1);
    const id = deck.slides[bounded]?.id;
    if (!id) return;
    setPresentIndex(bounded);
    const cached = previews()[id];
    if (cached) {
      setPresentSlide(cached);
      return;
    }
    try {
      const payload = await api.getSlide(props.deckId, id);
      setPreviews((previous) => ({ ...previous, [id]: payload.slide }));
      setPresentSlide(payload.slide);
    } catch {
      setPresentSlide(null);
    }
  }

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="editor-loading">
          <div class="spinner" />
          <p>Opening repository…</p>
        </div>
      }
    >
      <Show
        when={detail() && !loadError()}
        fallback={
          <div class="editor-error">
            <h2>Could not open deck</h2>
            <p>{loadError() ?? "This deck does not exist."}</p>
            <div class="row-gap">
              <button class="btn ghost" onClick={props.onBack}>
                Back to decks
              </button>
              <button class="btn" onClick={() => void loadDeck()}>
                Retry
              </button>
            </div>
          </div>
        }
      >
        <div class="editor grid h-screen grid-rows-[56px_minmax(0,1fr)_auto] overflow-hidden bg-cream-200">
              <header class="topbar grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-cream-300 bg-cream-50/95 px-3.5 max-[820px]:grid-cols-[minmax(0,1fr)_auto]">
                <div class="topbar-left flex min-w-0 items-center gap-2">
                  <button class="icon-btn" title="Back to decks" onClick={props.onBack}>
                    ←
                  </button>
                  <span class="brand-mark tiny">P</span>
                  <input
                    class="deck-title-input"
                    value={deck()!.deck.title}
                    spellcheck={false}
                    onBlur={renameDeck}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </div>

                <div class="topbar-center flex min-w-0 items-center justify-center gap-2 max-[820px]:hidden">
                  <div class="branch-control">
                    <span class="branch-icon">⑂</span>
                    <select
                      value={deck()!.currentBranch}
                      onChange={(event) => void switchBranch(event.currentTarget.value)}
                    >
                      <For each={deck()!.branches}>
                        {(branch) => <option value={branch.name}>{branch.name}</option>}
                      </For>
                    </select>
                    <button class="icon-btn small" title="Create branch" onClick={() => setBranchOpen(true)}>
                      +
                    </button>
                  </div>
                  <span
                    class={`save-pill ${saveState()}`}
                    title={saveError() ?? "Changes are written to disk on an idle timer."}
                  >
                    <span class="save-dot" />
                    {saveState() === "saved"
                      ? "Saved"
                      : saveState() === "dirty"
                        ? "Unsaved"
                        : saveState() === "saving"
                          ? "Saving…"
                          : "Save failed"}
                  </span>
                  <span class="session-chip">session {sessionId()?.slice(4, 10) ?? "offline"}</span>
                </div>

                <div class="topbar-right flex min-w-0 items-center justify-end gap-1.5">
                  <button class="btn ghost small max-[720px]:hidden" onClick={() => setNotesOpen((v) => !v)}>
                    Notes
                  </button>
                  <button class="btn ghost small max-[720px]:hidden" onClick={() => setScriptOpen(true)}>
                    Script
                  </button>
                  <button
                    class="btn ghost small max-[720px]:hidden"
                    onClick={() => void openMerge()}
                    disabled={deck()!.branches.length < 2}
                  >
                    Merge
                  </button>
                  <button class="btn ghost small max-[720px]:hidden" onClick={() => void checkpoint()}>
                    Checkpoint
                  </button>
                  <button class="btn small accent" onClick={() => void startPresent()}>
                    Present
                  </button>
                </div>
              </header>

              <div class="workspace">
                <ThumbnailRail
                  detail={deck()!}
                  currentId={slideId()}
                  previews={previews()}
                  onSelect={(id) => void loadSlide(id)}
                  onAdd={() => void addSlide()}
                  onReorder={(ids) => void reorder(ids)}
                  onDelete={(id) => void deleteSlide(id)}
                />

                <main class="stage-panel">
                  <Toolbar
                    hasSelection={!!selected()}
                    canUndo={canUndo()}
                    canRedo={canRedo()}
                    onAddText={addText}
                    onAddRect={() => addShape("rect")}
                    onAddEllipse={() => addShape("ellipse")}
                    onPickImage={() => imageInput?.click()}
                    onDuplicate={duplicateSelected}
                    onDelete={deleteSelected}
                    onLayer={layerSelected}
                    onUndo={undo}
                    onRedo={redo}
                  />
                  <Show
                    when={slide()}
                    fallback={<div class="stage-empty">This deck has no slides. Add one from the rail.</div>}
                  >
                    {(current) => (
                      <Stage
                        slide={current()}
                        selectedId={selectedId()}
                        onSelect={setSelectedId}
                        onChange={updateElement}
                        onTextCommit={updateText}
                        onTransformStart={() => {
                          recordHistory(slide(), true);
                          suppressHistory = true;
                        }}
                        onTransformEnd={() => {
                          suppressHistory = false;
                          lastHistoryAt = 0;
                        }}
                        onDropFiles={(files) => {
                          const file = files[0];
                          if (file) void handleImage(file);
                        }}
                      />
                    )}
                  </Show>
                </main>

                <Show when={slide()}>
                  {(current) => (
                    <Inspector
                      slide={current()}
                      selected={selected()}
                      commits={commits()}
                      onElementChange={(patch) => {
                        const id = selectedId();
                        if (id) updateElement(id, patch);
                      }}
                      onSlideChange={updateSlide}
                      onDelete={deleteSelected}
                      onCheckpoint={() => void checkpoint()}
                    />
                  )}
                </Show>
              </div>

              <NotesDrawer
                open={notesOpen()}
                notes={notes()}
                onToggle={() => setNotesOpen((v) => !v)}
                onInput={(value) => {
                  notesDirty = true;
                  setNotes(value);
                  scheduleSave();
                }}
                onFlush={() => void flush().then(() => notify("Notes flushed", "success"))}
              />

              <input
                ref={imageInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void handleImage(file);
                }}
              />
        </div>
      </Show>

      <Show when={scriptOpen() && slide()}>
        <ScriptModal
          slide={slide()!}
          selection={selectedId() ? [selectedId()!] : []}
          onClose={() => setScriptOpen(false)}
          onApply={applyScript}
        />
      </Show>

      <Show when={mergeOpen() && detail()}>
        <MergeModal
          deckId={props.deckId}
          currentBranch={currentBranch()}
          branches={detail()!.branches}
          onClose={() => setMergeOpen(false)}
          onMerged={(summary) => void onMergeComplete(summary)}
        />
      </Show>

      <Show when={branchOpen() && detail()}>
        <BranchModal
          currentBranch={currentBranch()}
          onClose={() => setBranchOpen(false)}
          onCreate={createBranch}
        />
      </Show>

      <Show when={presenting()}>
        <div class="present-overlay">
          <PresentSurface slide={presentSlide()} />
          <div class="present-controls">
            <button
              class="present-btn"
              onClick={() => void showPresent(presentIndex() - 1)}
              disabled={presentIndex() === 0}
            >
              ←
            </button>
            <span>
              {presentIndex() + 1} / {detail()?.slides.length ?? 0}
            </span>
            <button
              class="present-btn"
              onClick={() => void showPresent(presentIndex() + 1)}
              disabled={presentIndex() >= (detail()?.slides.length ?? 1) - 1}
            >
              →
            </button>
            <button class="present-btn close" onClick={() => void exitPresent()}>
              Exit
            </button>
          </div>
        </div>
      </Show>

      <Show when={toast()}>
        {(value) => <div class={`toast ${value().kind}`}>{value().message}</div>}
      </Show>
    </Show>
  );
}

function PresentSurface(props: { slide: Slide | null }) {
  let container: HTMLDivElement | undefined;
  const [scale, setScale] = createSignal(0.5);

  onMount(() => {
    const fit = () => {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setScale(Math.min(rect.width / 1920, rect.height / 1080));
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (container) observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="present-surface" ref={container}>
      <Show when={props.slide} fallback={<div class="present-empty">No slide</div>}>
        {(current) => (
          <div
            style={{
              width: "1920px",
              height: "1080px",
              transform: `scale(${scale()})`,
              "transform-origin": "center center",
              position: "relative",
              "box-shadow": "0 8px 24px rgba(55,38,29,.16)",
            }}
          >
            <StaticSlide slide={current()} />
          </div>
        )}
      </Show>
    </div>
  );
}
