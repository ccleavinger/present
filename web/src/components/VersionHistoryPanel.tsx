import { For, Show, createSignal, createEffect, on, onCleanup, onMount } from "solid-js";
import type { CommitInfo, CommitSnapshot, Slide } from "../types";
import { api } from "../api";
import { StaticSlide } from "./ElementView";

function SlidePreview(props: { slide: Slide; width: number; height: number; fit?: boolean }) {
  let container!: HTMLDivElement;
  const [scale, setScale] = createSignal(0);
  onMount(() => {
    const fit = () => setScale(props.fit
      ? Math.min(container.clientWidth / props.width, container.clientHeight / props.height)
      : container.clientWidth / props.width);
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    fit();
    onCleanup(() => observer.disconnect());
  });
  return <div ref={container} class={`history-slide ${props.fit ? "fit" : ""}`} style={{ "aspect-ratio": props.fit ? undefined : `${props.width} / ${props.height}` }}>
    <div class="history-slide-canvas" style={{ width: `${props.width}px`, height: `${props.height}px`, left: props.fit ? "50%" : "0", top: props.fit ? "50%" : "0", transform: `scale(${scale()})${props.fit ? " translate(-50%, -50%)" : ""}` }}>
      <StaticSlide slide={props.slide} />
    </div>
  </div>;
}

