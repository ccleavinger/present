import { For, Show, createSignal, onCleanup } from "solid-js";
import type { CustomObjectDefinition, Slide } from "../types";
import { api } from "../api";
import { StaticSlide } from "./ElementView";
import ScriptWorker from "../worker/scriptWorker?worker";

interface AgentPanelProps {
  deckId: string;
  deckTitle: string;
  currentSlide: Slide;
  deckSlides: Slide[];
  sessionId?: string;
  customObjectTypes: CustomObjectDefinition[];
  onApply: (slides: Slide[], request: string) => Promise<void>;
}

interface AgentProposal {
  slides: Slide[];
  logs: string[];
  model: string;
}

function runInSandbox(source: string, customObjectTypes: CustomObjectDefinition[], signal: AbortSignal): Promise<{ slides: Slide[]; logs: string[] }> {
  return new Promise((resolve, reject) => {
    const worker = new ScriptWorker();
    const id = crypto.randomUUID();
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The generated script exceeded the 10 second limit."));
    }, 10_000);
    const abort = () => { cleanup(); reject(new DOMException("Build closed", "AbortError")); };
    const cleanup = () => { window.clearTimeout(timeout); signal.removeEventListener("abort", abort); worker.terminate(); };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      cleanup();
      if (event.data.type === "error") {
        reject(new Error(event.data.error ?? "The generated script could not run."));
        return;
      }
      const slides = event.data.generated?.initialSlides;
      if (!Array.isArray(slides) || slides.length === 0) {
        reject(new Error("The agent script returned no slides to review."));
        return;
      }
      resolve({ slides, logs: event.data.logs ?? [] });
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "The generated script worker failed."));
    };
    worker.postMessage({ id, mode: "generate-template", source, customObjectTypes });
  });
}

export function AgentPanel(props: AgentPanelProps) {
  const [request, setRequest] = createSignal("");
  const [feedback, setFeedback] = createSignal("");
  const [proposal, setProposal] = createSignal<AgentProposal | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());

  const generate = async () => {
    const task = request().trim();
    if (!task) { setError("Describe what you want the agent to create."); return; }
    setBusy(true); setError(null); setProposal(null);
    let retryNote = feedback().trim();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const generated = await api.generateAgentScript(props.deckId, {
          request: task,
          feedback: retryNote,
          slides: props.deckSlides.map((slide) => ({
            ...slide,
            elements: Object.fromEntries(Object.values(slide.elements).slice(0, 30).map((element) => [element.id, {
              id: element.id, type: element.type, x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation, z: element.z,
              text: element.text?.slice(0, 160), fill: element.fill, shapeParams: element.shapeParams,
              style: { fontSize: element.style.fontSize, fontWeight: element.style.fontWeight, color: element.style.color },
            }])),
          })),
          deckTitle: props.deckTitle,
        }, props.sessionId);
        if (lifetime.signal.aborted) return;
        try {
          const output = await runInSandbox(generated.script, props.customObjectTypes, lifetime.signal);
          if (attempt === 0) {
            const summary = output.slides.map((slide) => ({
              name: slide.name,
              background: slide.background,
              elements: Object.values(slide.elements).map((element) => ({ type: element.type, x: element.x, y: element.y, w: element.w, h: element.h, text: element.text?.slice(0, 240), fill: element.fill, style: element.style })),
            }));
            retryNote = `${retryNote}\nReview your generated output against the user request. Improve it if the layout, content, or visual hierarchy can be clearer. Return a complete replacement generator script. Generated output to inspect: ${JSON.stringify(summary).slice(0, 24_000)}`.trim();
            continue;
          }
          setProposal({ ...output, model: generated.model });
          setBusy(false);
          return;
        } catch (reason) {
          if (lifetime.signal.aborted) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          if (attempt === 2) throw reason;
          retryNote = `${retryNote}\nThe previous generated script failed validation: ${message}. Return a corrected complete script.`.trim();
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const value = proposal();
    if (!value) return;
    setBusy(true); setError(null);
    try { await props.onApply(value.slides, request().trim()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); }
  };

  const objectKinds = (slide: Slide) => {
    const counts = new Map<string, number>();
    Object.values(slide.elements).forEach((element) => counts.set(element.type, (counts.get(element.type) ?? 0) + 1));
    return [...counts].map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`).join(" · ");
  };

  return <div class="agent-build-panel">
    <div class="agent-request-row">
      <label for="agent-request">What should the agent make?</label>
      <p class="agent-context">Starting from <strong>{props.currentSlide.name}</strong></p>
      <textarea id="agent-request" rows={3} value={request()} onInput={(event) => setRequest(event.currentTarget.value)} placeholder="For example: turn this idea into a concise opening and a clear takeaway." />
      <div class="agent-request-actions"><span class="muted small">The agent runs generated scripts in an isolated worker.</span><button class="btn" disabled={busy()} onClick={() => void generate()}>{busy() ? "Working…" : proposal() ? "Regenerate preview" : "Preview draft"}</button></div>
    </div>
    <Show when={proposal()}>{(value) => <section class="agent-review">
      <div class="agent-review-heading"><div><h3>Review at a glance</h3><p class="muted small">{value().slides.length} new slides · {value().slides.reduce((total, item) => total + Object.keys(item.elements).length, 0)} objects</p></div><span class="agent-draft-badge">Draft · {value().model}</span></div>
      <div class="agent-slide-grid"><For each={value().slides}>{(item, index) => <article class="agent-slide-card">
        <div class="agent-slide-thumb"><StaticSlide slide={item} /></div>
        <div class="agent-slide-meta"><strong>{index() + 1}. {item.name}</strong><span>{objectKinds(item)}</span></div>
      </article>}</For></div>
      <Show when={value().logs.length > 0}><details class="agent-feedback"><summary>Agent script notes</summary><ul class="agent-log-list"><For each={value().logs}>{(line) => <li>{line}</li>}</For></ul></details></Show>
      <details class="agent-feedback"><summary>Give the agent feedback</summary><textarea rows={2} value={feedback()} onInput={(event) => setFeedback(event.currentTarget.value)} placeholder="What should change in the draft?" /><div class="agent-feedback-actions"><span class="muted small">The agent will generate and validate a revised draft.</span><button class="btn ghost small" disabled={busy()} onClick={() => void generate()}>Update preview</button></div></details>
      <p class="agent-branch-note">Accepting creates a new <code>agent/…</code> branch. Your current branch stays available for comparison and merge.</p>
    </section>}</Show>
    <Show when={error()}>{(message) => <p class="script-error">{message()}</p>}</Show>
    <Show when={proposal()}><div class="agent-modal-footer"><button class="btn ghost" disabled={busy()} onClick={() => { setProposal(null); setFeedback(""); setError(null); }}>Discard draft</button><button class="btn accent" disabled={busy()} onClick={() => void apply()}>{busy() ? "Creating branch…" : "Add to review branch"}</button></div></Show>
  </div>;
}
