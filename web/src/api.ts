import type {
  BranchInfo,
  CommitInfo,
  HistoryPage,
  CommitSnapshot,
  DeckDetail,
  DeckSummary,
  MergePreview,
  Resolution,
  SessionInfo,
  Slide,
  SlidePayload,
  SlideTemplate,
  AssetInfo,
  TemplateBundle,
  TemplateBundleSummary,
  DemoUser,
  DeckCollaboration,
  DeckRole,
  ObjectComment,
  PresenceEvent,
  ShareLink,
  ShareLinkPreview,
} from "./types";

const ACTIVE_DEMO_USER_KEY = "present.activeDemoUserId";

export function activeDemoUserId(): string | null {
  try { return localStorage.getItem(ACTIVE_DEMO_USER_KEY); } catch { return null; }
}

export function setActiveDemoUserId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_DEMO_USER_KEY, id);
    else localStorage.removeItem(ACTIVE_DEMO_USER_KEY);
  } catch { /* The in-memory selection still works for this page load. */ }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const headers = new Headers(init?.headers);
  const activeUser = activeDemoUserId();
  if (activeUser) headers.set("X-Present-User", activeUser);
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api${path}`, { ...init, headers, signal: controller.signal });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.error ?? message;
      } catch {
        // Response was not JSON.
      }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(408, "The server did not respond in time. Your changes are still pending; retry saving.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
  };
}

function templateJson(body: unknown): RequestInit {
  const serialized = JSON.stringify(body);
  // Stay below Axum's 105 MiB request limit with room for request framing.
  if (new Blob([serialized]).size > 100 * 1024 * 1024) {
    throw new Error("This template is larger than the 100 MiB limit. Remove some large or repeated images and try again.");
  }
  return { method: "POST", body: serialized };
}

export const api = {
  demoUsers: () => request<DemoUser[]>("/users"),
  createDemoUser: (username: string) => request<DemoUser>("/users", json({ username, displayName: username })),
  signInDemoUser: (username: string) => request<DemoUser>("/users/sign-in", json({ username })),
  listDecks: () => request<DeckSummary[]>("/decks"),
  getDeck: (id: string, sessionId?: string, branch?: string) => request<DeckDetail>(`/decks/${id}?${new URLSearchParams({ ...(sessionId ? { sessionId } : {}), ...(branch ? { branch } : {}) })}`),
  createDeck: (title: string, id?: string, templateId = "starter", templateBundle?: TemplateBundle) =>
    request<DeckDetail>("/decks", templateBundle ? templateJson({ title, id, templateId, templateBundle }) : json({ title, id, templateId })),
  generateAgentScript: (deckId: string, body: { request: string; feedback?: string; slides: Slide[]; deckTitle: string }, sessionId?: string) =>
    request<{ script: string; model: string }>(`/decks/${deckId}/agent/script${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { method: "POST", body: JSON.stringify(body) }, 90_000),
  templateBundles: () => request<TemplateBundleSummary[]>("/templates"),
  saveTemplateBundle: (bundle: TemplateBundle) => request<TemplateBundleSummary>("/templates", templateJson(bundle)),
  getTemplateBundle: (id: string) => request<TemplateBundle>(`/templates/${id}`),
  deleteTemplateBundle: (id: string) => request<void>(`/templates/${id}`, { method: "DELETE" }),
  deckTemplateBundle: (deckId: string, sessionId?: string) => request<TemplateBundle | null>(`/decks/${deckId}/template-bundle${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  deleteDeck: (id: string) =>
    request<void>(`/decks/${id}`, { method: "DELETE" }),
  updateDeck: (id: string, body: { title?: string; tokens?: Record<string, unknown>; sessionId?: string }) =>
    request<DeckDetail>(`/decks/${id}${body.sessionId ? `?sessionId=${encodeURIComponent(body.sessionId)}` : ""}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  getSlide: (deckId: string, slideId: string, sessionId?: string, branch?: string) => {
    const query = new URLSearchParams();
    if (sessionId) query.set("sessionId", sessionId);
    if (branch) query.set("branch", branch);
    return request<SlidePayload>(`/decks/${deckId}/slides/${slideId}${query.size ? `?${query}` : ""}`);
  },
  writeSlide: (
    deckId: string,
    slideId: string,
    slide: Slide,
    sessionId?: string,
    notes?: string,
    baseSlide?: Slide,
    baseNotes?: string,
  ) =>
    request<SlidePayload>(`/decks/${deckId}/slides/${slideId}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ slide, sessionId, notes, baseSlide, baseNotes }),
    }),
  writeNotes: (deckId: string, slideId: string, notes: string, sessionId?: string, baseNotes?: string) =>
    request<SlidePayload>(`/decks/${deckId}/slides/${slideId}/notes${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ notes, sessionId, baseNotes }),
    }),
  createSlide: (deckId: string, after?: string, sessionId?: string, template?: Slide) =>
    request<SlidePayload>(`/decks/${deckId}/slides${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, json({ after, sessionId, template })),
  slideTemplates: (deckId: string, sessionId?: string) => request<SlideTemplate[]>(`/decks/${deckId}/templates/slides${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  saveSlideTemplate: (deckId: string, name: string, slide: Slide, sessionId?: string) => request<SlideTemplate>(`/decks/${deckId}/templates/slides${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, json({ name, slide })),
  deleteSlideTemplate: (deckId: string, templateId: string, sessionId?: string) => request<void>(`/decks/${deckId}/templates/slides/${templateId}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { method: "DELETE" }),
  deleteSlide: (deckId: string, slideId: string, sessionId?: string) =>
    request<DeckDetail>(`/decks/${deckId}/slides/${slideId}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { method: "DELETE" }),
  reorderSlides: (deckId: string, slides: string[], sessionId?: string) =>
    request<DeckDetail>(`/decks/${deckId}/order${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ slides, sessionId }),
    }),
  uploadAsset: async (deckId: string, slideId: string, file: File, sessionId?: string) => {
    const form = new FormData();
    // Clipboard image files commonly reuse image.png. Give each insertion its
    // own URL so a later paste cannot overwrite or reuse a cached earlier image.
    const extension = file.name.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? "";
    const stem = (extension ? file.name.slice(0, -extension.length) : file.name).replace(/[^a-z0-9_-]/gi, "-").slice(0, 65) || "image";
    const name = `${stem}-${crypto.randomUUID().replaceAll("-", "")}${extension}`;
    form.append("file", new File([file], name, { type: file.type, lastModified: file.lastModified }));
    return request<AssetInfo>(`/decks/${deckId}/slides/${slideId}/assets${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, {
      method: "POST",
      body: form,
    }, 120_000);
  },

  createSession: (deckId: string, branch?: string) =>
    request<SessionInfo>(`/decks/${deckId}/sessions${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`, json({ branch })),
  commitSession: (sessionId: string, message?: string) =>
    request<CommitInfo>(`/sessions/${sessionId}/commit`, json({ message })),
  closeSession: (sessionId: string) =>
    request<void>(`/sessions/${sessionId}/close`, { method: "POST", keepalive: true }),

  checkpoint: (deckId: string, message?: string) =>
    request<CommitInfo>(`/decks/${deckId}/checkpoint`, json({ message })),
  commits: (deckId: string, limit = 50, sessionId?: string) => request<CommitInfo[]>(`/decks/${deckId}/commits?limit=${limit}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  history: (deckId: string, branch: string, before?: string) => {
    const query = new URLSearchParams({ branch, limit: "40" });
    if (before) query.set("before", before);
    return request<HistoryPage>(`/decks/${deckId}/history?${query}`);
  },
  commitSnapshot: (deckId: string, branch: string, commitId: string) =>
    request<CommitSnapshot>(`/decks/${deckId}/history/${commitId}?${new URLSearchParams({ branch })}`),
  restoreCommit: (deckId: string, branch: string, commitId: string, expectedHead: string) =>
    request<CommitInfo>(`/decks/${deckId}/history/${commitId}/restore?${new URLSearchParams({ branch })}`, json({ expectedHead }), 120_000),

  branches: (deckId: string) => request<BranchInfo[]>(`/decks/${deckId}/branches`),
  createBranch: (
    deckId: string,
    body: { name: string; from?: string; checkout?: boolean; sessionId?: string },
    ) => request<DeckDetail>(`/decks/${deckId}/branches?${new URLSearchParams({ branch: body.from ?? "main", ...(body.sessionId ? { sessionId: body.sessionId } : {}) })}`, json(body)),
  deleteBranch: (deckId: string, name: string) => request<void>(`/decks/${deckId}/branches?branch=${encodeURIComponent(name)}`, { method: "DELETE", body: JSON.stringify({ name }) }),
  checkout: (deckId: string, branch: string, sessionId?: string) =>
    request<DeckDetail>(`/decks/${deckId}/checkout?branch=${encodeURIComponent(branch)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`, json({ branch, sessionId })),

  mergePreview: (deckId: string, source: string, target?: string) => {
    const query = new URLSearchParams({ source });
    if (target) query.set("target", target);
    return request<MergePreview>(`/decks/${deckId}/merge/preview?${query}`);
  },
  applyMerge: (
    deckId: string,
    source: string,
    resolutions: Resolution[],
    message?: string,
    sessionId?: string,
  ) =>
    request<CommitInfo>(
      `/decks/${deckId}/merge/apply${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
      json({ source, resolutions, message, sessionId }),
    ),
  collaboration: (deckId: string) => request<DeckCollaboration>(`/decks/${deckId}/collaboration`),
  shareLinks: (deckId: string) => request<ShareLink[]>(`/decks/${deckId}/collaboration/links`),
  createShareLink: (deckId: string, branch: string, role: DeckRole) => request<ShareLink>(`/decks/${deckId}/collaboration/links`, json({ branch, role })),
  revokeShareLink: (deckId: string, linkId: string) => request<void>(`/decks/${deckId}/collaboration/links/${encodeURIComponent(linkId)}`, { method: "DELETE" }),
  shareLinkPreview: (deckId: string, token: string) => request<ShareLinkPreview>(`/share/${encodeURIComponent(deckId)}/${encodeURIComponent(token)}`),
  joinShareLink: (deckId: string, token: string) => request<ShareLinkPreview>(`/share/${encodeURIComponent(deckId)}/${encodeURIComponent(token)}/join`, json({})),
  setCollaborator: (deckId: string, username: string, branch: string, role: DeckRole) =>
    request<DeckCollaboration>(`/decks/${deckId}/collaboration/members`, json({ username, branch, role })),
  removeCollaborator: (deckId: string, username: string, branch: string) =>
    request<DeckCollaboration>(`/decks/${deckId}/collaboration/members?${new URLSearchParams({ username, branch })}`, { method: "DELETE" }),
  comments: (deckId: string, branch: string) => request<ObjectComment[]>(`/decks/${deckId}/comments?branch=${encodeURIComponent(branch)}`),
  addComment: (deckId: string, branch: string, slideId: string, objectId: string, message: string, parentId?: string) =>
    request<ObjectComment>(`/decks/${deckId}/comments?branch=${encodeURIComponent(branch)}`, json({ slideId, objectId, message, parentId })),
  updateComment: (deckId: string, branch: string, id: string, message: string) =>
    request<ObjectComment>(`/decks/${deckId}/comments/${id}?branch=${encodeURIComponent(branch)}`, { method: "PUT", body: JSON.stringify({ message }) }),
  deleteComment: (deckId: string, branch: string, id: string) =>
    request<void>(`/decks/${deckId}/comments/${id}?branch=${encodeURIComponent(branch)}`, { method: "DELETE" }),
  updateLocks: (deckId: string, branch: string, objectIds: string[], release = false, sessionId?: string) =>
    request<{ acquired: string[] }>(`/decks/${deckId}/locks?${new URLSearchParams({ branch, ...(sessionId ? { sessionId } : {}) })}`, json({ branch, objectIds, release, sessionId }), release ? 5_000 : 10_000),
  connectLibrary: (onUpdate: () => void) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/events?${new URLSearchParams({ demoUserId: activeDemoUserId() ?? "" })}`);
    socket.addEventListener("message", () => onUpdate());
    return socket;
  },
  connectPresence: (deckId: string, branch: string, slideId: string, onEvent: (event: PresenceEvent) => void, sessionId?: string) => {
    const demoUserId = activeDemoUserId();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/api/decks/${encodeURIComponent(deckId)}/presence?branch=${encodeURIComponent(branch)}&slideId=${encodeURIComponent(slideId)}&demoUserId=${encodeURIComponent(demoUserId ?? "")}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`;
    const socket = new WebSocket(url);
    socket.addEventListener("message", (message) => {
      let event: PresenceEvent;
      try { event = JSON.parse(String(message.data)) as PresenceEvent; } catch { return; }
      onEvent(event);
    });
    return socket;
  },
};

export function formatTime(seconds: number): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