const dateTime = (time: number) => new Date(time * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const day = (time: number) => new Date(time * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function VersionHistoryPanel(props: {
  deckId: string;
  branch: string;
  canRestore: boolean;
  refreshKey?: number;
  onClose: () => void;
  onCheckpoint: () => Promise<void>;
  onRestore: (commitId: string, expectedHead: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [commits, setCommits] = createSignal<CommitInfo[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [snapshot, setSnapshot] = createSignal<CommitSnapshot | null>(null);
  const [slideIndex, setSlideIndex] = createSignal(0);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [action, setAction] = createSignal<"checkpoint" | "restore" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const [confirmRestore, setConfirmRestore] = createSignal(false);
  const [spacing, setSpacing] = createSignal(180);
  const [success, setSuccess] = createSignal<string | null>(null);
  const cache = new Map<string, CommitSnapshot>();
  let track!: HTMLDivElement;
  let previewRequest = 0;
  let disposed = false;
  let scrubTimer: number | undefined;
  const selected = () => commits().find((commit) => commit.id === selectedId());
  const selectedIndex = () => commits().findIndex((commit) => commit.id === selectedId());
  const currentSlide = () => snapshot()?.slides[slideIndex()];

  function reveal(id: string, focus = false) {
    requestAnimationFrame(() => {
      if (disposed) return;
      const node = track?.querySelector<HTMLButtonElement>(`[data-commit="${id}"]`);
      if (!node) return;
      track.scrollTo({ left: node.offsetLeft - track.clientWidth / 2 + node.offsetWidth / 2, behavior: "smooth" });
      if (focus) node.focus({ preventScroll: true });
    });
  }

  async function loadPreview(id: string, request: number) {
    try {
      const next = cache.get(id) ?? await api.commitSnapshot(props.deckId, props.branch, id);
      if (disposed || request !== previewRequest) return;
      if (cache.size >= 12) cache.delete(cache.keys().next().value!);
      cache.set(id, next);
      setSnapshot(next);
    } catch (error) {
      if (!disposed && request === previewRequest) setPreviewError(message(error));
    } finally {
      if (!disposed && request === previewRequest) setPreviewLoading(false);
    }
  }

  function selectCommit(id: string, focus = false, scrub = false) {
    if (action()) return;
    if (scrubTimer) window.clearTimeout(scrubTimer);
    const request = ++previewRequest;
    setSelectedId(id);
    setSlideIndex(0);
    setConfirmRestore(false);
    setPreviewError(null);
    setSnapshot(cache.get(id) ?? null);
    setPreviewLoading(!cache.has(id));
    reveal(id, focus);
    if (scrub) scrubTimer = window.setTimeout(() => void loadPreview(id, request), 160);
    else void loadPreview(id, request);
  }

  async function refresh(selectLatest = false) {
    if (historyLoading()) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const page = await api.history(props.deckId, props.branch);
      if (disposed) return;
      const previous = commits();
      if (!selectLatest && selectedId() && previous.length) {
        const known = new Set(page.commits.map((commit) => commit.id));
        setCommits([...page.commits, ...previous.filter((commit) => !known.has(commit.id))]);
        if (!page.nextCursor) setCursor(null);
        return;
      }
      setCommits(page.commits);
      setCursor(page.nextCursor);
      if (page.commits[0]) selectCommit(page.commits[0].id);
      else { setSelectedId(null); setSnapshot(null); }
    } catch (error) { if (!disposed) setError(message(error)); }
    finally { if (!disposed) setHistoryLoading(false); }
  }

  async function loadOlder() {
    const before = cursor();
    if (!before || historyLoading()) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const page = await api.history(props.deckId, props.branch, before);
      if (disposed) return;
      const oldWidth = track.scrollWidth;
      const oldLeft = track.scrollLeft;
      const known = new Set(commits().map((commit) => commit.id));
      setCommits((current) => [...current, ...page.commits.filter((commit) => !known.has(commit.id))]);
      setCursor(page.nextCursor);
      requestAnimationFrame(() => { if (!disposed) track.scrollLeft = oldLeft + track.scrollWidth - oldWidth; });
    } catch (error) { if (!disposed) setError(message(error)); }
    finally { if (!disposed) setHistoryLoading(false); }
  }

  function navigate(offset: number, focus = false) {
    const commit = commits()[selectedIndex() + offset];
    if (commit) selectCommit(commit.id, focus);
  }

  async function checkpoint() {
    setAction("checkpoint"); setError(null); setSuccess(null);
    try {
      await props.onCheckpoint();
      setAction(null);
      await refresh(true);
    } catch (error) { setError(message(error)); }
    finally { setAction(null); }
  }

  async function restore() {
    const commit = selected();
    const head = commits()[0];
    if (!commit || !head || !props.canRestore) return;
    setAction("restore"); setError(null); setSuccess(null);
    try {
      await props.onRestore(commit.id, head.id);
      setConfirmRestore(false);
      setAction(null);
      await refresh(true);
      setSuccess(`Restored “${commit.summary}”. Your previous work remains in the timeline.`);
    } catch (error) { setError(message(error)); }
    finally { setAction(null); }
  }

  createEffect(on(() => props.refreshKey, () => { if (!action()) void refresh(); }, { defer: true }));
  createEffect(() => props.onBusyChange(!!action()));

  const close = () => { if (!action()) props.onClose(); };
  onMount(() => {
    void refresh();
    const observer = new ResizeObserver(() => { if (selectedId()) reveal(selectedId()!); });
    observer.observe(track);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => { disposed = true; previewRequest += 1; if (scrubTimer) window.clearTimeout(scrubTimer); props.onBusyChange(false); });

  return <div class="version-timeline" aria-busy={!!action()} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape" && !action()) {
        if (confirmRestore()) setConfirmRestore(false);
        else close();
      }
    }}>
      <Show when={error()}><div class="history-notice error" role="alert">{error()} <button class="btn ghost small" disabled={!!action() || historyLoading()} onClick={() => void refresh()}>Refresh history</button></div></Show>
      <Show when={success()}><div class="history-notice" role="status">{success()}</div></Show>
      <div class="history-navigation">
        <div class="row-gap"><button class="icon-btn" aria-label="Previous, older version" disabled={!!action() || selectedIndex() < 0 || selectedIndex() >= commits().length - 1} onClick={() => navigate(1)}>←</button>
          <button class="icon-btn" aria-label="Next, newer version" disabled={!!action() || selectedIndex() <= 0} onClick={() => navigate(-1)}>→</button>
          <span class="muted small">{commits().length} versions loaded</span>
          <Show when={props.canRestore}><button class="btn accent small" disabled={!!action() || historyLoading()} onClick={() => void checkpoint()}>{action() === "checkpoint" ? "Saving checkpoint…" : "Create checkpoint"}</button></Show>
        </div>
        <div class="row-gap"><button class="btn ghost small" disabled={!!action() || historyLoading() || !cursor()} onClick={() => void loadOlder()}>{historyLoading() ? "Loading…" : cursor() ? "Load older versions" : "Start of history"}</button>
          <button class="icon-btn" aria-label="Zoom timeline out" disabled={spacing() <= 120} onClick={() => setSpacing((value) => value - 30)}>−</button>
          <button class="icon-btn" aria-label="Zoom timeline in" disabled={spacing() >= 270} onClick={() => setSpacing((value) => value + 30)}>+</button>
          <button class="btn ghost small" disabled={!!action() || !commits().length} onClick={() => selectCommit(commits()[0].id)}>Latest</button>
        </div>
      </div>
      <div ref={track} class="history-track" role="tablist" aria-label="Saved versions, oldest to newest" aria-orientation="horizontal"
        onWheel={(event) => { if (!event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) && track.scrollWidth > track.clientWidth) { event.preventDefault(); track.scrollLeft += event.deltaY; } }}
        onKeyDown={(event) => {
          if (action()) return;
          if (event.key === "ArrowLeft") { event.preventDefault(); navigate(1, true); }
          if (event.key === "ArrowRight") { event.preventDefault(); navigate(-1, true); }
          if (event.key === "Home" && commits().length) { event.preventDefault(); selectCommit(commits().at(-1)!.id, true); }
          if (event.key === "End" && commits().length) { event.preventDefault(); selectCommit(commits()[0].id, true); }
        }}>
        <div class="history-track-inner" style={{ "--node-spacing": `${spacing()}px` }}>
          <For each={[...commits()].reverse()}>{(commit) => <button role="tab" id={`history-${commit.id}`} aria-controls="history-preview" aria-selected={selectedId() === commit.id}
            tabIndex={selectedId() === commit.id ? 0 : -1} data-commit={commit.id} class={`history-node ${selectedId() === commit.id ? "active" : ""}`} disabled={!!action()}
            title={`${commit.summary}\n${commit.author} · ${dateTime(commit.time)}\n${commit.id}`} onClick={() => selectCommit(commit.id)}>
            <span class="history-node-date">{day(commit.time)}<Show when={commit.id === commits()[0]?.id}><span class="history-latest">Latest</span></Show></span>
            <span class="history-node-line"><span class="history-node-dot" /></span>
            <strong>{commit.summary}</strong><span class="history-node-author">{commit.author} · {commit.id.slice(0, 7)}</span>
          </button>}</For>
        </div>
      </div>
      <Show when={commits().length > 1}><label class="history-scrubber"><span>Older</span><input type="range" aria-label="Browse saved versions" min="0" max={commits().length - 1} value={Math.max(0, commits().length - 1 - selectedIndex())} disabled={!!action()} onInput={(event) => selectCommit(commits()[commits().length - 1 - Number(event.currentTarget.value)].id, false, true)} /><span>Newer</span></label></Show>
      <section id="history-preview" role="tabpanel" aria-labelledby={selectedId() ? `history-${selectedId()}` : undefined} class="history-preview-panel">
        <Show when={selected()}>{(commit) => <div class="history-version-heading"><div><strong>{commit().summary}</strong><p class="muted small">{commit().author} · {dateTime(commit().time)} · {commit().id.slice(0, 8)}</p></div>
          <Show when={props.canRestore}><button class="btn accent" disabled={!!action() || previewLoading() || !snapshot()} onClick={() => setConfirmRestore(true)}>Restore this version</button></Show>
        </div>}</Show>
        <Show when={confirmRestore()}><div class="history-restore-confirm"><div><strong>Restore this deck to the selected version?</strong><p>All slides, notes and images will be restored. Your current work will be saved in a checkpoint first.</p></div>
          <div class="row-gap"><button class="btn ghost" disabled={!!action()} onClick={() => setConfirmRestore(false)}>Cancel</button><button class="btn accent" disabled={!!action()} onClick={() => void restore()}>{action() === "restore" ? "Restoring…" : "Confirm restore"}</button></div>
        </div></Show>
        <Show when={previewLoading()}><div class="history-empty" role="status">Loading this version’s slides…</div></Show>
        <Show when={previewError()}><div class="history-notice error" role="alert">{previewError()} <button class="btn ghost small" onClick={() => { if (selectedId()) selectCommit(selectedId()!); }}>Retry preview</button></div></Show>
        <Show when={snapshot()} keyed>{(version) => <div class="history-viewer">
          <div class="history-viewer-main">
            <Show when={currentSlide()} keyed>{(slide) => <div class="history-main-preview"><SlidePreview fit slide={slide} width={version.deck.width} height={version.deck.height} /></div>}</Show>
            <div class="history-slide-controls"><button class="icon-btn" aria-label="Previous slide in this version" disabled={slideIndex() === 0} onClick={() => setSlideIndex((value) => value - 1)}>←</button>
              <span>{version.slides.length ? `${slideIndex() + 1} / ${version.slides.length} · ${currentSlide()?.name ?? ""}` : "No slides in this version"}</span>
              <button class="icon-btn" aria-label="Next slide in this version" disabled={slideIndex() >= version.slides.length - 1} onClick={() => setSlideIndex((value) => value + 1)}>→</button>
            </div>
            <Show when={currentSlide() && version.notes[currentSlide()!.id]}><details class="history-notes"><summary>Speaker notes</summary><pre>{version.notes[currentSlide()!.id]}</pre></details></Show>
          </div>
          <div class="history-slide-strip" aria-label="Slides in this version"><For each={version.slides}>{(slide, index) => <button class={`history-slide-thumb ${slideIndex() === index() ? "active" : ""}`} aria-label={`Slide ${index() + 1}: ${slide.name}`} aria-pressed={slideIndex() === index()} onClick={() => setSlideIndex(index())}>
            <SlidePreview slide={slide} width={version.deck.width} height={version.deck.height} /><span>{index() + 1}. {slide.name}</span>
          </button>}</For></div>
        </div>}</Show>
        <Show when={!commits().length && !historyLoading()}><div class="history-empty">No saved versions yet. Create a checkpoint to start the timeline.</div></Show>
      </section>
    </div>;
}
