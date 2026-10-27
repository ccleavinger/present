import { For, Show, createSignal, createEffect, on, onCleanup, onMount } from "solid-js";
import type { BranchInfo, DeckCollaboration, DeckRole, ShareLink } from "../types";
import { api } from "../api";
import { Modal } from "./Modal";
import { shareLinkUrl } from "../routes";

export function CollaborationModal(props: { deckId: string; activeBranch: string; currentUserId: string; refreshKey?: number; onClose: () => void }) {
  const [collaboration, setCollaboration] = createSignal<DeckCollaboration | null>(null);
  const [branches, setBranches] = createSignal<BranchInfo[]>([]);
  const [username, setUsername] = createSignal("");
  const [branch, setBranch] = createSignal(props.activeBranch);
  const [role, setRole] = createSignal<DeckRole>("edit");
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [links, setLinks] = createSignal<ShareLink[]>([]);
  const [linkRole, setLinkRole] = createSignal<DeckRole>("view");
  const [linkBranch, setLinkBranch] = createSignal(props.activeBranch);
  const [creatingLink, setCreatingLink] = createSignal(false);
  const [revoking, setRevoking] = createSignal<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal("");
  let request = 0;
  onCleanup(() => { request += 1; });
  const isOwner = () => collaboration()?.owner.id === props.currentUserId;
  const refresh = async () => {
    const current = ++request;
    try {
      const [access, available] = await Promise.all([api.collaboration(props.deckId), api.branches(props.deckId)]);
      const shared = access.owner.id === props.currentUserId ? await api.shareLinks(props.deckId) : [];
      if (current !== request) return;
      setCollaboration(access); setBranches(available); setLinks(shared);
    }
    catch (err) { if (current === request) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (current === request) setLoading(false); }
  };
  onMount(() => { void refresh(); });
  createEffect(on(() => props.refreshKey, () => void refresh(), { defer: true }));
  const invite = async (event: SubmitEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try { setCollaboration(await api.setCollaborator(props.deckId, username().trim(), branch(), role())); setUsername(""); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  const remove = async (name: string, branchName: string) => {
    try { setCollaboration(await api.removeCollaborator(props.deckId, name, branchName)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const createLink = async (event: SubmitEvent) => {
    event.preventDefault(); setCreatingLink(true); setError(""); setNotice("");
    try {
      const link = await api.createShareLink(props.deckId, linkBranch(), linkRole());
      setLinks((current) => [link, ...current.filter((item) => item.id !== link.id)]);
      setNotice("Sharing link is ready. Copy it and send it to your collaborators.");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setCreatingLink(false); }
  };
  const revokeLink = async (id: string) => {
    setRevoking(id); setError(""); setNotice("");
    try {
      await api.revokeShareLink(props.deckId, id);
      setLinks((current) => current.filter((link) => link.id !== id)); setConfirmRevoke(null);
      setCollaboration(await api.collaboration(props.deckId));
      setNotice("Link revoked. Access granted only by that link has been removed.");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setRevoking(null); }
  };
  const copyLink = async (link: ShareLink) => {
    setError(""); setNotice("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(shareLinkUrl(props.deckId, link.token));
      setNotice("Link copied.");
    } catch {
      const input = document.getElementById(`share-url-${link.id}`) as HTMLInputElement | null;
      input?.focus(); input?.select();
      if (document.execCommand("copy")) setNotice("Link copied.");
      else setNotice("Select the link and copy it with Ctrl/Cmd+C.");
    }
  };
  const owner = () => collaboration()?.owner;
  const allMembers = () => collaboration()?.members.flatMap((member) => Object.entries(member.branches).map(([name, access]) => ({ user: member.user, branch: name, role: access }))) ?? [];

  return <Modal title="Share presentation" subtitle="Share a link or invite people to a branch." wide onClose={props.onClose}>
    <Show when={!loading() && isOwner()}><section class="share-link-section">
      <h3>Share by link</h3><p class="muted small">Anyone with a link can sign in or create an account to join with its chosen permission.</p>
      <form class="share-link-form" onSubmit={createLink}>
        <label class="field"><span>Branch</span><select aria-label="Share link branch" value={linkBranch()} disabled={creatingLink()} onChange={(event) => setLinkBranch(event.currentTarget.value)}><For each={branches()}>{(item) => <option value={item.name}>{item.name}</option>}</For></select></label>
        <label class="field"><span>Permission</span><select aria-label="Share link permission" value={linkRole()} disabled={creatingLink()} onChange={(event) => setLinkRole(event.currentTarget.value as DeckRole)}><option value="view">Can view</option><option value="comment">Can comment</option><option value="edit">Can edit</option></select></label>
        <button class="btn accent" disabled={creatingLink() || !!revoking()}>{creatingLink() ? "Creating…" : "Create link"}</button>
      </form>
      <div class="share-link-list"><For each={links()}>{(link) => <article class="share-link-card">
        <div class="share-link-meta"><strong>{link.branch}</strong><span class={`permission-chip role-${link.role}`}>{link.role === "edit" ? "Can edit" : link.role === "comment" ? "Can comment" : "Can view"}</span><span class="muted small">{link.joinedCount} joined</span></div>
        <div class="share-link-copy"><input id={`share-url-${link.id}`} aria-label={`Sharing link for ${link.branch}`} readonly value={shareLinkUrl(props.deckId, link.token)} onFocus={(event) => event.currentTarget.select()} /><button class="btn small" type="button" onClick={() => void copyLink(link)}>Copy link</button><button class="btn ghost danger small" type="button" disabled={!!revoking()} onClick={() => setConfirmRevoke(link.id)}>Revoke</button></div>
        <Show when={confirmRevoke() === link.id}><div class="share-revoke-confirm"><p>Revoke this link and remove access granted only through it? Direct invitations stay active.</p><div class="row-gap"><button class="btn ghost small" disabled={!!revoking()} onClick={() => setConfirmRevoke(null)}>Cancel</button><button class="btn danger small" disabled={!!revoking()} onClick={() => void revokeLink(link.id)}>{revoking() === link.id ? "Revoking…" : "Confirm revoke"}</button></div></div></Show>
      </article>}</For></div>
    </section></Show>
    <Show when={notice()}><p class="share-notice" role="status">{notice()}</p></Show>
    <h3 class="share-people-heading">People with access</h3>
    <div class="collaboration-members">
      <div class="collaboration-member"><span><strong>{owner()?.username ?? "…"}</strong> · presentation owner</span><span class="permission-chip role-edit">Owner</span></div>
      <For each={allMembers()}>{(member) => <div class="collaboration-member"><span><strong>{member.user.username}</strong><small> · {member.branch}</small></span><span class="flex items-center gap-2"><span class={`permission-chip role-${member.role}`}>{member.role}</span><Show when={isOwner()}><button class="icon-btn danger" aria-label={`Remove ${member.user.username} from ${member.branch}`} onClick={() => void remove(member.user.username, member.branch)}>×</button></Show></span></div>}</For>
      <Show when={allMembers().length === 0}><p class="text-sm text-cocoa-500">No collaborators yet. Create a share link or invite someone below.</p></Show>
    </div>
    <Show when={isOwner()}>
      <h3 class="share-people-heading">Invite by username</h3>
      <form class="collaborator-modal-form mt-5" onSubmit={invite}>
        <label class="field"><span>Username</span><input value={username()} onInput={(event) => setUsername(event.currentTarget.value)} placeholder="teammate" required /></label>
        <label class="field"><span>Branch</span><select value={branch()} onChange={(event) => setBranch(event.currentTarget.value)}><For each={branches()}>{(item) => <option value={item.name}>{item.name}</option>}</For></select></label>
        <label class="field"><span>Permission</span><select value={role()} onChange={(event) => setRole(event.currentTarget.value as DeckRole)}><option value="view">Can view</option><option value="comment">Can comment</option><option value="edit">Can edit</option></select></label>
        <button class="btn accent" disabled={saving() || loading()}>{saving() ? "Adding…" : "Add person"}</button>
      </form>
    </Show>
    <Show when={error()}><p class="demo-user-error mt-3">{error()}</p></Show>
  </Modal>;
}
