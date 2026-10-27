import { For, Show, createEffect, createSignal } from "solid-js";
import type { BranchInfo } from "../types";
import { Modal } from "./Modal";
import { BranchesPanel } from "./BranchesPanel";
import { MergePanel } from "./MergePanel";
import { VersionHistoryPanel } from "./VersionHistoryPanel";

export function TimelineModal(props: {
  deckId: string;
  branch: string;
  branches: BranchInfo[];
  sessionId?: string;
  canManage: boolean;
  refreshKey?: number;
  onClose: () => void;
  onCheckpoint: () => Promise<void>;
  onRestore: (commitId: string, expectedHead: string) => Promise<void>;
  onSwitch: (branch: string) => Promise<void>;
  onCreate: (name: string, checkout: boolean, from: string) => Promise<void>;
  onDelete: (branch: string) => Promise<void>;
  onPrepareMerge: () => Promise<void>;
  onMerged: (summary: string) => Promise<void>;
}) {
  const tabs = ["Versions", "Branches", "Merge"] as const;
  const [tab, setTab] = createSignal<(typeof tabs)[number]>("Versions");
  const [operationBusy, setOperationBusy] = createSignal(false);
  const [panelBusy, setPanelBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [revision, setRevision] = createSignal(0);
  const [mergeBranch, setMergeBranch] = createSignal<string | null>(null);
  const busy = () => operationBusy() || panelBusy();
  const mergeAllowed = () => props.canManage && props.branches.length > 1;
  const close = () => { if (!busy()) props.onClose(); };

  async function operation(action: () => Promise<void>) {
    if (busy()) throw new Error("Wait for the current timeline action to finish.");
    setOperationBusy(true); setError(null);
    try { await action(); }
    finally { setOperationBusy(false); }
  }

  async function switchBranch(branch: string) {
    if (branch === props.branch) return;
    try {
      await operation(() => props.onSwitch(branch));
      setMergeBranch(null); setTab("Versions");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function selectTab(next: (typeof tabs)[number]) {
    if (busy() || tab() === next) return;
    setError(null);
    if (next !== "Merge") { setTab(next); return; }
    if (!mergeAllowed()) return;
    try {
      await operation(props.onPrepareMerge);
      setRevision((value) => value + 1);
      setMergeBranch(props.branch); setTab("Merge");
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  createEffect(() => { if (tab() === "Merge" && !mergeAllowed()) setTab("Branches"); });

  return <Modal class="history-modal timeline-workspace" bodyClass="history-modal-body" title="Timeline" subtitle="Browse saved versions, switch branches, and manage different directions for your deck." wide onClose={close} footer={<>
    <span class="muted small">Restoring a version saves a checkpoint of your current work first.</span>
    <button class="btn ghost" disabled={busy()} onClick={close}>Close</button>
  </>}>
    <div class="timeline-context">
      <label class="field"><span>Current branch</span><select aria-label="Timeline branch" value={props.branch} disabled={busy()} onChange={(event) => {
        const input = event.currentTarget;
        void switchBranch(input.value).catch(() => undefined).finally(() => { input.value = props.branch; });
      }}><For each={props.branches}>{(branch) => <option value={branch.name}>{branch.name}</option>}</For></select></label>
      <p class="muted small">Versions and merges below apply to this branch. Switching saves your pending edits.</p>
    </div>
    <nav class="build-tabs timeline-tabs" role="tablist" aria-label="Timeline tools" onKeyDown={(event) => {
      if (busy() || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const enabled = tabs.filter((item) => item !== "Merge" || mergeAllowed());
      const index = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (enabled.indexOf(tab()) + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
      const next = enabled[index];
      void selectTab(next).then(() => document.getElementById(`timeline-tab-${tab()}`)?.focus());
    }}>
      <For each={tabs}>{(item) => <button role="tab" id={`timeline-tab-${item}`} aria-controls={`timeline-panel-${item}`} aria-selected={tab() === item} tabIndex={tab() === item ? 0 : -1} class={`btn small ${tab() === item ? "accent" : "ghost"}`} disabled={busy() || item === "Merge" && !mergeAllowed()} title={item === "Merge" && !mergeAllowed() ? "Merge requires edit access and at least two branches" : undefined} onClick={() => void selectTab(item)}>{item}</button>}</For>
    </nav>
    <Show when={error()}><div class="history-notice error" role="alert">{error()}</div></Show>
    <div class="timeline-panels" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <div class="timeline-panel timeline-versions-panel" role="tabpanel" id="timeline-panel-Versions" aria-labelledby="timeline-tab-Versions" style={{ display: tab() === "Versions" ? "flex" : "none" }}>
        <Show when={props.branch} keyed>{(branch) => <VersionHistoryPanel deckId={props.deckId} branch={branch} canRestore={props.canManage} refreshKey={(props.refreshKey ?? 0) + revision()} onClose={close} onCheckpoint={props.onCheckpoint} onRestore={props.onRestore} onBusyChange={setPanelBusy} />}</Show>
      </div>
      <div class="timeline-panel timeline-branches-panel" role="tabpanel" id="timeline-panel-Branches" aria-labelledby="timeline-tab-Branches" style={{ display: tab() === "Branches" ? "block" : "none" }}>
        <BranchesPanel currentBranch={props.branch} branches={props.branches} canManage={props.canManage} disabled={busy()} onSwitch={switchBranch} onCreate={async (name, checkout, from) => {
          await operation(() => props.onCreate(name, checkout, from));
          setRevision((value) => value + 1); setMergeBranch(null);
        }} onDelete={async (name) => { await operation(() => props.onDelete(name)); }} />
      </div>
      <div class="timeline-panel timeline-merge-panel" role="tabpanel" id="timeline-panel-Merge" aria-labelledby="timeline-tab-Merge" style={{ display: tab() === "Merge" ? "block" : "none" }}>
        <Show when={tab() === "Merge" && mergeBranch() === props.branch && mergeAllowed()}>
          <MergePanel deckId={props.deckId} currentBranch={props.branch} sessionId={props.sessionId} branches={props.branches} onBusyChange={setPanelBusy} onMerged={async (summary) => {
            await props.onMerged(summary);
            setRevision((value) => value + 1); setMergeBranch(null); setTab("Versions");
          }} />
        </Show>
      </div>
    </div>
  </Modal>;
}
