import { render } from "solid-js/web";
import App from "../../src/App";
import { api, setActiveDemoUserId } from "../../src/api";
import { shareLinkUrl } from "../../src/routes";
import { CollaborationModal } from "../../src/components/CollaborationModal";
import type { DemoUser, ShareLink } from "../../src/types";

const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => unknown, message: string) {
  for (let attempt = 0; attempt < 150; attempt++) { if (predicate()) return; await wait(20); }
  throw new Error(message);
}
const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);

async function verify() {
  const owner = { id: "owner", username: "owner", displayName: "Owner" };
  const recipient = { id: "recipient", username: "recipient", displayName: "Recipient" };
  const token = "a".repeat(32), invitedBranch = "feature/slides";
  const preview = { deckId: "shared", title: "Team roadmap", branch: invitedBranch, role: "edit" as const, owner };
  let links: ShareLink[] = [], copied = "", listed = 0, revoked = false, joined = false, joins = 0, requestedBranch = "";
  const users: DemoUser[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  Object.assign(api, {
    collaboration: async () => ({ owner, members: joined ? [{ user: recipient, branches: { [invitedBranch]: "edit" } }] : [] }),
    branches: async () => ["main", invitedBranch].map((name) => ({ name, isCurrent: name === "main", commitId: "head", summary: "Initial", time: 1 })),
    shareLinks: async () => { listed++; return [...links]; },
    createShareLink: async (_deck: string, branch: string, role: ShareLink["role"]) => {
      check(branch === invitedBranch && role === "edit", "selected share-link permission or branch was not sent");
      const link = { id: "link_one", token, branch, role, createdAt: 1, joinedCount: 0 }; links.push(link); return link;
    },
    revokeShareLink: async (_deck: string, id: string) => { check(id === "link_one", "wrong share link was revoked"); revoked = true; links = []; },
    shareLinkPreview: async () => { if (revoked) throw new Error("This sharing link is invalid or has been revoked."); return preview; },
    joinShareLink: async () => { check(!revoked, "revoked link was joined"); joins++; joined = true; return preview; },
  });
  const stage = document.getElementById("stage")!;
  const disposeOwner = render(() => <CollaborationModal deckId="shared" activeBranch="main" currentUserId={owner.id} onClose={() => {}} />, stage);
  await until(() => document.querySelector('[aria-label="Share link permission"]'), "owner could not manage share links");
  check(document.querySelector<HTMLSelectElement>('[aria-label="Share link permission"]')!.value === "view", "new links should default to view access");
  const branch = document.querySelector<HTMLSelectElement>('[aria-label="Share link branch"]')!;
  branch.value = invitedBranch; branch.dispatchEvent(new Event("change", { bubbles: true }));
  const role = document.querySelector<HTMLSelectElement>('[aria-label="Share link permission"]')!;
  role.value = "edit"; role.dispatchEvent(new Event("change", { bubbles: true }));
  document.querySelector(".share-link-form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await until(() => document.querySelector(".share-link-card"), "share link was not displayed after creation");
  const field = document.querySelector<HTMLInputElement>('.share-link-copy input')!;
  check(field.value === shareLinkUrl("shared", token), "sharing link did not point at the invitation route");
  button("Copy link")!.click(); await until(() => copied === field.value, "Copy link did not use the system clipboard");
  button("Revoke")!.click(); check(!revoked, "link was revoked without confirmation");
  button("Confirm revoke")!.click(); await until(() => revoked && !document.querySelector(".share-link-card"), "revoking a link did not update the UI");
  disposeOwner();

  const previousLists = listed;
  const disposeMember = render(() => <CollaborationModal deckId="shared" activeBranch={invitedBranch} currentUserId={recipient.id} onClose={() => {}} />, stage);
  await until(() => document.querySelector(".collaboration-member strong")?.textContent === "owner", "member list failed to load");
  check(!document.querySelector(".share-link-section") && listed === previousLists && !button("Create link"), "non-owner could list or create sharing tokens");
  disposeMember();

  revoked = false; setActiveDemoUserId(null);
  window.location.hash = `#/share/shared/${token}`; await wait(20);
  const slide = { version: 1, id: "slide", name: "Shared slide", background: "white", elements: {} };
  Object.assign(api, {
    demoUsers: async () => [...users],
    createDemoUser: async (name: string) => { check(name === "recipient", "invitation sign-up used the wrong account"); users.push(recipient); return recipient; },
    createSession: async (_deck: string, branch?: string) => { requestedBranch = branch ?? ""; check(joined && branch === invitedBranch, "editor session opened before joining or on the wrong branch"); return { id: "shared_session", deckId: "shared", branch: invitedBranch, openedAt: 1 }; },
    getDeck: async () => { check(joined, "private deck was opened before joining the invitation"); return { id: "shared", deck: { version: 1, title: "Team roadmap", width: 1920, height: 1080, slides: ["slide"], tokens: {} }, currentBranch: invitedBranch, branches: [{ name: invitedBranch, isCurrent: true, commitId: "head", summary: "Initial", time: 1 }], slides: [{ id: "slide", name: "Shared slide", background: "white", index: 0, elementCount: 0 }], dirty: false }; },
    getSlide: async () => ({ slide, notes: "", assets: [] }),
    deckTemplateBundle: async () => null, slideTemplates: async () => [],
    connectPresence: () => Object.assign(new EventTarget(), { readyState: 0, bufferedAmount: 0, send() {}, close() {} }),
    closeSession: async () => null,
  });
  const disposeApp = render(() => <App />, stage);
  await until(() => document.querySelector(".auth-form") && document.querySelector(".share-invitation-banner")?.textContent?.includes("Team roadmap"), "signed-out invitation did not show context and account entry");
  const username = document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
  username.value = "recipient"; username.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector(".auth-form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await until(() => document.querySelector(".share-entry-card h1")?.textContent === "Team roadmap", "sign-up lost the invitation route");
  check(window.location.hash.includes("#/share/") && joins === 0, "recipient was joined without opening the invitation");
  button("Open presentation")!.click();
  await until(() => document.querySelector(".editor") && requestedBranch === invitedBranch, "share link did not open the invited branch in the editor");
  check(joins === 1 && new URLSearchParams(window.location.hash.split("?")[1]).get("branch") === invitedBranch, "share route did not retain branch context after joining");
  disposeApp();

  revoked = true; window.location.hash = `#/share/shared/${token}`; await wait(20);
  const disposeRevoked = render(() => <App />, stage);
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes("revoked"), "revoked invitation did not show an actionable error");
  check(!button("Open presentation") && joins === 1, "revoked link still allowed joining");
  disposeRevoked(); setActiveDemoUserId(null);
}

verify().then(() => { document.getElementById("result")!.textContent = "PASS: share links and invitation routing"; })
  .catch((error) => { document.getElementById("result")!.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`; });
