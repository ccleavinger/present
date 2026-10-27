import {
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import type {
  DeckDetail,
  Slide,
  SlideElement,
  CustomObjectDefinition,
  TemplateBundle,
  SlideTemplate,
  DemoUser,
  DeckCollaboration,
  PresenceEvent,
} from "../types";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../types";
import { animationGroupDuration, animationStepCount, isAfterPreviousGroup } from "../animations";
import { clipboardImages, ELEMENT_CLIPBOARD_TYPE, slideArrowDirection } from "../clipboard";
import { ApiError, api } from "../api";
import { changedElementIds, equalValue, mergeRemoteSlide, contextualizeSlide, type LiveElement } from "../collaboration";
import {
  cloneSlide,
  createImageElement,
  createQrCodeElement,
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
import { TimelineModal } from "./TimelineModal";
import { Modal } from "./Modal";
import ScriptWorker from "../worker/scriptWorker?worker";
import { CollaborationModal } from "./CollaborationModal";
import { ObjectCommentsPanel } from "./ObjectCommentsPanel";
import { PrintExportModal } from "./PrintExportModal";
import { DropdownMenu } from "./DropdownMenu";
import { UserMenu } from "./UserMenu";
import { ImageCropModal } from "./ImageCropModal";
import { isBold, isItalic } from "../textFormatting";

interface EditorProps {
  deckId: string;
  onBack: () => void;
  activeDemoUser: DemoUser;
  onSignOut: () => void;
  initialBranch?: string;
}

type SaveState = "saved" | "dirty" | "saving" | "retrying" | "error";
type Toast = { message: string; kind: "info" | "success" | "error" };
type ImageDestination = { slideId: string; sessionId?: string; width: number; height: number };
const MAX_IMAGE_FILE_BYTES = 100 * 1024 * 1024;
const BuildModal = lazy(async () => ({ default: (await import("./BuildModal")).BuildModal }));
const QR_CODE_TYPE: CustomObjectDefinition = {
  id: "qr-code",
  name: "QR code",
  inputs: [
    { id: "text", label: "QR content", type: "text", defaultValue: "https://example.com" },
    { id: "color", label: "Code color", type: "color", defaultValue: "#000000" },
  ],
  generator: "return api.qrCode(props.text ?? '', props.color ?? '#000000');",
};

export function Editor(props: EditorProps) {
  const [detail, setDetail] = createSignal<DeckDetail | null>(null);
  const [slide, setSlide] = createSignal<Slide | null>(null);
  const [slideId, setSlideId] = createSignal<string | null>(null);
  const [previews, setPreviews] = createSignal<Record<string, Slide>>({});
  const [notes, setNotes] = createSignal("");
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  const [collaboration, setCollaboration] = createSignal<DeckCollaboration | null>(null);
  const [collaborationOpen, setCollaborationOpen] = createSignal(false);
  const [presence, setPresence] = createSignal<PresenceEvent[]>([]);
  const [connectionState, setConnectionState] = createSignal<"connecting" | "live" | "reconnecting">("connecting");
  const [liveElements, setLiveElements] = createSignal<Record<string, Record<string, LiveElement>>>({});
  const [commentRevision, setCommentRevision] = createSignal(0);
  const [historyRevision, setHistoryRevision] = createSignal(0);
  const [remoteLocks, setRemoteLocks] = createSignal<Record<string, DemoUser>>({});
  const [saveState, setSaveState] = createSignal<SaveState>("saved");
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [notesOpen, setNotesOpen] = createSignal(false);
  const [buildOpen, setBuildOpen] = createSignal(false);
  const [printOpen, setPrintOpen] = createSignal(false);
  const [croppingId, setCroppingId] = createSignal<string | null>(null);
  const [timelineOpen, setTimelineOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [toast, setToast] = createSignal<Toast | null>(null);
  const [presenting, setPresenting] = createSignal(false);
  const [presentIndex, setPresentIndex] = createSignal(0);
  const [presentAnimationStep, setPresentAnimationStep] = createSignal(0);
  const [presentSlide, setPresentSlide] = createSignal<Slide | null>(null);
  const [previewOnly, setPreviewOnly] = createSignal(false);
  const [presentTransitionKey, setPresentTransitionKey] = createSignal(0);
  const [historyTick, setHistoryTick] = createSignal(0);
  const [deckBundle, setDeckBundle] = createSignal<TemplateBundle | null>(null);
  const [legacyTemplates, setLegacyTemplates] = createSignal<SlideTemplate[]>([]);
  const [slidePickerOpen, setSlidePickerOpen] = createSignal(false);
  const customRenderWorkers = new Map<string, Worker>();
  const customObjectTypes = () => [...(deckBundle()?.customObjectTypes ?? []).filter((definition) => definition.id !== QR_CODE_TYPE.id), QR_CODE_TYPE];

  let saveTimer: number | undefined;
  let animationTimer: number | undefined;
  let toastTimer: number | undefined;
  onCleanup(() => { if (animationTimer) window.clearTimeout(animationTimer); });
  let flushing: Promise<void> | null = null;
  let notesDirty = false;
  let savedSlide: Slide | null = null;
  let savedNotes = "";
  let saveGeneration = 0;
  let editorDisposed = false;
  let syncTimer: number | undefined;
  let syncRetryTimer: number | undefined;
  let syncFailures = 0;
  let syncRunning = false;
  let fullSyncPending = false;
  const pendingRemoteSlides = new Set<string>();
  let previewTimer: number | undefined;
  let cursorTimer: number | undefined;
  let editRevision = 0;
  let suppressHistory = false;
  let lastHistoryAt = 0;
  let past: Slide[] = [];
  let future: Slide[] = [];
  let imageInput: HTMLInputElement | undefined;
  let clipboardElement: SlideElement | null = null;
  let navigatingSlide = false;
  let presenceSocket: WebSocket | undefined;
  let presenceReconnectTimer: number | undefined;
  let lastCursor: { type: "cursor"; x: number | null; y: number | null } | undefined;
  let cursorSlideId: string | null = null;
  let selectionQueue: Promise<string[]> = Promise.resolve([]);
  let lockHeartbeat: number | undefined;

  const isOwner = () => collaboration()?.owner.id === props.activeDemoUser.id;
  const branchRole = () => isOwner() ? "edit" : collaboration()?.members.find((member) => member.user.id === props.activeDemoUser.id)?.branches[currentBranch()];
  const canEdit = () => branchRole() === "edit";
  const canComment = () => isOwner() || branchRole() === "edit" || branchRole() === "comment";

  function selectMany(ids: string[]): Promise<string[]> {
    selectionQueue = selectionQueue.catch(() => []).then(() => applySelection(ids));
    return selectionQueue;
  }

  async function applySelection(ids: string[]): Promise<string[]> {
    const requested = [...new Set(ids)];
    const previous = selectedIds();
    if (!canEdit()) {
      setSelectedIds(requested);
      setSelectedId(requested[0] ?? null);
      return requested;
    }
    if (previous.some((id) => !requested.includes(id))) {
      try { await flush(); } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
        if (lockHeartbeat) window.clearInterval(lockHeartbeat);
        if (previous.length) lockHeartbeat = window.setInterval(() => void updateLocks(previous).catch(() => undefined), 5000);
        return previous;
      }
    }
    if (lockHeartbeat) window.clearInterval(lockHeartbeat);
    let acquired = requested;
    if (requested.length) acquired = (await updateLocks(requested)).acquired;
    const release = previous.filter((id) => !acquired.includes(id));
    if (release.length) await updateLocks(release, true).catch(() => undefined);
    if (requested.length && acquired.length === 0) notify("Those objects are currently being edited by someone else.", "info");
    setSelectedIds(acquired);
    setSelectedId(acquired[0] ?? null);
    if (acquired.length) lockHeartbeat = window.setInterval(() => void updateLocks(acquired).catch(() => undefined), 5000);
    return acquired;
  }

  async function selectElement(id: string | null): Promise<boolean> {
    const acquired = await selectMany(id ? [id] : []);
    return !id || acquired.includes(id);
  }

  function localSlide(value: Slide): Slide {
    return contextualizeSlide(value, props.deckId, currentBranch(), props.activeDemoUser.id);
  }

  function renderedSlide(value: Slide): Slide {
    const overlays = liveElements()[value.id];
    if (!overlays) return value;
    const elements = { ...value.elements };
    for (const [id, live] of Object.entries(overlays)) {
      if (value.id === slideId() && selectedIds().includes(id)) continue;
      if (live.element) elements[id] = live.element;
      else delete elements[id];
    }
    return localSlide({ ...value, elements });
  }
  const renderedPreviews = createMemo(() => Object.fromEntries(Object.entries(previews()).map(([id, value]) => [id, renderedSlide(value)])));

  function removeLive(predicate: (value: LiveElement) => boolean) {
    setLiveElements((current) => Object.fromEntries(Object.entries(current).map(([slideId, elements]) => [slideId,
      Object.fromEntries(Object.entries(elements).filter(([, value]) => !predicate(value))),
    ])));
  }

  function applyRemoteSlide(remote: Slide, remoteNotes: string) {
    const localized = localSlide(remote);
    setPreviews((previous) => ({ ...previous, [localized.id]: localized }));
    setDetail((previous) => previous ? { ...previous, slides: previous.slides.map((summary) => summary.id === localized.id
      ? { ...summary, name: localized.name, background: localized.background, elementCount: Object.keys(localized.elements).length }
      : summary) } : previous);
    if (presentSlide()?.id === localized.id) setPresentSlide(localized);
    if (localized.id !== slideId() || !savedSlide || !slide()) return;
    const oldBase = savedSlide;
    const merged = mergeRemoteSlide(oldBase, slide()!, localized);
    savedSlide = merged.base;
    // Old undo snapshots must follow unrelated remote edits as well.
    past = past.map((value) => mergeRemoteSlide(oldBase, value, localized)).filter((value) => !value.conflicts.length).map((value) => value.slide);
    future = future.map((value) => mergeRemoteSlide(oldBase, value, localized)).filter((value) => !value.conflicts.length).map((value) => value.slide);
    setSlide(merged.slide);
    if (!notesDirty || notes() === savedNotes || notes() === remoteNotes) {
      setNotes(remoteNotes); savedNotes = remoteNotes; notesDirty = false;
    } else if (remoteNotes !== savedNotes) {
      merged.conflicts.push("speaker notes");
    }
    if (merged.conflicts.length) {
      const message = `Another editor changed ${merged.conflicts.join(", ")}. Your local changes have been kept.`;
      setSaveError(message); setSaveState("error"); notify(message, "error");
    } else if (!flushing && saveState() !== "error") {
      setSaveState(equalValue(merged.slide, savedSlide) && !notesDirty ? "saved" : "dirty");
    }
  }

  function queueRemoteSync(id?: string) {
    if (id) pendingRemoteSlides.add(id); else fullSyncPending = true;
    if (syncTimer || syncRetryTimer || syncRunning || editorDisposed) return;
    syncTimer = window.setTimeout(() => { syncTimer = undefined; void synchronizeRemote(); }, 60);
  }

  async function synchronizeRemote() {
    if (syncRunning || editorDisposed) return;
    syncRunning = true;
    try {
      while (!editorDisposed && (fullSyncPending || pendingRemoteSlides.size)) {
        if (flushing) await flushing.catch(() => undefined);
        const branch = currentBranch();
        const full = fullSyncPending;
        fullSyncPending = false;
        let ids = [...pendingRemoteSlides]; pendingRemoteSlides.clear();
        const generation = saveGeneration;
        const next = full ? await api.getDeck(props.deckId, undefined, branch) : null;
        if (next) ids = next.slides.map((item) => item.id);
        const payloads = [];
        for (let start = 0; start < ids.length; start += 4) {
          payloads.push(...await Promise.allSettled(ids.slice(start, start + 4).map((id) => api.getSlide(props.deckId, id, undefined, branch))));
        }
        if (editorDisposed || branch !== currentBranch()) continue;
        // A write completed while reads were in flight: fetch again rather than
        // applying a response older than our acknowledgement.
        if (generation !== saveGeneration || flushing) {
          if (full) fullSyncPending = true; else ids.forEach((id) => pendingRemoteSlides.add(id));
          continue;
        }
        if (next) {
          setDetail(next);
          const existing = new Set(next.slides.map((item) => item.id));
          setPreviews((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => existing.has(id))));
          if (slideId() && !existing.has(slideId()!)) {
            if (saveState() === "saved" && !notesDirty) {
              if (next.slides[0]) await loadSlide(next.slides[0].id, true);
              else { setSlide(null); setSlideId(null); savedSlide = null; }
            } else {
              setSaveError("This slide was deleted in another editor. Your local changes are still in this editor.");
              setSaveState("error");
            }
          }
          const latestCollaboration = await api.collaboration(props.deckId).catch(() => null);
          if (!editorDisposed && branch === currentBranch() && latestCollaboration) setCollaboration(latestCollaboration);
          if (editorDisposed || branch !== currentBranch()) continue;
          if (generation !== saveGeneration || flushing) { fullSyncPending = true; continue; }
        }
        for (const result of payloads) {
          if (result.status === "fulfilled") applyRemoteSlide(result.value.slide, result.value.notes);
          else if (!(result.reason instanceof ApiError && result.reason.status === 404)) throw result.reason;
        }
        syncFailures = 0;
        if (next || full) setHistoryRevision((value) => value + 1);
      }
    } catch (error) {
      if (!editorDisposed) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) setLoadError(message);
        else {
          if (syncFailures === 0) notify(`Could not refresh collaboration: ${message}`, "error");
          syncFailures += 1;
          fullSyncPending = true;
          syncRetryTimer = window.setTimeout(() => { syncRetryTimer = undefined; queueRemoteSync(); }, Math.min(10_000, 1000 * 2 ** Math.min(syncFailures - 1, 4)));
        }
      }
    } finally {
      syncRunning = false;
      if (fullSyncPending || pendingRemoteSlides.size) queueRemoteSync();
    }
  }

  function receivePresence(event: PresenceEvent) {
    const ownSession = !!event.sessionId && event.sessionId === sessionId();
    if (event.type === "ready") {
      setPresence((event.users ?? []).filter((item) => item.sessionId !== sessionId()));
      setLiveElements({});
      receivePresence({ type: "locks_snapshot", locks: event.locks });
      queueRemoteSync(); return;
    }
    if (event.type === "locks_snapshot") {
      setRemoteLocks(Object.fromEntries((event.locks ?? []).filter((lock) => lock.sessionId !== sessionId()).map((lock) => [lock.objectId, lock.user]))); return;
    }
    if (event.type === "resync") { setLiveElements({}); queueRemoteSync(); return; }
    if (event.type === "invalidate") {
      if (event.scope === "deleted") { setLoadError("This presentation was deleted by its owner."); return; }
      if (event.scope === "comments") { setCommentRevision((value) => value + 1); return; }
      if (event.scope === "history" || event.scope === "deck" || event.scope === "collaboration") setHistoryRevision((value) => value + 1);
      if (ownSession) return;
      if (event.sessionId) removeLive((live) => live.sessionId === event.sessionId);
      if (event.scope === "history") return;
      queueRemoteSync(event.scope === "content" ? event.slideId ?? undefined : undefined); return;
    }
    if (event.type === "preview") {
      if (ownSession || !event.slideId || !event.connectionId || !event.elements) return;
      const id = event.slideId;
      const localChanges = id === slideId() && slide() ? new Set(changedElementIds(savedSlide, slide()!)) : new Set<string>();
      setLiveElements((previous) => {
        const next = { ...previous[id] };
        for (const [objectId, element] of Object.entries(event.elements!)) {
          if (!localChanges.has(objectId)) next[objectId] = { element, connectionId: event.connectionId!, sessionId: event.sessionId, seen: Date.now() };
        }
        return { ...previous, [id]: next };
      });
      return;
    }
    if (event.type === "lock" && event.user && !ownSession) {
      setRemoteLocks((current) => { const next = { ...current }; for (const id of event.objectIds ?? []) next[id] = event.user!; return next; }); return;
    }
    if (event.type === "unlock") {
      if (ownSession) return;
      setRemoteLocks((current) => { const next = { ...current }; for (const id of event.objectIds ?? []) if (next[id]?.id === (event.user?.id ?? event.userId)) delete next[id]; return next; }); return;
    }
    if (event.type === "leave") {
      setPresence((current) => current.filter((item) => item.connectionId !== event.connectionId));
      removeLive((live) => live.connectionId === event.connectionId); return;
    }
    if (ownSession || !event.user || !event.connectionId) return;
    setPresence((current) => [...current.filter((item) => item.connectionId !== event.connectionId), event]);
  }

  function sendPresence(event: Record<string, unknown>) {
    if (event.type === "cursor") {
      lastCursor = event as typeof lastCursor;
      if (cursorTimer) return;
      cursorTimer = window.setTimeout(() => {
        cursorTimer = undefined;
        if (presenceSocket?.readyState === WebSocket.OPEN && lastCursor) presenceSocket.send(JSON.stringify(lastCursor));
      }, 40);
      return;
    }
    if (presenceSocket?.readyState === WebSocket.OPEN) presenceSocket.send(JSON.stringify(event));
  }

  function queuePreview() {
    if (previewTimer) return;
    previewTimer = window.setTimeout(() => {
      previewTimer = undefined;
      const current = slide();
      if (!current || presenceSocket?.readyState !== WebSocket.OPEN) return;
      const ids = changedElementIds(savedSlide, current).filter((id) => selectedIds().includes(id)).slice(0, 64);
      if (!ids.length) return;
      const message = JSON.stringify({ type: "preview", slideId: current.id, elements: Object.fromEntries(ids.map((id) => [id, current.elements[id] ?? null])) });
      if (new Blob([message]).size <= 250_000 && presenceSocket.bufferedAmount < 500_000) presenceSocket.send(message);
    }, 50);
  }

  function updateLocks(ids: string[], release = false) {
    return withFreshSession((sid) => api.updateLocks(props.deckId, currentBranch(), ids, release, sid ?? undefined));
  }

  createEffect(() => {
    const branch = currentBranch();
    const sid = sessionId();
    if (!sid) return;
    let disposed = false;
    let retryDelay = 500;
    setPresence([]); setRemoteLocks({}); setLiveElements({});
    const connect = () => {
      if (disposed) return;
      setConnectionState(retryDelay === 500 ? "connecting" : "reconnecting");
      const socket = api.connectPresence(props.deckId, branch, slideId() ?? "", (event) => { if (!disposed && branch === currentBranch() && sid === sessionId()) receivePresence(event); }, sid);
      presenceSocket = socket;
      socket.addEventListener("open", () => {
        if (disposed) { socket.close(); return; }
        retryDelay = 500; setConnectionState("live");
        socket.send(JSON.stringify({ type: "presence", slideId: slideId(), objectIds: selectedIds() }));
        if (lastCursor) socket.send(JSON.stringify(lastCursor));
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setConnectionState("reconnecting");
        setPresence([]); setRemoteLocks({}); setLiveElements({});
        presenceReconnectTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 8000);
      });
    };
    untrack(connect);
    onCleanup(() => {
      disposed = true;
      if (presenceReconnectTimer) window.clearTimeout(presenceReconnectTimer);
      presenceSocket?.close();
    });
  });

  createEffect(() => {
    if (slideId() !== cursorSlideId) { cursorSlideId = slideId(); lastCursor = undefined; }
    sendPresence({ type: "presence", slideId: slideId(), objectIds: selectedIds() });
    queuePreview();
  });

  const selected = (): SlideElement | undefined => {
    const id = selectedId();
    if (!id) return undefined;
    return slide()?.elements[id];
  };

  const deck = () => detail();
  const currentBranch = createMemo(() => detail()?.currentBranch ?? "main");
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
      if (err instanceof ApiError && (err.status === 400 || err.status === 404) && /session/i.test(err.message)) {
        const session = await api.createSession(props.deckId, detail()?.currentBranch);
        setSessionId(session.id);
        return fn(session.id);
      }
      throw err;
    }
  }

  async function ensureSession() {
    if (sessionId()) return;
    try {
      const session = await api.createSession(props.deckId, detail()?.currentBranch ?? props.initialBranch);
      setSessionId(session.id);
    } catch {
      // Saving still works without a session; commit-on-close will be skipped.
    }
  }

  async function signOut() {
    try {
      await flush();
      const currentSession = sessionId();
      if (currentSession) {
        await api.closeSession(currentSession);
        setSessionId(null);
      }
      props.onSignOut();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function refreshMeta() {
    const next = await api.getDeck(props.deckId, sessionId() ?? undefined, !sessionId() && !detail() ? props.initialBranch : undefined);
    setDetail(next);
    return next;
  }

  async function loadPreviews(next: DeckDetail) {
    const missing = next.slides.filter((s) => !previews()[s.id]);
    const loaded = await Promise.all(
      missing.map(async (summary) => {
        try {
          const payload = await api.getSlide(props.deckId, summary.id, sessionId() ?? undefined);
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
    const payload = await api.getSlide(props.deckId, id, sessionId() ?? undefined);
    setSlide(payload.slide);
    savedSlide = cloneSlide(payload.slide);
    savedNotes = payload.notes;
    saveGeneration += 1;
    setNotes(payload.notes);
    notesDirty = false;
    setSlideId(payload.slide.id);
    await selectElement(null);
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
      await ensureSession();
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
      setDeckBundle(await api.deckTemplateBundle(props.deckId, sessionId() ?? undefined).catch(() => null));
      setLegacyTemplates(await api.slideTemplates(props.deckId, sessionId() ?? undefined).catch(() => []));
      void loadPreviews(next);
      setLoading(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  function downloadDraftAndLeave() {
    const data = { deckId: props.deckId, branch: currentBranch(), slide: slide(), notes: notes(), baseSlide: savedSlide, baseNotes: savedNotes };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${props.deckId}-local-changes.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    props.onBack();
  }

  async function goBack() {
    try {
      await flush();
      props.onBack();
    } catch {
      // flush preserves the pending edit and exposes its error in the save pill.
    }
  }

  onMount(() => {
    void loadDeck();
    void api.collaboration(props.deckId).then(setCollaboration).catch((error) => notify(error instanceof Error ? error.message : String(error), "error"));
    const resumeCollaboration = () => {
      if (!document.hidden) {
        queueRemoteSync();
        if (canEdit() && selectedIds().length) void updateLocks(selectedIds()).catch(() => undefined);
      } else sendPresence({ type: "cursor", x: null, y: null });
    };
    const pruneLive = window.setInterval(() => removeLive((live) => live.seen < Date.now() - 15_000), 5000);
    window.addEventListener("online", resumeCollaboration);
    document.addEventListener("visibilitychange", resumeCollaboration);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onTextFormatKeyDown, true);
    window.addEventListener("copy", onCopy);
    window.addEventListener("paste", onPaste);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    onCleanup(() => {
      editorDisposed = true;
      window.clearInterval(pruneLive);
      window.removeEventListener("online", resumeCollaboration);
      document.removeEventListener("visibilitychange", resumeCollaboration);
      if (syncTimer) window.clearTimeout(syncTimer);
      if (syncRetryTimer) window.clearTimeout(syncRetryTimer);
      if (previewTimer) window.clearTimeout(previewTimer);
      if (cursorTimer) window.clearTimeout(cursorTimer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onTextFormatKeyDown, true);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      if (toastTimer) window.clearTimeout(toastTimer);
      if (saveTimer) window.clearTimeout(saveTimer);

      for (const worker of customRenderWorkers.values()) worker.terminate();
      customRenderWorkers.clear();
      if (presenceSocket) presenceSocket.close();
      if (lockHeartbeat) window.clearInterval(lockHeartbeat);
      const sid = sessionId();
      void flush().catch(() => undefined).finally(() => {
        if (selectedIds().length && canEdit()) {
          void updateLocks(selectedIds(), true).catch(() => undefined);
        }
        if (sid) void api.closeSession(sid).catch(() => undefined);
      });
    });
  });

  function onBeforeUnload(event: BeforeUnloadEvent) {
    const current = slide();
    const sid = sessionId();
    const pending = saveState() !== "saved" || notesDirty;
    if (pending) { event.preventDefault(); event.returnValue = ""; }
    if (!current || !sid) return;
    if (!pending) { void api.closeSession(sid).catch(() => undefined); return; }
    if (flushing) return;
    void fetch(`/api/decks/${props.deckId}/slides/${current.id}?sessionId=${encodeURIComponent(sid)}`, {
      method: "PUT", keepalive: true,
      headers: { "content-type": "application/json", "X-Present-User": props.activeDemoUser.id },
      body: JSON.stringify({ slide: current, baseSlide: savedSlide, notes: notesDirty ? notes() : undefined, baseNotes: savedNotes, sessionId: sid }),
    }).then((response) => { if (response.ok) return api.closeSession(sid); }).catch(() => undefined);
  }

  function scheduleSave() {
    setSaveState("dirty");
    editRevision += 1;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void flush().catch(() => undefined);
    }, 650);
  }

  async function flush(): Promise<void> {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (flushing) {
      await flushing;
      if (saveState() !== "saved" || notesDirty) return flush();
      return;
    }
    if (!slide()) return;
    if (saveState() === "saved" && !notesDirty) return;

    const promise = (async () => {
      let failures = 0;
      while (true) {
        const current = slide();
        if (!current) return;
        const revision = editRevision;
        const snapshot = cloneSlide(current);
        const noteSnapshot = notes();
        const saveNotes = notesDirty;
        const baseSnapshot = savedSlide ? cloneSlide(savedSlide) : undefined;
        const baseNoteSnapshot = savedNotes;
        const slideChanged = !equalValue(snapshot, savedSlide);
        // Scripts, undo, redo and deletions can affect objects outside the selection.
        const changedIds = changedElementIds(savedSlide, snapshot);
        let acquired: string[] = [];
        setSaveState("saving");
        try {
          if (canEdit() && changedIds.length) {
            const result = await updateLocks(changedIds);
            acquired = result.acquired;
            const blocked = changedIds.filter((id) => !acquired.includes(id));
            if (blocked.length) {
              throw new ApiError(409, `Cannot save: ${blocked.join(", ")} is being edited by another user. Your changes are still pending.`);
            }
          }
          if (slideChanged) {
            const payload = await withFreshSession((sid) =>
              api.writeSlide(props.deckId, snapshot.id, snapshot, sid ?? undefined, saveNotes ? noteSnapshot : undefined, baseSnapshot, saveNotes ? baseNoteSnapshot : undefined),
            );
            const remote = localSlide(payload.slide);
            const acknowledged = mergeRemoteSlide(snapshot, slide() ?? snapshot, remote);
            past = past.map((value) => mergeRemoteSlide(snapshot, value, remote)).filter((value) => !value.conflicts.length).map((value) => value.slide);
            future = future.map((value) => mergeRemoteSlide(snapshot, value, remote)).filter((value) => !value.conflicts.length).map((value) => value.slide);
            savedSlide = remote;
            setSlide(acknowledged.slide);
            setPreviews((previous) => ({ ...previous, [snapshot.id]: remote }));
            if (!saveNotes && !notesDirty) { setNotes(payload.notes); savedNotes = payload.notes; }
          } else if (saveNotes) {
            await withFreshSession((sid) => api.writeNotes(props.deckId, snapshot.id, noteSnapshot, sid ?? undefined, baseNoteSnapshot));
          }
          saveGeneration += 1;
          if (saveNotes) {
            savedNotes = noteSnapshot;
            if (notes() === noteSnapshot) notesDirty = false;
          }
          setDetail((previous) => previous
            ? {
                ...previous,
                dirty: true,
                slides: previous.slides.map((summary) => summary.id === snapshot.id
                  ? { ...summary, name: snapshot.name, background: snapshot.background, elementCount: Object.keys(snapshot.elements).length }
                  : summary),
              }
            : previous);
          if (editRevision === revision && !notesDirty) {
            setSaveState("saved");
            setSaveError(null);
            return;
          }
          failures = 0;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const transient = !(err instanceof ApiError) || err.status === 429 || err.status >= 500;
          failures += 1;
          if (!transient || failures >= 3) {
            setSaveState("error");
            setSaveError(message);
            notify(`Could not save: ${message}`, "error");
            throw err;
          }
          setSaveState("retrying");
          setSaveError(message);
          await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** (failures - 1)));
        } finally {
          const temporary = acquired.filter((id) => !selectedIds().includes(id));
          if (temporary.length) {
            await updateLocks(temporary, true).catch(() => undefined);
          }
        }
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
    queuePreview();
  }

  function updateElement(id: string, patch: Partial<SlideElement>) {
    const previous = slide();
    if (!previous) return;
    const element = previous.elements[id];
    if (!element) return;
    if (Object.hasOwn(patch, "imageCrop")) recordHistory(previous, true);
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

  function updateText(id: string, text: string, height: number) {
    const previous = slide();
    if (!previous) return;
    const element = previous.elements[id];
    if (!element || (element.text === text && element.h === height)) return;
    applySlide(
      {
        ...previous,
        elements: { ...previous.elements, [id]: { ...element, text, h: height } },
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
    void selectElement(next.id);
  }

  function addText() {
    const previous = slide();
    const offset = previous ? Object.keys(previous.elements).length * 24 : 0;
    addElement(createTextElement(320 + offset, 260 + offset));
  }

  function addShape(kind: "rect" | "ellipse" | "triangle" | "diamond" | "star" | "arrow" | "callout") {
    const previous = slide();
    const offset = previous ? Object.keys(previous.elements).length * 24 : 0;
    addElement(createShapeElement(kind, 420 + offset, 320 + offset));
  }

  function addQrCode() {
    const previous = slide();
    const offset = previous ? Object.keys(previous.elements).length * 24 : 0;
    const element = createQrCodeElement(420 + offset, 320 + offset);
    addElement(element);
    renderCustomObject(element, element.customProps ?? {});
  }

  function deleteSelected() {
    const previous = slide();
    const ids = selectedIds();
    if (!previous || ids.length === 0) return;
    const elements = { ...previous.elements };
    for (const id of ids) delete elements[id];
    const removed = new Set(ids);
    const animations = (previous.animations ?? []).filter((item) => !removed.has(item.elementId)).map((item, order) => ({ ...item, order }));
    applySlide({ ...previous, elements, animations }, previous);
    void selectElement(null);
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
    const clonedAnimations = (previous.animations ?? []).filter((item) => item.elementId === id).map((item) => ({ ...item, id: `anim_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`, elementId: copy.id, order: (previous.animations?.length ?? 0) + item.order }));
    applySlide(
      { ...previous, elements: { ...previous.elements, [copy.id]: copy }, animations: [...(previous.animations ?? []), ...clonedAnimations] },
      previous,
    );
    void selectElement(copy.id);
  }

  function copySelected() {
    const current = slide();
    const id = selectedId();
    clipboardElement = current && id ? structuredClone(current.elements[id] ?? null) : null;
  }

  function pasteCopied() {
    const previous = slide();
    if (!previous || !clipboardElement) return;
    const maxZ = Object.values(previous.elements).reduce((max, el) => Math.max(max, el.z ?? 0), 0);
    const copy = { ...structuredClone(clipboardElement), id: newElementId(), x: clipboardElement.x + 32, y: clipboardElement.y + 32, z: maxZ + 1 };
    applySlide({ ...previous, elements: { ...previous.elements, [copy.id]: copy } }, previous);
    void selectElement(copy.id);
  }

  function handleContextAction(action: "copy" | "duplicate" | "front" | "back" | "delete" | "paste") {
    if (action === "copy") copySelected();
    else if (action === "duplicate") duplicateSelected();
    else if (action === "front" || action === "back") layerSelected(action);
    else if (action === "delete") deleteSelected();
    else pasteCopied();
  }

  function onCopy(event: ClipboardEvent) {
    if (event.defaultPrevented || presenting() || document.querySelector('[aria-modal="true"]') || isEditableTarget(event.target) || window.getSelection()?.toString()) return;
    if (!selectedId() || !event.clipboardData) return;
    copySelected();
    if (!clipboardElement) return;
    event.clipboardData.setData(ELEMENT_CLIPBOARD_TYPE, JSON.stringify(clipboardElement));
    event.clipboardData.setData("text/plain", clipboardElement.text ?? clipboardElement.type);
    event.preventDefault();
  }

  function imageDestination(): ImageDestination | undefined {
    const current = slide();
    if (!current) return;
    return { slideId: current.id, sessionId: sessionId() ?? undefined, width: deck()?.deck.width ?? CANVAS_WIDTH, height: deck()?.deck.height ?? CANVAS_HEIGHT };
  }

  function onPaste(event: ClipboardEvent) {
    if (event.defaultPrevented || !canEdit() || presenting() || document.querySelector('[aria-modal="true"]') || isEditableTarget(event.target) || !event.clipboardData) return;
    const destination = imageDestination();
    if (!destination) return;
    const images = clipboardImages(event.clipboardData);
    if (images.files.length || images.sources.length) {
      event.preventDefault();
      void (async () => {
        for (const file of images.files) await handleImage(file, destination);
        for (const source of images.sources) await handleImageSource(source, destination);
      })();
      return;
    }
    const copied = event.clipboardData.getData(ELEMENT_CLIPBOARD_TYPE);
    if (!copied) return;
    try {
      const element = JSON.parse(copied) as SlideElement;
      if (typeof element.type !== "string" || ![element.x, element.y, element.w, element.h].every(Number.isFinite)) return;
      clipboardElement = element;
      event.preventDefault();
      pasteCopied();
    } catch { /* Leave unrelated clipboard formats to the browser. */ }
  }

  async function navigateSlide(direction: -1 | 1) {
    if (navigatingSlide) return;
    const slides = detail()?.slides ?? [];
    const index = slides.findIndex((item) => item.id === slideId());
    const target = slides[index + direction];
    if (index < 0 || !target) return;
    navigatingSlide = true;
    try { await loadSlide(target.id); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { navigatingSlide = false; }
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
    scheduleSave();
    void selectElement(null);
    setHistoryTick((v) => v + 1);
  }

  function redo() {
    const next = future.pop();
    if (!next) return;
    const current = slide();
    if (current) past.push(cloneSlide(current));
    setSlide(next);
    scheduleSave();
    void selectElement(null);
    setHistoryTick((v) => v + 1);
  }

  function nudge(dx: number, dy: number) {
    const current = slide();
    if (!current) return;
    for (const id of selectedIds()) {
      const element = current.elements[id];
      if (element) updateElement(element.id, { x: element.x + dx, y: element.y + dy });
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
    if (presenting()) {
      if (event.key === "Escape") {
        event.preventDefault();
        void exitPresent();
      } else if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
        event.preventDefault();
        advancePresentation();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        if (animationTimer) window.clearTimeout(animationTimer);
        animationTimer = undefined;
        if (presentAnimationStep() > 0) setPresentAnimationStep((step) => step - 1);
        else void showPresent(presentIndex() - 1);
      }
      return;
    }

    const arrow = slideArrowDirection(event.key);
    if (arrow && !selectedIds().length && !isEditableTarget(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey && !(event.target as Element)?.closest?.("summary,[role=menu]")) {
      event.preventDefault();
      void navigateSlide(arrow);
      return;
    }

    if (!canEdit()) {
      if (!isEditableTarget(event.target) && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "p") {
        event.preventDefault(); void startPresent();
      }
      return;
    }

    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void checkpoint();
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
      if (selectedIds().length) {
        event.preventDefault();
        deleteSelected();
      }
      return;
    }
    if (event.key === "Escape") {
      void selectElement(null);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (!selectedIds().length) return;
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

  function onTextFormatKeyDown(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    const alignment = event.shiftKey ? ({ l: "left", e: "center", r: "right" } as Record<string, string>)[key] : undefined;
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || !alignment && !["b", "i"].includes(key) || !canEdit() || presenting() || document.querySelector('[aria-modal="true"]')) return;
    const target = event.target as HTMLElement | null;
    if (isEditableTarget(target) && !target?.closest(".text-box,.inspector")) return;
    const current = slide();
    const text = selectedIds().map((id) => current?.elements[id]).filter((element): element is SlideElement => element?.type === "text");
    if (!text.length) return;
    // Capture before contenteditable's key handler so browser formatting cannot
    // insert untracked <b>/<i> markup into the plain-text editing surface.
    event.preventDefault(); event.stopPropagation();
    recordHistory(current ?? null, true);
    const enable = !text.every(key === "b" ? isBold : isItalic);
    for (const element of text) updateElement(element.id, { style: { ...element.style, ...(alignment ? { align: alignment } : key === "b" ? { fontWeight: enable ? 700 : 400 } : { fontStyle: enable ? "italic" : "normal" }) } });
  }

  async function addSlide(template?: Slide) {
    try {
      await flush();
      const payload = await withFreshSession((sid) =>
        api.createSlide(props.deckId, slideId() ?? undefined, sid ?? undefined, template),
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

  async function addSlides(slides: Slide[]) {
    if (slides.length === 1) { await addSlide(slides[0]); return; }
    try {
      await flush();
      let after = slideId() ?? undefined;
      let finalId: string | undefined;
      const added: Slide[] = [];
      for (const template of slides) {
        const payload = await withFreshSession((sid) => api.createSlide(props.deckId, after, sid ?? undefined, template));
        after = payload.slide.id; finalId = payload.slide.id; added.push(payload.slide);
      }
      const next = await refreshMeta();
      setPreviews((previous) => ({ ...previous, ...Object.fromEntries(added.map((item) => [item.id, item])) }));
      setDetail(next);
      if (finalId) await loadSlide(finalId, true);
      notify(`${added.length} slides created`);
    } catch (err) { notify(err instanceof Error ? err.message : String(err), "error"); }
  }

  async function applyAgentProposal(slides: Slide[], request: string) {
    await flush();
    const branchName = `agent/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    await createBranch(branchName, true, currentBranch());
    let after = slideId() ?? undefined;
    let finalId: string | undefined;
    const added: Slide[] = [];
    for (const template of slides) {
      const payload = await withFreshSession((sid) => api.createSlide(props.deckId, after, sid ?? undefined, template));
      after = payload.slide.id;
      finalId = payload.slide.id;
      added.push(payload.slide);
    }
    const next = await refreshMeta();
    setPreviews((previous) => ({ ...previous, ...Object.fromEntries(added.map((item) => [item.id, item])) }));
    setDetail(next);
    if (finalId) await loadSlide(finalId, true);
    await flush();
    await api.checkpoint(props.deckId, `Agent draft: ${request.slice(0, 48)}`);
    await refreshMeta();
    setBuildOpen(false);
    notify(`Agent draft is ready on ${branchName}`, "success");
  }

  function updateCustomInput(inputId: string, value: unknown) {
    const element = selected();
    if (!element || element.type !== "custom") return;
    const definition = customObjectTypes().find((item) => item.id === element.customType);
    if (!definition) return;
    const customProps = { ...(element.customProps ?? {}), [inputId]: value };
    updateElement(element.id, { customProps });
    renderCustomObject(element, customProps);
  }

  function renderCustomObject(element: SlideElement, customProps: Record<string, unknown>) {
    const definition = customObjectTypes().find((item) => item.id === element.customType);
    if (!definition) return;
    customRenderWorkers.get(element.id)?.terminate();
    const worker = new ScriptWorker();
    customRenderWorkers.set(element.id, worker);
    const timeout = window.setTimeout(() => {
      if (customRenderWorkers.get(element.id) !== worker) return;
      customRenderWorkers.delete(element.id); worker.terminate(); notify("Custom object generator timed out", "error");
    }, 2000);
    worker.onmessage = (event: MessageEvent) => {
      if (customRenderWorkers.get(element.id) !== worker) return;
      window.clearTimeout(timeout);
      customRenderWorkers.delete(element.id); worker.terminate();
      if (event.data?.type !== "generated") { notify(event.data?.error ?? "Could not update this custom object", "error"); return; }
      updateElement(element.id, { renderData: event.data.generated });
    };
    worker.onerror = () => { window.clearTimeout(timeout); customRenderWorkers.delete(element.id); worker.terminate(); notify("Could not update this custom object", "error"); };
    worker.postMessage({ id: crypto.randomUUID(), mode: "render-custom-object", source: definition.generator, props: customProps });
  }

  async function deleteSlide(id = slideId()) {
    if (!id || !detail() || detail()!.slides.length <= 1) return;
    const target = detail()!.slides.find((item) => item.id === id);
    if (!window.confirm(`Delete “${target?.name ?? "this slide"}” and its folder from the repository?`)) return;
    try {
      await flush();
      const previous = detail();
      const removedIndex = previous?.slides.findIndex((s) => s.id === id) ?? 0;
      const next = await api.deleteSlide(props.deckId, id, sessionId() ?? undefined);
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

  async function createCheckpoint() {
    await flush();
    const commit = await withFreshSession((sid) =>
      sid ? api.commitSession(sid) : api.checkpoint(props.deckId),
    );
    setDetail((previous) => (previous ? { ...previous, dirty: false } : previous));
    setHistoryRevision((value) => value + 1);
    notify(commit.committed ? `Committed ${commit.id.slice(0, 7)}` : "Nothing to commit", "success");
  }

  async function checkpoint() {
    try { await createCheckpoint(); }
    catch (err) { notify(err instanceof Error ? err.message : String(err), "error"); }
  }

  async function restoreVersion(commitId: string, expectedHead: string) {
    await flush();
    await selectElement(null);
    await api.restoreCommit(props.deckId, currentBranch(), commitId, expectedHead);
    await loadDeck(slideId() ?? undefined);
    if (loadError()) throw new Error(`The version was restored, but the editor could not reload: ${loadError()}`);
  }

  async function prepareMerge() {
    // Merges use branch tips, so make sure the current working tree is
    // committed before the preview is computed.
    await flush();
    const commit = await withFreshSession((sid) =>
      sid ? api.commitSession(sid) : api.checkpoint(props.deckId),
    );
    if (commit.committed) {
      setDetail((previous) => (previous ? { ...previous, dirty: false } : previous));
      setHistoryRevision((value) => value + 1);
      notify(`Committed pending edits ${commit.id.slice(0, 7)} before merging`);
    }
  }

  async function renameDeck(event: FocusEvent & { currentTarget: HTMLInputElement }) {
    const title = event.currentTarget.value.trim();
    const current = detail();
    if (!current || !title || title === current.deck.title) return;
    try {
      const next = await api.updateDeck(props.deckId, { title, sessionId: sessionId() ?? undefined });
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
      await selectElement(null);
      const next = await withFreshSession((sid) =>
        api.checkout(props.deckId, branch, sid ?? undefined),
      );
      setDetail(next);
      setPreviews({});
      await loadDeck(next.slides[0]?.id);
      if (loadError()) throw new Error(`Switched to ${branch}, but the editor could not reload: ${loadError()}`);
      notify(`Switched to ${branch}`, "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
      const next = await refreshMeta().catch(() => null);
      if (next) setDetail(next);
      throw err;
    }
  }

  async function createBranch(name: string, checkout: boolean, from: string) {
    await flush();
    if (checkout) await selectElement(null);
    const next = await withFreshSession((sid) =>
      api.createBranch(props.deckId, {
        name,
        from,
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
    await loadDeck(slideId() ?? undefined);
    if (loadError()) throw new Error(`The branches merged, but the editor could not reload: ${loadError()}`);
    notify(summary, "success");
  }

  async function placeImage(src: string, imageWidth: number, imageHeight: number, destination: ImageDestination) {
    if (editorDisposed || (sessionId() ?? undefined) !== destination.sessionId) throw new Error("The deck branch changed before the image finished loading. Paste it again on the current branch.");
    const scale = Math.min(1, (destination.width * 0.75) / imageWidth, (destination.height * 0.75) / imageHeight);
    const width = Math.max(1, imageWidth * scale), height = Math.max(1, imageHeight * scale);
    const element = createImageElement(src, (destination.width - width) / 2, (destination.height - height) / 2, width, height);
    if (slideId() === destination.slideId) {
      addElement(element);
      return;
    }
    // An upload may finish after arrow navigation. Keep it on the slide where
    // the paste started rather than inserting it into the newly selected slide.
    const base = (await api.getSlide(props.deckId, destination.slideId, destination.sessionId)).slide;
    element.z = Math.max(0, ...Object.values(base.elements).map((item) => item.z ?? 0)) + 1;
    const saved = await api.writeSlide(props.deckId, base.id, { ...base, elements: { ...base.elements, [element.id]: element } }, destination.sessionId, undefined, base);
    setPreviews((previous) => ({ ...previous, [base.id]: saved.slide }));
  }

  async function handleImage(file: File, destination = imageDestination()) {
    if (!destination) return;
    if (!file.type.startsWith("image/")) {
      notify("Choose or paste an image file", "error");
      return;
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      notify("Images must be 100 MiB or smaller", "error");
      return;
    }
    try {
      const [imageWidth, imageHeight] = await readImageDimensions(file);
      if (imageWidth <= 0 || imageHeight <= 0) throw new Error("Could not read the image dimensions.");
      const asset = await api.uploadAsset(props.deckId, destination.slideId, file, destination.sessionId);
      await placeImage(asset.url, imageWidth, imageHeight, destination);
      notify("Image added", "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function handleImageSource(source: string, destination: ImageDestination) {
    let file: File;
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("The image site blocked downloading.");
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("The copied link did not return an image.");
      const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "png";
      file = new File([blob], `pasted-image.${extension}`, { type: blob.type });
    } catch {
      // Copy Image normally provides bytes. For HTML-only clipboard content,
      // a site can allow displaying its image while blocking a CORS download.
      try {
        const image = new Image();
        image.src = source;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("The copied image could not be opened.");
        await placeImage(source, image.naturalWidth, image.naturalHeight, destination);
        notify("Linked image added", "success");
      } catch (error) { notify(error instanceof Error ? error.message : "The copied image could not be loaded.", "error"); }
      return;
    }
    await handleImage(file, destination);
  }

  async function readImageDimensions(file: File): Promise<[number, number]> {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file);
        const dimensions: [number, number] = [bitmap.width, bitmap.height];
        bitmap.close();
        return dimensions;
      } catch { /* SVG and some clipboard formats need the image decoder below. */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    } finally {
      URL.revokeObjectURL(url);
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
    setPreviewOnly(false);
    setPresenting(true);
    await showPresent(index);
  }

  async function startSlidePreview() {
    const deck = detail();
    const currentId = slideId();
    if (!deck?.slides.length || !currentId) return;
    setPreviewOnly(true);
    setPresenting(true);
    await showPresent(Math.max(0, deck.slides.findIndex((item) => item.id === currentId)));
  }

  async function exitPresent() {
    if (animationTimer) window.clearTimeout(animationTimer);
    animationTimer = undefined;
    setPreviewOnly(false);
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
    if (!document.fullscreenElement) {
      if (animationTimer) window.clearTimeout(animationTimer);
      animationTimer = undefined;
      setPresenting(false);
      setPreviewOnly(false);
    }
  }

  async function showPresent(index: number) {
    const deck = detail();
    if (!deck) return;
    const bounded = Math.min(Math.max(index, 0), deck.slides.length - 1);
    const id = deck.slides[bounded]?.id;
    if (!id) return;
    if (animationTimer) window.clearTimeout(animationTimer);
    animationTimer = undefined;
    setPresentTransitionKey((key) => key + 1);
    setPresentIndex(bounded);
    setPresentAnimationStep(0);
    if (id === slideId() && slide()) {
      setPresentSlide(cloneSlide(slide()!));
      return;
    }
    const cached = previews()[id];
    if (cached) {
      setPresentSlide(cached);
      return;
    }
    try {
      const payload = await api.getSlide(props.deckId, id, sessionId() ?? undefined);
      setPreviews((previous) => ({ ...previous, [id]: payload.slide }));
      setPresentSlide(payload.slide);
    } catch {
      setPresentSlide(null);
    }
  }

  function scheduleAutomaticAnimation(nextStep: number, targetSlide: Slide) {
    if (nextStep >= animationStepCount(targetSlide) || !isAfterPreviousGroup(targetSlide, nextStep)) return;
    animationTimer = window.setTimeout(() => {
      animationTimer = undefined;
      if (!presenting() || presentSlide()?.id !== targetSlide.id || presentAnimationStep() !== nextStep) return;
      const revealedStep = nextStep + 1;
      setPresentAnimationStep(revealedStep);
      scheduleAutomaticAnimation(revealedStep, targetSlide);
    }, animationGroupDuration(targetSlide, nextStep - 1));
  }

  function advancePresentation() {
    const currentSlide = presentSlide();
    if (!currentSlide) return;
    if (animationTimer) window.clearTimeout(animationTimer);
    animationTimer = undefined;
    const count = animationStepCount(currentSlide);
    if (presentAnimationStep() < count) {
      const revealedStep = presentAnimationStep() + 1;
      setPresentAnimationStep(revealedStep);
      scheduleAutomaticAnimation(revealedStep, currentSlide);
    } else if (presentIndex() < (detail()?.slides.length ?? 1) - 1) void showPresent(presentIndex() + 1);
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
              <button class="btn ghost" onClick={() => void goBack()}>
                Back to decks
              </button>
              <Show when={slide() && saveState() !== "saved"}><button class="btn accent" onClick={downloadDraftAndLeave}>Download local changes and leave</button></Show>
              <button class="btn" onClick={() => void loadDeck()}>
                Retry
              </button>
            </div>
          </div>
        }
      >
        <div class={`editor grid h-screen grid-rows-[48px_minmax(0,1fr)_auto] overflow-hidden bg-cream-200 ${canEdit() ? "" : "editor-readonly"}`}>
              <header class="topbar grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-cream-300 bg-cream-50/95 px-3 max-[820px]:grid-cols-[minmax(0,1fr)_auto]">
                <div class="topbar-left flex min-w-0 items-center gap-2">
                  <button class="icon-btn" title="Back to decks" onClick={() => void goBack()}>
                    ←
                  </button>
                  <span class="brand-mark tiny">P</span>
                  <input
                    class="deck-title-input"
                    value={deck()!.deck.title}
                    readOnly={!canEdit()}
                    spellcheck={false}
                    onBlur={renameDeck}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </div>

                <div class="topbar-center flex min-w-0 items-center justify-center gap-2 max-[820px]:hidden">
                  <button
                    class={`save-pill ${saveState()}`}
                    title={saveError() ?? "Changes are written to disk on an idle timer."}
                    onClick={() => { if (saveState() === "error") void flush().catch(() => undefined); }}
                  >
                    <span class="save-dot" />
                    {saveState() === "saved"
                      ? "Saved"
                      : saveState() === "dirty"
                        ? "Unsaved"
                        : saveState() === "saving"
                          ? "Saving…"
                        : saveState() === "retrying"
                          ? "Retrying…"
                          : "Save failed · Retry"}
                  </button>
                  <span class={`connection-chip ${connectionState()}`} role="status"><span />{connectionState() === "live" ? `Live · ${presence().length + 1} online` : connectionState() === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
                </div>

                <div class="topbar-right flex min-w-0 items-center justify-end gap-1.5">
                  <button class="btn ghost small topbar-secondary" onClick={() => setCollaborationOpen(true)}>Share</button>
                  <Show when={canEdit()}><button class="btn ghost small" onClick={() => setBuildOpen(true)}>
                    Build
                  </button></Show>
                  <button class="btn ghost small" aria-label="Timeline" title={`Timeline · ${currentBranch()}`} onClick={() => setTimelineOpen(true)}>Timeline <span class="timeline-current-branch">{currentBranch()}</span></button>
                  <DropdownMenu label="More presentation actions" trigger={<>More <span aria-hidden="true">⌄</span></>}>
                    <button class="compact-menu-action" role="menuitem" onClick={() => setCollaborationOpen(true)}>Share</button>
                    <Show when={canEdit()}>
                      <button role="menuitem" onClick={() => setNotesOpen((v) => !v)}>Speaker notes</button>
                    </Show>
                    <button role="menuitem" onClick={() => setPrintOpen(true)}>Export / print</button>
                  </DropdownMenu>
                  <button class="btn present-action" onClick={() => void startPresent()} title="Present (P)" aria-label="Present (P)">
                    Present <kbd>P</kbd>
                  </button>
                  <UserMenu user={props.activeDemoUser} onSignOut={() => void signOut()} />
                </div>
              </header>

              <div class="workspace">
                <ThumbnailRail
                  detail={deck()!}
                  currentId={slideId()}
                  previews={renderedPreviews()}
                  presence={presence()}
                  readOnly={!canEdit()}
                  onSelect={(id) => void loadSlide(id)}
                  onAdd={() => (deckBundle()?.slideOptions.length || legacyTemplates().length) ? setSlidePickerOpen(true) : void addSlide()}
                  onReorder={(ids) => void reorder(ids)}
                  onDelete={(id) => void deleteSlide(id)}
                />

                <main class="stage-panel">
                  <Toolbar
                    hasSelection={selectedIds().length > 0}
                    canUndo={canUndo()}
                    canRedo={canRedo()}
                    onAddText={addText}
                    onAddShape={addShape}
                    onAddQrCode={addQrCode}
                    onPickImage={() => imageInput?.click()}
                    onDuplicate={duplicateSelected}
                    onDelete={deleteSelected}
                    onLayer={layerSelected}
                    onUndo={undo}
                    onRedo={redo}
                  />
                  <Show
                    when={slide()}
                    fallback={<div class="stage-empty" />}
                  >
                    {(current) => (
                      <Stage
                        slide={renderedSlide(current())}
                        selectedId={selectedId()}
                        selectedIds={selectedIds()}
                        onSelect={selectElement}
                        onSelectMany={(ids) => { void selectMany(ids); }}
                        remoteLocks={remoteLocks()}
                        remoteCursors={presence().filter((event) => typeof event.x === "number" && typeof event.y === "number")}
                        onCursorMove={(x, y) => sendPresence({ type: "cursor", x, y })}
                        onCursorLeave={() => sendPresence({ type: "cursor", x: null, y: null })}
                        readOnly={!canEdit()}
                        onChange={updateElement}
                        onTextCommit={updateText}
                        onCropImage={(id) => setCroppingId(id)}
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
                        onContextAction={canEdit() ? handleContextAction : undefined}
                      />
                    )}
                  </Show>
                </main>

                <aside class="editor-side-rail">
                <Show when={slide()}>
                  {(current) => (
                    <Inspector
                      slide={current()}
                      selected={selected()}
                      onElementChange={(patch) => {
                        const id = selectedId();
                        if (id) updateElement(id, patch);
                      }}
                      onSlideChange={updateSlide}
                      onDelete={deleteSelected}
                      onPreview={() => void startSlidePreview()}
                      onElementSelect={(id) => { void selectElement(id); }}
                      onCropImage={() => { const element = selected(); if (element?.type === "image") setCroppingId(element.id); }}
                      customObjectTypes={customObjectTypes()}
                      onCustomInput={updateCustomInput}
                    />
                  )}
                </Show>
                <ObjectCommentsPanel refreshKey={commentRevision()} deckId={props.deckId} branch={currentBranch()} slideId={slideId()} objectId={selectedId()} canComment={canComment()} isOwner={isOwner()} />
                </aside>
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

      <Show when={croppingId() && slide()?.elements[croppingId()!] && canEdit()}>
        <ImageCropModal element={slide()!.elements[croppingId()!]} onClose={() => setCroppingId(null)} onApply={(imageCrop) => {
          const id = croppingId();
          if (id && slide()?.elements[id]?.type === "image") updateElement(id, { imageCrop });
          setCroppingId(null);
        }} />
      </Show>

      <Show when={buildOpen() && slide()}>
        <Suspense fallback={<Modal title="Build workspace" subtitle="Loading tools…" onClose={() => setBuildOpen(false)}><p class="muted">Preparing the scripting and agent tools…</p></Modal>}>
          <BuildModal
            deckId={props.deckId}
            deckTitle={deck()?.deck.title ?? "Presentation"}
            deckSlides={Object.values({ ...previews(), [slide()!.id]: slide()! }).slice(-20)}
            sessionId={sessionId() ?? undefined}
            slide={slide()!}
            selection={selectedIds()}
            customObjectTypes={customObjectTypes()}
            onClose={() => setBuildOpen(false)}
            onApplyScript={applyScript}
            onApplyAgent={applyAgentProposal}
          />
        </Suspense>
      </Show>

      <Show when={slidePickerOpen()}>
        <Modal title="Add a slide" subtitle="Choose a layout generated by this deck’s template." onClose={() => setSlidePickerOpen(false)}>
          <div class="template-option-picker"><For each={[...(deckBundle()?.slideOptions ?? []), ...legacyTemplates().map((item) => ({ id: item.id, name: item.name, slides: [item.slide] }))]}>{(option) => <button class="template-option-card" onClick={() => { setSlidePickerOpen(false); void addSlides(option.slides); }}><strong>{option.name}</strong><span>{option.slides.length} slide{option.slides.length === 1 ? "" : "s"}</span></button>}</For></div>
          <button class="btn ghost small" onClick={() => { setSlidePickerOpen(false); void addSlide(); }}>Create a blank slide</button>
        </Modal>
      </Show>

      <Show when={timelineOpen()}>
        <TimelineModal
          deckId={props.deckId}
          branch={currentBranch()}
          branches={detail()!.branches}
          sessionId={sessionId() ?? undefined}
          canManage={canEdit()}
          refreshKey={historyRevision()}
          onClose={() => setTimelineOpen(false)}
          onCheckpoint={async () => { await createCheckpoint(); await refreshMeta(); }}
          onRestore={restoreVersion}
          onSwitch={switchBranch}
          onCreate={createBranch}
          onDelete={async (name) => { await flush(); await api.deleteBranch(props.deckId, name); await refreshMeta(); notify(`Deleted branch ${name}`, "success"); }}
          onPrepareMerge={prepareMerge}
          onMerged={onMergeComplete}
        />
      </Show>

      <Show when={printOpen() && detail()}>
        <PrintExportModal deckId={props.deckId} detail={detail()!} sessionId={sessionId() ?? undefined} onClose={() => setPrintOpen(false)} />
      </Show>

      <Show when={collaborationOpen()}>
        <CollaborationModal refreshKey={historyRevision()} deckId={props.deckId} activeBranch={currentBranch()} currentUserId={props.activeDemoUser.id} onClose={() => { setCollaborationOpen(false); void api.collaboration(props.deckId).then(setCollaboration).catch(() => undefined); }} />
      </Show>

      <Show when={presenting()}>
        <div class="present-overlay">
          <PresentSurface
            slide={presentSlide() ? renderedSlide(presentSlide()!) : null}
            canvasWidth={deck()?.deck.width ?? CANVAS_WIDTH}
            canvasHeight={deck()?.deck.height ?? CANVAS_HEIGHT}
            animationStep={presentAnimationStep()}
            transitionKey={presentTransitionKey()}
          />
          <div class="present-controls">
            <button
              class="present-btn"
              onClick={() => { if (animationTimer) window.clearTimeout(animationTimer); animationTimer = undefined; if (presentAnimationStep() > 0) setPresentAnimationStep((step) => step - 1); else void showPresent(presentIndex() - 1); }}
              disabled={presentIndex() === 0 && presentAnimationStep() === 0}
            >
              ←
            </button>
            <span>
              {previewOnly() ? "Preview · " : ""}{presentIndex() + 1} / {detail()?.slides.length ?? 0}{(presentSlide()?.animations?.length ?? 0) > 0 ? ` · ${presentAnimationStep()}/${animationStepCount(presentSlide()!)}` : ""}
            </span>
            <button class="present-btn" onClick={() => void showPresent(presentIndex())}>Restart</button>
            <button
              class="present-btn"
              onClick={advancePresentation}
              disabled={presentIndex() >= (detail()?.slides.length ?? 1) - 1 && presentAnimationStep() >= animationStepCount(presentSlide() ?? { animations: [] })}
            >
              {presentAnimationStep() < animationStepCount(presentSlide() ?? { animations: [] }) ? "Next effect →" : "Next slide →"}
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

function PresentSurface(props: {
  slide: Slide | null;
  canvasWidth: number;
  canvasHeight: number;
  animationStep: number;
  transitionKey: number;
}) {
  let container: HTMLDivElement | undefined;
  let frame: HTMLDivElement | undefined;
  let transitionAnimation: Animation | undefined;
  const [scale, setScale] = createSignal(0.5);

  onMount(() => {
    const fit = () => {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setScale(Math.min(rect.width / props.canvasWidth, rect.height / props.canvasHeight));
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (container) observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const key = props.transitionKey;
    const transition = props.slide?.transition;
    if (!frame || !transition || transition.effect === "none" || key === 0) return;
    transitionAnimation?.cancel();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const direction = transition.direction ?? "left";
    const translate = direction === "left" ? "-100%" : direction === "right" ? "100%" : direction === "up" ? "-100%" : "100%";
    const fromClip = direction === "left" ? "inset(0 0 0 100%)" : direction === "right" ? "inset(0 100% 0 0)" : direction === "up" ? "inset(100% 0 0 0)" : "inset(0 0 100% 0)";
    const frames: Keyframe[] = transition.effect === "fade"
      ? [{ opacity: 0 }, { opacity: 1 }]
      : transition.effect === "push"
        ? [{ transform: `translate(${direction === "left" || direction === "right" ? translate : "0"}, ${direction === "up" || direction === "down" ? translate : "0"})` }, { transform: "translate(0, 0)" }]
        : [{ clipPath: fromClip }, { clipPath: "inset(0 0 0 0)" }];
    transitionAnimation = frame.animate(frames, { duration: Math.max(100, Math.min(2000, transition.durationMs)), easing: "cubic-bezier(.2,.75,.25,1)", fill: "both" });
    onCleanup(() => transitionAnimation?.cancel());
  });

  onCleanup(() => transitionAnimation?.cancel());

  return (
    <div class="present-surface" ref={container}>
      <Show when={props.slide} fallback={<div class="present-empty">No slide</div>}>
        {(current) => (
          <div
            class="present-slide-frame"
            ref={frame}
            style={{
              width: `${props.canvasWidth * scale()}px`,
              height: `${props.canvasHeight * scale()}px`,
              overflow: "hidden",
              position: "relative",
                "box-shadow": "0 8px 24px rgba(55,38,29,.16)",
            }}
          >
            <div
              style={{
                width: `${props.canvasWidth}px`,
                height: `${props.canvasHeight}px`,
                transform: `scale(${scale()})`,
                "transform-origin": "top left",
                position: "absolute",
                top: "0",
                left: "0",
              }}
            >
              <StaticSlide slide={current()} animationStep={props.animationStep} />
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
