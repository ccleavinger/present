import { For, Show, createSignal, onMount, onCleanup } from "solid-js";
import type { DeckSummary, TemplateBundleSummary } from "../types";
import { api, formatTime } from "../api";
import { TemplateLibraryModal, runTemplateGenerator } from "./TemplateLibraryModal";
import type { DemoUser } from "../types";
import type { Slide } from "../types";
import { DeckCardPreview } from "./DeckCardPreview";
import { UserMenu } from "./UserMenu";
import { ImportPptxModal } from "./ImportPptxModal";

interface DeckListProps {
  onOpen: (id: string) => void;
  activeDemoUser: DemoUser;
  onSignOut: () => void;
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
  const [templateId, setTemplateId] = createSignal("starter");
  const [showForm, setShowForm] = createSignal(false);
  const [bundles, setBundles] = createSignal<TemplateBundleSummary[]>([]);
  const [templatesOpen, setTemplatesOpen] = createSignal(false);
  const [importOpen, setImportOpen] = createSignal(false);
  const [previews, setPreviews] = createSignal<Record<string, Slide>>({});

  const refresh = async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    try {
      const nextDecks = await api.listDecks();
      setDecks(nextDecks);
      const loaded = await Promise.all(nextDecks.filter((deck) => deck.firstSlideId).map(async (deck) => {
        try { return [deck.id, (await api.getSlide(deck.id, deck.firstSlideId!, undefined, deck.currentBranch)).slide] as const; }
        catch { return null; }
      }));
      setPreviews(Object.fromEntries(loaded.filter((item): item is NonNullable<typeof item> => item !== null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let refreshTimer: number | undefined;
    let refreshing = false;
    let again = false;
    const update = async () => {
      if (disposed) return;
      if (refreshing) { again = true; return; }
      refreshing = true;
      try { await refresh(true); } finally {
        refreshing = false;
        if (again) { again = false; schedule(); }
      }
    };
    const schedule = () => {
      if (!disposed && !refreshTimer) refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void update(); }, 350);
    };
    const connect = () => {
      if (disposed) return;
      socket = api.connectLibrary(schedule);
      socket.addEventListener("close", () => { if (!disposed) retryTimer = window.setTimeout(connect, 1500); });
    };
    connect();
    window.addEventListener("online", schedule);
    window.addEventListener("focus", schedule);
    onCleanup(() => {
      disposed = true; socket?.close();
      if (retryTimer) window.clearTimeout(retryTimer);
      if (refreshTimer) window.clearTimeout(refreshTimer);
      window.removeEventListener("online", schedule); window.removeEventListener("focus", schedule);
    });
  });

  onMount(() => { void refresh(); void api.templateBundles().then(setBundles).catch((err) => setError(String(err))); });

  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = title().trim();
    if (!value) return;
    setCreating(true);
    setError(null);
    try {
      const bundle = bundles().find((item) => item.id === templateId());
      let readyBundle = bundle?.kind === "code" ? await api.getTemplateBundle(bundle.id) : undefined;
      if (readyBundle?.generator) {
        const generated = await runTemplateGenerator(readyBundle.generator, readyBundle.customObjectTypes);
        readyBundle = { ...readyBundle, ...generated };
      }
      const deck = await api.createDeck(value, undefined, bundle ? bundle.id : templateId(), readyBundle);
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
        <div class="home-header-actions">
          <button class="btn ghost small" onClick={() => setTemplatesOpen(true)}>Templates</button>
          <UserMenu user={props.activeDemoUser} onSignOut={props.onSignOut} />
        </div>
      </header>

      <section class="deck-create-launcher" aria-label="Create a presentation">
        <div><span class="create-launcher-icon">✦</span><div><h2>Start with a blank page or a spark</h2><p>Choose a template or bring your PowerPoint slides.</p></div></div>
        <div class="create-launcher-actions"><button class="btn" onClick={() => setImportOpen(true)}>Import PowerPoint</button><button class="btn accent create-launcher-button" onClick={() => setShowForm((value) => !value)}>{showForm() ? "Close" : "+ Create a presentation"}</button></div>
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
          <label class="field">
            <span>Starting point</span>
            <select value={templateId()} onChange={(event) => setTemplateId(event.currentTarget.value)}>
              <option value="starter">Present starter deck</option>
              <option value="blank">Blank slide</option>
              <For each={bundles()}>{(bundle) => <option value={bundle.id}>{bundle.name} template</option>}</For>
            </select>
          </label>
          <button class="btn accent" type="submit" disabled={creating()}>
            {creating() ? "Creating repository…" : "Create deck"}
          </button>
        </form>
      </Show>

      <Show when={templatesOpen()}><TemplateLibraryModal onClose={() => { setTemplatesOpen(false); void api.templateBundles().then(setBundles); }} /></Show>
      <Show when={importOpen()}><ImportPptxModal onClose={() => setImportOpen(false)} onCreated={(id) => { setImportOpen(false); props.onOpen(id); }} /></Show>

      <Show when={error()}>
        <div class="alert error">{error()}</div>
      </Show>

      <section class="decks-section flex flex-col gap-4">
        <div class="section-head flex items-center justify-between gap-4">
          <h3 class="text-lg font-extrabold tracking-tight text-cocoa-900">Your decks</h3>
          <button class="link" onClick={() => void refresh()}>
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
                  <article class="deck-card group relative overflow-hidden rounded-2xl border border-cream-300 bg-cream-50 transition-colors hover:border-tan-400">
                    <a
                      class="deck-card-link block"
                      href={`#/deck/${encodeURIComponent(deck.id)}`}
                      aria-label={`Open ${deck.title}`}
                      onClick={() => props.onOpen(deck.id)}
                    >
                    <div
                      class={`deck-preview relative flex aspect-[16/8] items-end p-3 ${
                        PREVIEW_TONES[index() % PREVIEW_TONES.length]
                      }`}
                    >
                      <Show when={previews()[deck.id]} fallback={<span class="deck-monogram grid h-14 w-14 place-items-center rounded-2xl border border-white/70 bg-cream-50 text-2xl font-extrabold text-cocoa-900">{deck.title.slice(0, 1).toUpperCase()}</span>}>
                        {(preview) => <DeckCardPreview slide={preview()} />}
                      </Show>
                      <div class="deck-preview-inner relative flex w-full items-end justify-between gap-2">
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
                        <div class="deck-card-footer">
                          <span class={`permission-chip role-${deck.currentUserRole ?? "view"}`}>{deck.isOwner ? "Owner" : `${deck.currentUserRole ?? "view"} access`}</span>
                          <div class="collaborator-stack" aria-label={`${deck.collaborators?.length ?? 0} collaborators`}>
                            <For each={(deck.collaborators ?? []).slice(0, 3)}>{(collaborator) => <span class="user-avatar tiny" title={collaborator.username}>{collaborator.username.slice(0, 1).toUpperCase()}</span>}</For>
                            <Show when={(deck.collaborators?.length ?? 0) > 3}><span class="avatar-overflow">+{(deck.collaborators?.length ?? 0) - 3}</span></Show>
                          </div>
                        </div>
                      </div>
                    </div>
                    </a>
                    <Show when={deck.isOwner}><button
                      class="deck-card-delete icon-btn danger absolute right-3 top-3 z-10 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                      title="Delete deck"
                      aria-label={`Delete ${deck.title}`}
                      onClick={() => remove(deck)}
                    >✕</button></Show>
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
