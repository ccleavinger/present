import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { api } from "../../src/api";
import { TimelineModal } from "../../src/components/TimelineModal";
import type { BranchInfo, CommitInfo, CommitSnapshot } from "../../src/types";

const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => unknown, message: string) {
  for (let attempt = 0; attempt < 150; attempt++) { if (predicate()) return; await wait(20); }
  throw new Error(message);
}
const commit = (id: string, summary: string): CommitInfo => ({ id, summary, author: "Sam", time: 1, committed: true });
const branchInfo = (name: string): BranchInfo => ({ name, isCurrent: name === "main", commitId: `${name}-head`, summary: `${name} latest`, time: 1 });

async function verify() {
  const [branch, setBranch] = createSignal("main");
  const [branches, setBranches] = createSignal([branchInfo("main"), branchInfo("feature")]);
  const versions: Record<string, CommitInfo[]> = {
    main: [commit("main-head", "Main latest"), commit("shared", "Shared base")],
    feature: [commit("feature-head", "Feature latest"), commit("shared", "Shared base")],
  };
  const manifest = { version: 1, title: "Demo", width: 1920, height: 1080, slides: ["slide"], tokens: {} };
  const snapshot = (name: string, id: string): CommitSnapshot => ({
    commit: versions[name].find((item) => item.id === id)!, deck: manifest,
    slides: [{ version: 1, id: "slide", name: `${name}: ${id}`, background: "white", elements: {} }], notes: {},
  });
  const historyBranches: string[] = [], deleted: string[] = [], restores: string[] = [];
  let releaseOldPreview: (() => void) | undefined, checkpointCount = 0, prepareCount = 0, merged = false, closed = false, failSwitch = false;
  Object.assign(api, {
    history: async (_deck: string, name: string) => { historyBranches.push(name); return { commits: [...versions[name]], nextCursor: null }; },
    commitSnapshot: async (_deck: string, name: string, id: string) => {
      if (name === "main" && id === "shared" && !releaseOldPreview) return await new Promise<CommitSnapshot>((resolve) => { releaseOldPreview = () => resolve(snapshot(name, id)); });
      return snapshot(name, id);
    },
    mergePreview: async (_deck: string, source: string, target: string) => {
      check(prepareCount > 0, "merge preview was requested before pending edits were checkpointed");
      return { source, target, oursCommit: "ours", theirsCommit: "theirs", baseCommit: "shared", conflictCount: 0, changedCount: 1, deck: { status: "modified", ours: manifest, theirs: manifest, merged: manifest, conflicts: [] }, slides: [], notes: [] };
    },
    applyMerge: async (_deck: string, source: string) => {
      check(branch() === "main" && source === "feature", "merge used the wrong branch context");
      await wait(40); merged = true;
      return commit("merge-result", "Merged feature");
    },
  });
  const stage = document.getElementById("stage")!;
  const switchBranch = async (name: string) => {
    if (failSwitch) throw new Error("Branch access denied");
    await wait(40); setBranch(name);
  };
  const dispose = render(() => <TimelineModal deckId="deck" branch={branch()} branches={branches()} canManage={true} sessionId="session" onClose={() => { closed = true; }} onSwitch={switchBranch}
    onCreate={async (name, checkout, from) => {
      check(from === branch(), "new branch did not default to the active branch");
      await wait(40); versions[name] = [...versions[from]];
      setBranches((current) => [...current, branchInfo(name)]);
      if (checkout) setBranch(name);
    }} onDelete={async (name) => { await wait(40); deleted.push(name); setBranches((current) => current.filter((item) => item.name !== name)); }}
    onCheckpoint={async () => { await wait(40); checkpointCount++; versions[branch()].unshift(commit("checkpoint", "Saved checkpoint")); }}
    onRestore={async (id, head) => { check(head === versions[branch()][0].id, "restore did not protect against a stale head"); await wait(40); restores.push(`${branch()}:${id}`); versions[branch()].unshift(commit("restored", "Restored version")); }}
    onPrepareMerge={async () => { await wait(40); prepareCount++; }}
    onMerged={async (summary) => { versions[branch()].unshift(commit("merge-result", summary)); }} />, stage);
  const tab = (name: string) => document.getElementById(`timeline-tab-${name}`) as HTMLButtonElement;
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text)!;
  const selector = () => document.querySelector<HTMLSelectElement>('[aria-label="Timeline branch"]')!;
  const previewName = () => document.querySelector(".history-slide-controls")?.textContent;
  await until(() => previewName()?.includes("main: main-head"), "Timeline did not load history for the active branch");
  check(document.querySelectorAll('[aria-modal="true"]').length === 1, "Timeline opened nested modals");

  document.querySelector<HTMLButtonElement>('[data-commit="shared"]')!.click();
  await until(() => releaseOldPreview, "older-version preview was not requested");
  selector().value = "feature"; selector().dispatchEvent(new Event("change", { bubbles: true }));
  check(selector().disabled && tab("Branches").disabled, "branch controls remained active while switching");
  await until(() => previewName()?.includes("feature: feature-head"), "branch switch did not reset to the selected branch's latest history");
  releaseOldPreview!(); await wait(20);
  check(previewName()?.includes("feature: feature-head") && !document.querySelector('[data-commit="main-head"]'), "a late preview from another branch overwrote the active history");

  button("Create checkpoint").click();
  check(selector().disabled && tab("Branches").disabled, "branch switching was possible during checkpoint creation");
  await until(() => checkpointCount === 1 && document.querySelector('[data-commit="checkpoint"]'), "checkpoint was not added to the visible timeline");
  document.querySelector<HTMLButtonElement>('[data-commit="shared"]')!.click();
  await until(() => previewName()?.includes("feature: shared"), "selected version preview did not load");
  button("Restore this version").click();
  check(!!button("Confirm restore"), "restoring a version skipped confirmation");
  button("Confirm restore").click();
  check(selector().disabled, "branch switching was allowed while restoring");
  await until(() => restores[0] === "feature:shared" && document.querySelector('[data-commit="restored"]'), "restore did not refresh the selected branch history");

  tab("Branches").click();
  const name = document.querySelector<HTMLInputElement>('[aria-label="New branch name"]')!;
  name.value = "experiment/new-layout"; name.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector(".timeline-branch-create")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await until(() => branch() === "experiment/new-layout" && !selector().disabled, "new branch was not created and checked out");
  check(tab("Branches").getAttribute("aria-selected") === "true" && name.value === "" && selector().value === branch(), "creating a branch closed the workspace or left stale branch controls");
  name.value = "discard-me"; name.dispatchEvent(new Event("input", { bubbles: true }));
  const checkout = document.querySelector<HTMLInputElement>('.timeline-branch-create input[type="checkbox"]')!;
  checkout.checked = false; checkout.dispatchEvent(new Event("change", { bubbles: true }));
  document.querySelector(".timeline-branch-create")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await until(() => branches().some((item) => item.name === "discard-me") && !selector().disabled, "branch could not be created without switching");
  check(branch() === "experiment/new-layout", "unchecked switch option still changed branches");
  check(document.querySelector<HTMLButtonElement>('[aria-label="Delete branch main"]')!.disabled && document.querySelector<HTMLButtonElement>('[aria-label="Delete branch experiment/new-layout"]')!.disabled, "main or the active branch could be deleted");
  document.querySelector<HTMLButtonElement>('[aria-label="Delete branch discard-me"]')!.click();
  check(deleted.length === 0, "branch was deleted before confirmation");
  button("Confirm delete").click();
  await until(() => deleted.includes("discard-me") && !document.querySelector('[aria-label="Delete branch discard-me"]'), "confirmed branch deletion did not update the list");
  document.querySelector<HTMLButtonElement>('[aria-label="Switch to branch main"]')!.click();
  await until(() => branch() === "main" && tab("Versions").getAttribute("aria-selected") === "true" && previewName()?.includes("main: main-head"), "switching from branch management did not open the branch's history");

  tab("Merge").click();
  check(selector().disabled, "merge preparation did not lock the branch context");
  await until(() => button("Merge cleanly") && !button("Merge cleanly").disabled, "merge preview was not accessible inside Timeline");
  check(document.querySelectorAll('[aria-modal="true"]').length === 1 && prepareCount === 1, "merge opened a second modal or skipped preparation");
  button("Merge cleanly").click();
  check(selector().disabled && tab("Branches").disabled, "branch controls remained active during merge application");
  await until(() => merged && tab("Versions").getAttribute("aria-selected") === "true" && document.querySelector('[data-commit="merge-result"]'), "merge did not return to the refreshed version timeline");

  failSwitch = true; selector().value = "feature"; selector().dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes("Branch access denied"), "failed branch switch did not show an error");
  await wait(20);
  check(selector().value === "main" && branch() === "main", "failed branch switch left the dropdown on a branch that was not opened");
  button("Close").click(); check(closed, "Timeline did not close"); dispose();

  const disposeReadOnly = render(() => <TimelineModal deckId="deck" branch="main" branches={branches()} canManage={false} onClose={() => {}} onSwitch={async () => {}} onCreate={async () => {}} onDelete={async () => {}} onCheckpoint={async () => {}} onRestore={async () => {}} onPrepareMerge={async () => {}} onMerged={async () => {}} />, stage);
  await until(() => previewName()?.includes("main: merge-result"), "read-only timeline could not preview history");
  check(tab("Merge").disabled && !button("Create checkpoint") && !button("Restore this version"), "read-only timeline exposed version editing actions");
  tab("Branches").click();
  check(!document.querySelector(".timeline-branch-create") && !document.querySelector('[aria-label^="Delete branch"]'), "read-only branch management exposed create or delete actions");
  check(historyBranches.includes("main") && historyBranches.includes("feature"), "history requests did not follow branch selection");
  disposeReadOnly();
}

verify().then(() => { document.getElementById("result")!.textContent = "PASS: unified timeline workspace"; })
  .catch((error) => { document.getElementById("result")!.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`; });
