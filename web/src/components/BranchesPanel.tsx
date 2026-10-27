import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { BranchInfo } from "../types";
import { formatTime } from "../api";

export function BranchesPanel(props: {
  currentBranch: string;
  branches: BranchInfo[];
  canManage: boolean;
  disabled: boolean;
  onSwitch: (name: string) => Promise<void>;
  onCreate: (name: string, checkout: boolean, from: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [name, setName] = createSignal("");
  const [checkout, setCheckout] = createSignal(true);
  const [base, setBase] = createSignal(props.currentBranch);
  const [working, setWorking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);
  const busy = () => props.disabled || working();
  createEffect(on(() => props.currentBranch, (branch) => { setBase(branch); setPendingDelete(null); }, { defer: true }));

  const perform = async (action: () => Promise<void>, done: string) => {
    if (busy()) return;
    setWorking(true); setError(null); setSuccess(null);
    try { await action(); setSuccess(done); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  };
  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = name().trim().replace(/\s+/g, "-");
    if (!value) { setError("Branch name is required."); return; }
    if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) { setError("Use letters, numbers, '.', '_', '-' or '/'."); return; }
    if (props.branches.some((branch) => branch.name === value)) { setError("A branch with this name already exists."); return; }
    await perform(async () => { await props.onCreate(value, checkout(), base()); setName(""); }, `Created ${value}.`);
  };

  return <section class="timeline-branches">
    <p class="muted small">A branch is an alternate version of your deck. Switch branches to work on a different direction.</p>
    <Show when={error()}><div class="history-notice error" role="alert">{error()}</div></Show>
    <Show when={success()}><div class="history-notice" role="status">{success()}</div></Show>
    <Show when={props.canManage}><form class="timeline-branch-create" onSubmit={create}>
      <h3>Create a branch</h3>
      <div class="field-grid">
        <label class="field"><span>Start from</span><select aria-label="New branch starting point" value={base()} disabled={busy()} onChange={(event) => setBase(event.currentTarget.value)}><For each={props.branches}>{(branch) => <option value={branch.name}>{branch.name}</option>}</For></select></label>
        <label class="field"><span>Branch name</span><input aria-label="New branch name" placeholder="feature/new-title" value={name()} disabled={busy()} onInput={(event) => setName(event.currentTarget.value)} /></label>
      </div>
      <div class="timeline-branch-create-actions"><label class="checkbox-row"><input type="checkbox" checked={checkout()} disabled={busy()} onChange={(event) => setCheckout(event.currentTarget.checked)} />Switch to the new branch</label><button class="btn accent" type="submit" disabled={busy()}>{working() ? "Working…" : "Create branch"}</button></div>
    </form></Show>
    <div class="timeline-branch-list"><For each={props.branches}>{(branch) => <article class={`timeline-branch-row ${branch.name === props.currentBranch ? "current" : ""}`}>
      <div><strong>{branch.name}</strong><Show when={branch.name === props.currentBranch}><span class="timeline-current-badge">Current</span></Show><p class="muted small">{branch.summary || "No saved versions"}{branch.time ? ` · ${formatTime(branch.time)}` : ""}</p></div>
      <div class="row-gap"><button class="btn ghost small" aria-label={`Switch to branch ${branch.name}`} disabled={busy() || branch.name === props.currentBranch} onClick={() => void perform(() => props.onSwitch(branch.name), `Switched to ${branch.name}.`)}>Switch</button>
        <Show when={props.canManage}><button class="btn ghost danger small" aria-label={`Delete branch ${branch.name}`} title={branch.name === "main" ? "The main branch is protected" : branch.name === props.currentBranch ? "Switch to another branch before deleting this one" : "Delete this branch"} disabled={busy() || branch.name === "main" || branch.name === props.currentBranch} onClick={() => { setPendingDelete(branch.name); setError(null); }}>Delete</button></Show>
      </div>
    </article>}</For></div>
    <Show when={pendingDelete()}>{(branch) => <div class="history-restore-confirm" role="alert">
      <div><strong>Delete branch “{branch()}”?</strong><p>This removes its entry from the branch list. Keep the branch if you still need its separate history.</p></div>
      <div class="row-gap"><button class="btn ghost small" disabled={busy()} onClick={() => setPendingDelete(null)}>Cancel</button><button class="btn danger small" disabled={busy()} onClick={() => void perform(async () => {
        const value = branch();
        if (value === "main" || value === props.currentBranch) throw new Error("Switch to another branch before deleting this one.");
        await props.onDelete(value); setPendingDelete(null);
      }, `Deleted ${branch()}.`)}>Confirm delete</button></div>
    </div>}</Show>
  </section>;
}
