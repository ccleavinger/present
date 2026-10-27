import { Show, createSignal, onMount, onCleanup } from "solid-js";
import { api } from "../api";
import type { DemoUser, ShareLinkPreview } from "../types";

export function SharedPresentation(props: { deckId: string; token: string; user: DemoUser; onOpen: (id: string, branch?: string) => void; onBack: () => void }) {
  const [preview, setPreview] = createSignal<ShareLinkPreview | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [joining, setJoining] = createSignal(false);
  const [error, setError] = createSignal("");
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const refresh = async () => {
    setLoading(true); setError("");
    try { const next = await api.shareLinkPreview(props.deckId, props.token); if (!disposed) setPreview(next); }
    catch (reason) { if (!disposed) { setPreview(null); setError(reason instanceof Error ? reason.message : String(reason)); } }
    finally { if (!disposed) setLoading(false); }
  };
  onMount(() => { void refresh(); });
  const open = async () => {
    setJoining(true); setError("");
    try { const joined = await api.joinShareLink(props.deckId, props.token); if (!disposed) props.onOpen(joined.deckId, joined.branch); }
    catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setJoining(false); }
  };
  return <main class="share-page"><section class="share-entry-card">
    <span class="brand-mark">P</span><p class="muted small">Shared presentation · signed in as {props.user.username}</p>
    <Show when={!loading()} fallback={<p role="status">Opening sharing link…</p>}>
      <Show when={preview()}>{(link) => <>
        <h1>{link().title}</h1><p>{link().owner.username} shared the <strong>{link().branch}</strong> branch with you.</p>
        <span class={`permission-chip role-${link().role}`}>{link().role === "edit" ? "Can edit" : link().role === "comment" ? "Can comment" : "Can view"}</span>
        <p class="muted small">{link().role === "edit" ? "Edit slides and collaborate live." : link().role === "comment" ? "View slides and join object conversations." : "View slides and saved versions."}</p>
        <button class="btn accent" disabled={joining()} onClick={() => void open()}>{joining() ? "Joining…" : "Open presentation"}</button>
      </>}</Show>
      <Show when={error()}><p class="script-error" role="alert">{error()}</p><button class="btn ghost small" disabled={joining()} onClick={() => void refresh()}>Try again</button></Show>
    </Show>
    <button class="link" disabled={joining()} onClick={props.onBack}>Back to your decks</button>
  </section></main>;
}
