import type {
  BranchInfo,
  CommitInfo,
  DeckDetail,
  DeckSummary,
  MergePreview,
  Resolution,
  SessionInfo,
  Slide,
  SlidePayload,
  AssetInfo,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`/api${path}`, { ...init, headers });
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
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
  };
}

export const api = {
  listDecks: () => request<DeckSummary[]>("/decks"),
  getDeck: (id: string) => request<DeckDetail>(`/decks/${id}`),
  createDeck: (title: string, id?: string) =>
    request<DeckDetail>("/decks", json({ title, id })),
  deleteDeck: (id: string) =>
    request<void>(`/decks/${id}`, { method: "DELETE" }),
  updateDeck: (id: string, body: { title?: string; tokens?: Record<string, unknown> }) =>
    request<DeckDetail>(`/decks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  getSlide: (deckId: string, slideId: string) =>
    request<SlidePayload>(`/decks/${deckId}/slides/${slideId}`),
  writeSlide: (
    deckId: string,
    slideId: string,
    slide: Slide,
    sessionId?: string,
  ) =>
    request<SlidePayload>(`/decks/${deckId}/slides/${slideId}`, {
      method: "PUT",
      body: JSON.stringify({ slide, sessionId }),
    }),
  writeNotes: (deckId: string, slideId: string, notes: string, sessionId?: string) =>
    request<SlidePayload>(`/decks/${deckId}/slides/${slideId}/notes`, {
      method: "PUT",
      body: JSON.stringify({ notes, sessionId }),
    }),
  createSlide: (deckId: string, after?: string, sessionId?: string) =>
    request<SlidePayload>(`/decks/${deckId}/slides`, json({ after, sessionId })),
  deleteSlide: (deckId: string, slideId: string) =>
    request<DeckDetail>(`/decks/${deckId}/slides/${slideId}`, { method: "DELETE" }),
  reorderSlides: (deckId: string, slides: string[], sessionId?: string) =>
    request<DeckDetail>(`/decks/${deckId}/order`, {
      method: "PUT",
      body: JSON.stringify({ slides, sessionId }),
    }),
  uploadAsset: async (deckId: string, slideId: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<AssetInfo>(`/decks/${deckId}/slides/${slideId}/assets`, {
      method: "POST",
      body: form,
    });
  },

  createSession: (deckId: string) =>
    request<SessionInfo>(`/decks/${deckId}/sessions`, json({})),
  commitSession: (sessionId: string, message?: string) =>
    request<CommitInfo>(`/sessions/${sessionId}/commit`, json({ message })),
  closeSession: (sessionId: string) =>
    fetch(`/api/sessions/${sessionId}/close`, {
      method: "POST",
      keepalive: true,
    }).catch(() => undefined),

  checkpoint: (deckId: string, message?: string) =>
    request<CommitInfo>(`/decks/${deckId}/checkpoint`, json({ message })),
  commits: (deckId: string) => request<CommitInfo[]>(`/decks/${deckId}/commits`),
  branches: (deckId: string) => request<BranchInfo[]>(`/decks/${deckId}/branches`),
  createBranch: (
    deckId: string,
    body: { name: string; from?: string; checkout?: boolean; sessionId?: string },
  ) => request<DeckDetail>(`/decks/${deckId}/branches`, json(body)),
  checkout: (deckId: string, branch: string, sessionId?: string) =>
    request<DeckDetail>(`/decks/${deckId}/checkout`, json({ branch, sessionId })),

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
  ) =>
    request<CommitInfo>(
      `/decks/${deckId}/merge/apply`,
      json({ source, resolutions, message }),
    ),
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
