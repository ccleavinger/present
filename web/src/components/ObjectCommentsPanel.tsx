import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { ObjectComment } from "../types";
import { equalValue } from "../collaboration";
import { activeDemoUserId, api } from "../api";

export function ObjectCommentsPanel(props: { deckId: string; branch: string; refreshKey?: number; slideId?: string | null; objectId?: string | null; canComment: boolean; isOwner: boolean }) {
  const [comments, setComments] = createSignal<ObjectComment[]>([]);
  const [message, setMessage] = createSignal("");
  const [replyTo, setReplyTo] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  let request = 0;
  let activeContext = "";
  onCleanup(() => { request += 1; });
  const refresh = async () => {
    const revision = ++request;
    const objectId = props.objectId, slideId = props.slideId, branch = props.branch;
    const context = `${branch}:${slideId}:${objectId}`;
    if (!objectId || !slideId) { setComments([]); return; }
    if (context !== activeContext) { setComments([]); setLoading(true); activeContext = context; }
    setError("");
    try {
      const next = (await api.comments(props.deckId, branch)).filter((comment) => comment.objectId === objectId && comment.slideId === slideId);
      if (revision !== request) return;
      setComments((previous) => next.map((comment) => {
        const existing = previous.find((item) => item.id === comment.id);
        return existing && equalValue(existing, comment) ? existing : comment;
      }));
    } catch (err) { if (revision === request) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (revision === request) setLoading(false); }
  };
  createEffect(() => { props.objectId; props.slideId; props.branch; props.refreshKey; void refresh(); });
  const roots = () => comments().filter((item) => !item.parentId);
  const replies = (id: string) => comments().filter((item) => item.parentId === id);
  const submit = async (event: SubmitEvent, parentId?: string) => {
    event.preventDefault(); if (!props.objectId || !props.slideId || !message().trim()) return;
    try { await api.addComment(props.deckId, props.branch, props.slideId, props.objectId, message().trim(), parentId); setMessage(""); setReplyTo(null); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const remove = async (id: string) => { try { await api.deleteComment(props.deckId, props.branch, id); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } };
  const edit = async (item: ObjectComment) => {
    const value = window.prompt("Edit comment", item.message);
    if (value === null || !value.trim()) return;
    try { await api.updateComment(props.deckId, props.branch, item.id, value); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const canManage = (item: ObjectComment) => item.author.id === activeDemoUserId();

  return <aside class="object-comments-panel">
    <div class="panel-heading"><h3>Object conversation</h3><span>{comments().length} messages</span></div>
    <Show when={props.objectId} fallback={<p class="text-sm text-cocoa-500">Select an object to view its comments.</p>}>
      <Show when={!loading()} fallback={<p class="text-xs text-cocoa-500">Loading comments…</p>}>
        <div class="object-comment-list"><For each={roots()}>{(root) => <article class="comment-thread">
          <CommentMessage item={root} canEdit={canManage(root)} canDelete={canManage(root) || props.isOwner} onEdit={() => void edit(root)} onDelete={() => void remove(root.id)} />
          <For each={replies(root.id)}>{(reply) => <CommentMessage item={reply} canEdit={canManage(reply)} canDelete={canManage(reply) || props.isOwner} onEdit={() => void edit(reply)} onDelete={() => void remove(reply.id)} />}</For>
          <Show when={props.canComment}><button class="link tiny-link" onClick={() => setReplyTo(replyTo() === root.id ? null : root.id)}>Reply</button>
            <Show when={replyTo() === root.id}><form class="comment-compose" onSubmit={(event) => void submit(event, root.id)}><textarea maxlength="500" value={message()} onInput={(event) => setMessage(event.currentTarget.value)} placeholder="Write a short reply…" /><button class="btn accent small">Reply</button></form></Show>
          </Show>
        </article>}</For><Show when={roots().length === 0}><p class="text-sm text-cocoa-500">No comments yet.</p></Show></div>
      </Show>
      <Show when={props.canComment}><form class="comment-compose mt-3" onSubmit={(event) => void submit(event)}><textarea maxlength="500" value={message()} onInput={(event) => setMessage(event.currentTarget.value)} placeholder="Start a conversation…" /><button class="btn accent small">Comment</button></form></Show>
    </Show>
    <Show when={error()}><p class="demo-user-error">{error()}</p></Show>
  </aside>;
}

function CommentMessage(props: { item: ObjectComment; canEdit: boolean; canDelete: boolean; onEdit: () => void; onDelete: () => void }) {
  return <div class={`comment-message ${props.item.parentId ? "reply" : ""}`}>
    <span class="user-avatar tiny">{props.item.author.username.slice(0, 1).toUpperCase()}</span>
    <div class="min-w-0 flex-1"><div class="comment-meta"><strong>{props.item.author.username}</strong> · {new Date(props.item.createdAt * 1000).toLocaleString()}</div><p class="my-1 break-words">{props.item.message}</p>
      <Show when={props.canEdit || props.canDelete}><div class="flex gap-2"><Show when={props.canEdit}><button class="link tiny-link" onClick={props.onEdit}>Edit</button></Show><Show when={props.canDelete}><button class="link tiny-link" onClick={props.onDelete}>Delete</button></Show></div></Show>
    </div>
  </div>;
}
