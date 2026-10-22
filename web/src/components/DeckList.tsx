import { For, Show, createSignal, onMount } from "solid-js";
import type { DeckSummary } from "../types";
import { api, formatTime } from "../api";

interface DeckListProps {
  onOpen: (id: string) => void;
}

const PREVIEW_TONES = [
  "bg-coral-200",
  "bg-lavender-200",
  "bg-mint-200",
  "bg-blush-200",
  "bg-butter-200",
  "bg-sky-200",
];

export function DeckList(props: DeckListProps) {
  const [decks, setDecks] = createSignal<DeckSummary[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [showForm, setShowForm] = createSignal(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setDecks(await api.listDecks());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  onMount(refresh);

  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = title().trim();
    if (!value) return;
    setCreating(true);
    setError(null);
    try {
      const deck = await api.createDeck(value);
      setTitle("");
      setShowForm(false);
      props.onOpen(deck.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (deck: DeckSummary) => {
    if (!window.confirm(`Delete "${deck.title}" and its Git repository? This cannot be undone.`)) {
      return;
    }
    try {
      await api.deleteDeck(deck.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main class="home mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-5 py-7 md:px-9 md:py-10">
      <header class="home-header flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <span class="brand-mark">P</span>
          <div>
            <h1 class="text-xl font-extrabold tracking-tight text-cocoa-900">Present</h1>
            <p class="text-xs font-medium text-cocoa-500">Git-native presentations</p>
          </div>
        </div>
        <button class="btn accent" onClick={() => setShowForm((v) => !v)}>
          + New deck
        </button>
      </header>

      <section class="home-hero relative grid gap-8 overflow-hidden rounded-4xl border border-cream-300 bg-cream-50 p-6 md:p-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
        <div class="relative">
          <p class="mb-3 inline-flex items-center gap-2 rounded-full border border-coral-300 bg-coral-200/60 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-cocoa-700">
            <span class="h-1.5 w-1.5 rounded-full bg-coral-600" />
            Local-first · branchable · mergeable
          </p>
          <h2 class="max-w-[18ch] text-balance text-3xl font-extrabold leading-[1.08] tracking-[-0.03em] text-cocoa-900 md:text-5xl">
            Collaborative slides so painless its a gift; Present.
          </h2>
          <p class="mt-5 max-w-[58ch] text-sm leading-7 text-cocoa-600 md:text-[15px]">
            Every deck is a Git repo. Each slide is an isolated folder with a canonical JSON AST,
            co-located assets, and Markdown notes. Sessions become commits, and merges are resolved
            visually instead of with line markers.
          </p>
          <div class="mt-6 flex flex-wrap gap-2">
            <span class="rounded-full border border-coral-300 bg-coral-200/60 px-3 py-1.5 text-xs font-semibold text-cocoa-700">
              Flat sorted AST
            </span>
            <span class="rounded-full border border-lavender-300 bg-lavender-200/70 px-3 py-1.5 text-xs font-semibold text-cocoa-700">
              Session commits
            </span>
            <span class="rounded-full border border-mint-300 bg-mint-200/75 px-3 py-1.5 text-xs font-semibold text-cocoa-700">
              3-way semantic merge
            </span>
            <span class="rounded-full border border-butter-300 bg-butter-200/80 px-3 py-1.5 text-xs font-semibold text-cocoa-700">
              Sandboxed scripting
            </span>
          </div>
        </div>
        <div
          class="relative overflow-hidden rounded-2xl border border-tan-300 bg-cream-100 p-5 font-mono text-[11.5px] leading-7 text-cocoa-700"
          aria-hidden="true"
        >
          <div class="mb-3 flex items-center gap-1.5">
            <span class="h-2.5 w-2.5 rounded-full bg-coral-400" />
            <span class="h-2.5 w-2.5 rounded-full bg-butter-300" />
            <span class="h-2.5 w-2.5 rounded-full bg-mint-300" />
            <span class="ml-auto text-[10px] text-cocoa-500">deck-repo</span>
          </div>
          <div class="text-cocoa-600">deck-repo/</div>
          <div>├── deck.json</div>
          <div>└── slides/</div>
          <div class="pl-6 text-coral-600">├── s_01_title/</div>
          <div class="pl-12 text-cocoa-600">├── slide.json</div>
          <div class="pl-12 text-sage-400">└── notes.md</div>
          <div class="pl-6 text-berry-400">└── s_02_repository/</div>
        </div>
      </section>

      <Show when={showForm()}>
        <form
          class="create-card flex flex-col gap-3 rounded-2xl border border-tan-300 bg-cream-50 p-4 sm:flex-row sm:items-end"
          onSubmit={create}
        >
          <label class="field flex-1">
            <span>Deck title</span>
            <input
              autofocus
              type="text"
              placeholder="Quarterly review"
              value={title()}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <button class="btn accent" type="submit" disabled={creating()}>
            {creating() ? "Creating repository…" : "Create deck"}
          </button>
        </form>
      </Show>

      <Show when={error()}>
        <div class="alert error">{error()}</div>
      </Show>

      <section class="decks-section flex flex-col gap-4">
        <div class="section-head flex items-center justify-between gap-4">
          <h3 class="text-lg font-extrabold tracking-tight text-cocoa-900">Your decks</h3>
          <button class="link" onClick={refresh}>
            Refresh
          </button>
        </div>
        <Show
          when={!loading()}
          fallback={
            <div class="skeleton-grid grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div class="h-56 animate-pulse rounded-2xl border border-cream-300 bg-cream-200/70" />
              <div class="h-56 animate-pulse rounded-2xl border border-cream-300 bg-cream-200/70" />
              <div class="h-56 animate-pulse rounded-2xl border border-cream-300 bg-cream-200/70" />
            </div>
          }
        >
          <Show
            when={decks().length > 0}
            fallback={
              <div class="empty-decks grid place-items-center gap-3 rounded-3xl border border-dashed border-tan-400 bg-cream-50/60 px-6 py-16 text-center">
                <div class="grid h-12 w-12 place-items-center rounded-2xl bg-butter-200 text-xl">✦</div>
                <h3 class="text-base font-bold text-cocoa-900">No decks yet</h3>
                <p class="max-w-sm text-sm leading-6 text-cocoa-500">
                  Create a deck to initialize its Git repository and starter slides.
                </p>
                <button class="btn accent" onClick={() => setShowForm(true)}>
                  Create your first deck
                </button>
              </div>
            }
          >
            <div class="deck-grid grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <For each={decks()}>
                {(deck, index) => (
                  <article
                    class="deck-card group cursor-pointer overflow-hidden rounded-2xl border border-cream-300 bg-cream-50 transition-colors hover:border-tan-400"
                    onClick={() => props.onOpen(deck.id)}
                  >
                    <div
                      class={`deck-preview relative flex aspect-[16/8] items-end p-3 ${
                        PREVIEW_TONES[index() % PREVIEW_TONES.length]
                      }`}
                    >
                      <div class="deck-preview-inner relative flex w-full items-end justify-between gap-2">
                        <span class="deck-monogram grid h-14 w-14 place-items-center rounded-2xl border border-white/70 bg-cream-50 text-2xl font-extrabold text-cocoa-900">
                          {deck.title.slice(0, 1).toUpperCase()}
                        </span>
                        <span class="deck-slide-count rounded-full border border-white/70 bg-cream-50 px-2.5 py-1 text-[10px] font-bold text-cocoa-700">
                          {deck.slideCount} slides
                        </span>
                      </div>
                    </div>
                    <div class="deck-info flex items-start justify-between gap-3 px-4 py-3.5">
                      <div class="min-w-0">
                        <h3 class="truncate text-[15px] font-bold text-cocoa-900">{deck.title}</h3>
                        <div class="deck-meta mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-cocoa-500">
                          <span class="branch-chip rounded-full border border-mint-300 bg-mint-200/70 px-2 py-0.5 font-semibold text-cocoa-700">
                            ⑂ {deck.currentBranch}
                          </span>
                          <Show when={deck.dirty}>
                            <span class="dirty-chip rounded-full border border-butter-300 bg-butter-200/80 px-2 py-0.5 font-semibold text-cocoa-700">
                              uncommitted
                            </span>
                          </Show>
                          <span class="pl-0.5">{formatTime(deck.updatedAt)}</span>
                        </div>
                      </div>
                      <button
                        class="icon-btn danger shrink-0 opacity-0 transition group-hover:opacity-100"
                        title="Delete deck"
                        onClick={(event) => {
                          event.stopPropagation();
                          remove(deck);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>

      <footer class="home-footer mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-cream-300 pt-4 text-[11px] text-cocoa-500">
        <span>
          Deck repositories live under <code class="rounded bg-cream-200 px-1.5 py-0.5 font-mono text-[10px]">data/decks/</code>
        </span>
        <span>Axum · git2 · SolidJS</span>
      </footer>
    </main>
  );
}
