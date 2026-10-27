import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { DeckList } from "./components/DeckList";
import { Editor } from "./components/Editor";
import type { DemoUser, ShareLinkPreview } from "./types";
import { activeDemoUserId, api, setActiveDemoUserId } from "./api";
import { deckHash, parseRoute, sameRoute, type Route } from "./routes";
import { SharedPresentation } from "./components/SharedPresentation";

export default function App() {
  const [route, setRoute] = createSignal<Route>(parseRoute());
  const [users, setUsers] = createSignal<DemoUser[]>([]);
  const [activeUser, setActiveUser] = createSignal<DemoUser | null>(null);
  const [identityLoading, setIdentityLoading] = createSignal(true);
  const [identityError, setIdentityError] = createSignal<string | null>(null);
  const [username, setUsername] = createSignal("");
  const [mode, setMode] = createSignal<"signup" | "signin">("signup");
  const [submitting, setSubmitting] = createSignal(false);
  const [invitation, setInvitation] = createSignal<ShareLinkPreview | null>(null);
  const [invitationError, setInvitationError] = createSignal("");

  createEffect(() => {
    const current = route();
    if (current.view !== "share" || activeUser()) { setInvitation(null); setInvitationError(""); return; }
    let cancelled = false;
    setInvitation(null); setInvitationError("");
    void api.shareLinkPreview(current.id, current.token).then((value) => { if (!cancelled) setInvitation(value); })
      .catch((error) => { if (!cancelled) setInvitationError(error instanceof Error ? error.message : String(error)); });
    onCleanup(() => { cancelled = true; });
  });

  onMount(() => {
    void api.demoUsers().then((nextUsers) => {
      setUsers(nextUsers);
      const savedId = activeDemoUserId();
      setActiveUser(nextUsers.find((user) => user.id === savedId) ?? null);
    }).catch((error) => setIdentityError(error instanceof Error ? error.message : String(error)))
      .finally(() => setIdentityLoading(false));
  });

  const authenticate = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = username().trim();
    if (!name) return;
    setSubmitting(true);
    setIdentityError(null);
    try {
      const user = mode() === "signup" ? await api.createDemoUser(name) : await api.signInDemoUser(name);
      setUsers((current) => current.some((candidate) => candidate.id === user.id) ? current : [...current, user]);
      setActiveDemoUserId(user.id);
      setActiveUser(user);
    } catch (error) {
      setIdentityError(error instanceof Error ? error.message : String(error));
    } finally { setSubmitting(false); }
  };

  const signOut = () => {
    setActiveDemoUserId(null);
    setActiveUser(null);
    setRoute({ view: "list" });
    window.location.hash = "#/";
  };
  onMount(() => {
    const onHash = () => {
      const next = parseRoute();
      setRoute((current) => sameRoute(current, next) ? current : next);
    };
    window.addEventListener("hashchange", onHash);
    onCleanup(() => window.removeEventListener("hashchange", onHash));
  });

  const open = (id: string, branch?: string) => {
    const next = { view: "editor" as const, id, branch };
    setRoute(next);
    window.location.hash = deckHash(id, branch);
  };
  const back = () => {
    setRoute({ view: "list" });
    window.location.hash = "#/";
  };

  return <Show when={!identityLoading()} fallback={<main class="identity-loading">Loading Present…</main>}>
    <Show when={activeUser()} fallback={<main class="auth-page">
      <div class="auth-art" aria-hidden="true">
        <div class="auth-orbit orbit-one" /><div class="auth-orbit orbit-two" />
        <div class="auth-presentation-card"><div class="auth-card-sun" /><div class="auth-card-line wide" /><div class="auth-card-line" /><div class="auth-card-block" /></div>
        <span class="auth-spark spark-one">✦</span><span class="auth-spark spark-two">✳</span><span class="auth-spark spark-three">✦</span>
      </div>
      <section class="auth-content">
        <div class="auth-brand"><span class="brand-mark">P</span><span>Present</span></div>
        <p class="auth-eyebrow">A little room for big ideas</p>
        <h1 classList={{ "auth-tagline": mode() === "signup" }}>{mode() === "signup" ? "Collaborative slides so painless its a gift; Present." : "Welcome back."}</h1>
        <p class="auth-copy">Create warm, thoughtful presentations and invite your people to build them with you.</p>
        <Show when={route().view === "share"}><div class="share-invitation-banner">
          <strong>{invitation()?.title ?? "Shared presentation"}</strong>
          <p>{invitation() ? `${invitation()!.owner.username} shared ${invitation()!.branch} with ${invitation()!.role} access.` : "You opened a presentation sharing link."} Sign in or create an account to continue.</p>
          <Show when={invitationError()}><p class="demo-user-error">{invitationError()}</p></Show>
        </div></Show>
        <form class="auth-form" onSubmit={authenticate}>
          <label class="field"><span>Username</span><input autocomplete="username" maxlength="32" minlength="1" pattern="[A-Za-z0-9_-]+" placeholder="yourname" value={username()} onInput={(event) => setUsername(event.currentTarget.value)} required /></label>
          <p class="auth-demo-note">Demo sign-in is remembered in this browser and does not use a password.</p>
          <Show when={identityError()}><p class="demo-user-error">{identityError()}</p></Show>
          <button class="btn accent auth-submit" type="submit" disabled={submitting()}>{submitting() ? "One moment…" : mode() === "signup" ? "Create your account" : "Sign in"}</button>
        </form>
        <p class="auth-toggle">{mode() === "signup" ? "Already have an account?" : "New to Present?"} <button class="link" onClick={() => { setMode(mode() === "signup" ? "signin" : "signup"); setIdentityError(null); }}>{mode() === "signup" ? "Sign in" : "Create an account"}</button></p>
        <p class="auth-footnote">This demo identity is not secure authentication. Use Present on a trusted network.</p>
      </section>
    </main>}>
      {(user) => <Show when={route()} keyed>{(current) =>
        current.view === "editor"
          ? <Editor deckId={current.id} initialBranch={current.branch} onBack={back} activeDemoUser={user()} onSignOut={signOut} />
          : current.view === "share" ? <SharedPresentation deckId={current.id} token={current.token} user={user()} onOpen={open} onBack={back} />
          : <DeckList onOpen={open} activeDemoUser={user()} onSignOut={signOut} />
      }</Show>}
    </Show>
  </Show>;
}
