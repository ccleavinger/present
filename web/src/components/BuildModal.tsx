import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { CustomObjectDefinition, Slide } from "../types";
import { Modal } from "./Modal";
import { AgentPanel } from "./AgentPanel";
import ScriptWorker from "../worker/scriptWorker?worker";

interface BuildModalProps {
  deckId: string;
  deckTitle: string;
  deckSlides: Slide[];
  sessionId?: string;
  slide: Slide;
  selection: string[];
  customObjectTypes: CustomObjectDefinition[];
  onClose: () => void;
  onApplyScript: (slide: Slide) => void;
  onApplyAgent: (slides: Slide[], request: string) => Promise<void>;
}

const TEMPLATE = `// Runs in an isolated worker. No DOM, storage, or network.
// API: api.selection, api.getSlide(), api.getElement(id),
//      api.updateElement(id, patch), api.setText(id, text),
//      api.addElement(el), api.removeElement(id), api.patchSlide(patch),
//      api.styleSelection({...}), api.addObject(type, x, y, w, h, inputs),
//      api.addAnimation(elementId, "fade", { durationMs: 500 }), api.log(...)

const targets = api.selection.length
  ? api.selection
  : Object.keys(api.getSlide().elements);

for (const id of targets) {
  api.updateElement(id, { opacity: 0.9 });
}

api.log("Touched", targets.length, "element(s)");
`;

const apiDocs = [
  { name: "api.selection", signature: "string[]", kind: "Read", completionType: "property", returns: "string[]", description: "Element IDs selected when Run script was pressed. An empty array means nothing was selected.", example: "const targets = api.selection;" },
  { name: "api.version", signature: "string", kind: "Read", completionType: "property", returns: '"1.3"', description: "Version of the scripting API available to this worker.", example: "api.log(`API ${api.version}`);" },
  { name: "api.getSlide()", signature: "() => Slide", kind: "Read", completionType: "function", returns: "Slide", description: "Returns a structured clone of the current slide. Changing the returned value does not mutate the working slide.", example: "const slide = api.getSlide();\napi.log(slide.name);" },
  { name: "api.getElement(id)", signature: "(id: string) => SlideElement", kind: "Read", completionType: "function", returns: "SlideElement", description: "Returns a copy of the element with this ID. Throws if the ID does not exist.", example: "const element = api.getElement(api.selection[0]);" },
  { name: "api.updateElement(id, patch)", signature: "(id: string, patch: Partial<SlideElement>) => SlideElement", kind: "Write", completionType: "function", returns: "SlideElement", description: "Applies a shallow element patch. The style field is merged with the existing style; the element ID cannot be changed.", example: 'api.updateElement("title", { opacity: 0.9 });' },
  { name: "api.setText(id, text)", signature: "(id: string, text: string) => SlideElement", kind: "Write", completionType: "function", returns: "SlideElement", description: "Replaces the text property of an existing element. Throws if the element ID does not exist.", example: 'api.setText("title", "A clearer title");' },
  { name: "api.addElement(element)", signature: "(element: SlideElement) => SlideElement", kind: "Write", completionType: "function", returns: "SlideElement", description: "Adds an element to the current slide. Missing rotation, z, style, or ID values receive defaults.", example: 'api.addElement({ id: "greeting", type: "text", x: 120, y: 100, w: 600, h: 100, rotation: 0, z: 1, text: "Hello", style: {} });' },
  { name: "api.addObject(type, x, y, w, h, inputs)", signature: "(type: string, x: number, y: number, w: number, h: number, inputs?: Record<string, unknown>) => SlideElement", kind: "Write", completionType: "function", returns: "SlideElement", description: "Creates an instance of a custom object type defined by this deck's template. Its generator runs in the worker and stores safe drawing commands with the object.", example: 'api.addObject("qr-code", 700, 300, 320, 320, { text: "https://example.com" });' },
  { name: "api.addAnimation(target, effect, options)", signature: '(target: string | SlideElement, effect: "fade" | "rise" | "zoom" | "pulse" | "move" | "exit-fade" | "exit-rise", options?: { durationMs?: number; delayMs?: number; trigger?: "click" | "with-previous" | "after-previous"; direction?: "left" | "right" | "up" | "down" }) => SlideAnimation', kind: "Write", completionType: "function", returns: "SlideAnimation", description: "Adds an ordered entrance, emphasis, movement, or exit effect to an element.", example: 'api.addAnimation("title", "rise", { durationMs: 700, trigger: "after-previous" });' },
  { name: "api.updateAnimation(id, patch)", signature: '(id: string, patch: Partial<SlideAnimation>) => SlideAnimation', kind: "Write", completionType: "function", returns: "SlideAnimation", description: "Updates an existing animation effect, order, duration, or delay.", example: 'api.updateAnimation(animationId, { effect: "fade", delayMs: 200 });' },
  { name: "api.removeAnimation(id)", signature: "(id: string) => void", kind: "Write", completionType: "function", returns: "void", description: "Removes an animation and renumbers the remaining steps.", example: 'api.removeAnimation(animationId);' },
  { name: "api.removeElement(id)", signature: "(id: string) => void", kind: "Write", completionType: "function", returns: "void", description: "Removes an existing element. Throws if the element ID does not exist.", example: 'api.removeElement("old-caption");' },
  { name: "api.patchSlide(patch)", signature: "(patch: Partial<Slide>) => void", kind: "Write", completionType: "function", returns: "void", description: "Updates slide fields such as name or background. The elements map is merged by element ID.", example: 'api.patchSlide({ name: "Summary", background: "#f7efe2" });' },
  { name: "api.styleSelection(patch)", signature: "(patch: Record<string, unknown>) => number", kind: "Write", completionType: "function", returns: "number", description: "Merges the style patch into each selected element and returns the number of selected IDs. Missing IDs are skipped.", example: 'api.styleSelection({ color: "#56483b", fontWeight: 700 });' },
  { name: "api.log(...values)", signature: "(...values: unknown[]) => void", kind: "Output", completionType: "function", returns: "void", description: "Writes values to the Build output panel. Objects are JSON formatted where possible.", example: 'api.log("Updated", api.selection.length, "elements");' },
];

const apiTypes = [
  { name: "Slide", signature: "{ version: number; id: string; name: string; background: string; elements: Record<string, SlideElement>; animations?: SlideAnimation[]; transition?: SlideTransition }", description: "A slide with its metadata, objects, object animation sequence, and transition into the slide." },
  { name: "SlideElement", signature: "{ id: string; type: string; x: number; y: number; w: number; h: number; rotation: number; z: number; text?: string; fill?: string; stroke?: string; strokeWidth?: number; src?: string; opacity?: number; style: Record<string, unknown>; [key: string]: unknown }", description: "A positioned visual element. Optional fields depend on its type; style is an open-ended property map." },
  { name: "SlideAnimation", signature: '{ id: string; elementId: string; effect: "fade" | "rise" | "zoom" | "pulse" | "move" | "exit-fade" | "exit-rise"; trigger?: "click" | "with-previous" | "after-previous"; direction?: "left" | "right" | "up" | "down"; order: number; durationMs: number; delayMs: number }', description: "An ordered object effect that plays during presentation." },
  { name: "SlideTransition", signature: '{ effect: "none" | "fade" | "push" | "wipe"; durationMs: number; direction: "left" | "right" | "up" | "down" }', description: "The transition that plays when a slide appears during presentation." },
];

const completions = (context: CompletionContext) => {
  const word = context.matchBefore(/[\w.$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: apiDocs.map((doc) => ({ label: doc.name, detail: doc.signature, info: doc.description, type: doc.completionType })) };
};

interface ScriptResult {
  slide: Slide;
  patches: Array<{ op: string; id?: string }>;
  logs: string[];
}

export function BuildModal(props: BuildModalProps) {
  const [source, setSource] = createSignal(TEMPLATE);
  const [timeoutMs, setTimeoutMs] = createSignal(2000);
  const [running, setRunning] = createSignal(false);
  const [result, setResult] = createSignal<ScriptResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [logs, setLogs] = createSignal<string[]>([]);
  const tabs = ["Agent", "Script", "API reference"] as const;
  const [tab, setTab] = createSignal<(typeof tabs)[number]>("Agent");
  const [scriptFileName, setScriptFileName] = createSignal("user-script.js");
  const [draggingFile, setDraggingFile] = createSignal(false);

  let worker: Worker | null = null;
  let editorHost: HTMLDivElement | undefined;
  let editor: EditorView | undefined;
  createEffect(() => { if (tab() === "Script") queueMicrotask(() => editor?.requestMeasure()); });
  const shutdown = () => {
    worker?.terminate();
    worker = null;
    setRunning(false);
  };
  onCleanup(shutdown);
  onMount(() => {
    if (!editorHost) return;
    editor = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: source(),
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), javascript(),
          syntaxHighlighting(HighlightStyle.define([
            { tag: tags.keyword, color: "#b44f78", fontWeight: "600" },
            { tag: [tags.string, tags.special(tags.string)], color: "#4c8063" },
            { tag: [tags.number, tags.bool, tags.null], color: "#a45d24" },
            { tag: tags.comment, color: "#968a7e", fontStyle: "italic" },
            { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "#7655a3" },
            { tag: [tags.propertyName, tags.attributeName], color: "#a05f37" },
            { tag: [tags.typeName, tags.className], color: "#267c80" },
            { tag: tags.operator, color: "#bd6251" },
            { tag: tags.variableName, color: "#455a70" },
          ])),
          autocompletion({ override: [completions] }),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setSource(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "#fffdf8", color: "#43382f" },
            ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, monospace" },
            ".cm-gutters": { backgroundColor: "#f5efe4", color: "#9a8d7d", border: "0" },
            ".cm-activeLine": { backgroundColor: "#f8f2e9" },
            ".cm-activeLineGutter": { backgroundColor: "#f1e8db" },
          }),
        ],
      }),
    });
  });
  onCleanup(() => editor?.destroy());

  const run = () => {
    shutdown();
    setResult(null);
    setError(null);
    setLogs([]);
    setRunning(true);
    const id = crypto.randomUUID();
    worker = new ScriptWorker();
    const fail = (message: string) => {
      setError(message);
      setRunning(false);
      shutdown();
    };
    const watchdog = window.setTimeout(() => {
      fail(`Timed out after ${timeoutMs()}ms. The worker was terminated.`);
      worker?.terminate();
      worker = null;
    }, timeoutMs());

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.id !== id) return;
      window.clearTimeout(watchdog);
      setLogs(message.logs ?? []);
      if (message.type === "error") {
        fail(message.error ?? "Script failed");
        return;
      }
      setResult({ slide: message.slide, patches: message.patches ?? [], logs: message.logs ?? [] });
      setRunning(false);
      worker?.terminate();
      worker = null;
    };
    worker.onerror = (event) => {
      window.clearTimeout(watchdog);
      fail(event.message || "Worker crashed");
    };
    worker.postMessage({
      id,
      source: source(),
      slide: props.slide,
      selection: props.selection,
      customObjectTypes: props.customObjectTypes,
    });
  };

  return (
    <Modal
      title="Build"
      subtitle="Create slides with the agent, edit with a script, or explore the API."
      wide
      onClose={props.onClose}
      footer={
        <>
          <span class="muted small">
            {tab() !== "Script" ? props.slide.name : props.selection.length
              ? `${props.selection.length} selected element(s)`
              : "No selection"}
          </span>
          <div class="row-gap">
            <button class="btn ghost" onClick={props.onClose}>
              Close
            </button>
            <Show when={tab() === "Script"}>
              <button class="btn" disabled={running()} onClick={run}>
                {running() ? "Running…" : "Run script"}
              </button>
            </Show>
            <Show when={tab() === "Script" && result()}>
              {(value) => (
                <button
                  class="btn accent"
                  onClick={() => {
                    props.onApplyScript(value().slide);
                    props.onClose();
                  }}
                >
                  Apply {value().patches.length} patch{value().patches.length === 1 ? "" : "es"}
                </button>
              )}
            </Show>
          </div>
        </>
      }
    >
      <nav class="build-tabs" role="tablist" aria-label="Build tools" onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(tab()) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        setTab(tabs[index]);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
      }}>
        <For each={tabs}>{(item) =>
          <button role="tab" id={`build-tab-${item.replaceAll(" ", "-")}`} aria-selected={tab() === item} aria-controls={`build-panel-${item.replaceAll(" ", "-")}`} tabIndex={tab() === item ? 0 : -1} class={`btn small ${tab() === item ? "accent" : "ghost"}`} onClick={() => setTab(item)}>{item}</button>
        }</For>
      </nav>
      <div class="build-tab-panel" role="tabpanel" id="build-panel-Agent" aria-labelledby="build-tab-Agent" style={{ display: tab() === "Agent" ? "block" : "none" }}>
        <AgentPanel deckId={props.deckId} deckTitle={props.deckTitle} currentSlide={props.slide} deckSlides={props.deckSlides} sessionId={props.sessionId} customObjectTypes={props.customObjectTypes} onApply={props.onApplyAgent} />
      </div>
      <div class="build-tab-panel" role="tabpanel" id="build-panel-Script" aria-labelledby="build-tab-Script" style={{ display: tab() === "Script" ? "block" : "none" }}>
      <div class="script-grid">
        <div class={`script-editor ${draggingFile() ? "is-file-dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDraggingFile(true); }}
          onDragOver={(event) => { event.preventDefault(); }}
          onDragLeave={(event) => { const next = event.relatedTarget; if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDraggingFile(false); }}
          onDrop={async (event) => {
            event.preventDefault(); setDraggingFile(false);
            const file = event.dataTransfer?.files[0];
            if (!file) return;
            if (!/\.(m?js|cjs|ts|tsx)$/i.test(file.name)) { setError("Drop a JavaScript or TypeScript file to replace the editor contents."); return; }
            try {
              const text = await file.text();
              if (editor) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
              else setSource(text);
              setScriptFileName(file.name);
              setError(null); setResult(null); setLogs([]);
            } catch (err) { setError(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`); }
          }}>
          <div class="script-bar">
            <span>{scriptFileName()}</span><span class="drop-hint">Drop a JS file to replace</span>
            <label class="inline-field">
              timeout
              <select
                value={String(timeoutMs())}
                onChange={(event) => setTimeoutMs(Number(event.currentTarget.value))}
              >
                <option value="500">500 ms</option>
                <option value="1000">1 s</option>
                <option value="2000">2 s</option>
                <option value="5000">5 s</option>
              </select>
            </label>
          </div>
          <div class="code-editor-host" ref={editorHost} />
        </div>
        <div class="script-output">
          <h4>Output</h4>
          <Show when={error()}>
            <pre class="script-error">{error()}</pre>
          </Show>
          <Show when={result()}>
            {(value) => (
              <div class="script-success">
                <strong>Ready to apply</strong>
                <span>{value().patches.length} mutation patches</span>
              </div>
            )}
          </Show>
          <Show when={logs().length > 0}>
            <pre class="script-logs">{logs().join("\n")}</pre>
          </Show>
          <Show when={!error() && !result() && logs().length === 0}>
            <p class="muted small">
              Script output, mutation counts, and errors appear here. Infinite loops are killed by
              the main-thread watchdog.
            </p>
          </Show>
        </div>
      </div>
      </div>
      <div class="build-tab-panel" role="tabpanel" id="build-panel-API-reference" aria-labelledby="build-tab-API-reference" style={{ display: tab() === "API reference" ? "block" : "none" }}>
        <div class="build-docs"><h3>Script API</h3><p class="muted">Scripts run in a worker with no DOM, storage, or network access.</p>
          <div class="api-doc-grid"><For each={apiDocs}>{(doc) => <article class={`api-doc api-doc-${doc.kind.toLowerCase()}`}>
            <div class="api-doc-heading"><code>{doc.name}</code><span class={`api-kind api-kind-${doc.kind.toLowerCase()}`}>{doc.kind}</span></div>
            <code class="api-signature">{doc.signature}</code><p>{doc.description}</p>
            <div class="api-returns"><span>Returns</span><code>{doc.returns}</code></div>
            <pre class="api-example"><code>{doc.example}</code></pre>
          </article>}</For></div>
          <h3 class="api-types-title">Data types</h3><div class="api-doc-grid"><For each={apiTypes}>{(type) => <article class="api-doc api-doc-type"><div class="api-doc-heading"><code>{type.name}</code><span class="api-kind api-kind-type">Type</span></div><code class="api-signature">{type.signature}</code><p>{type.description}</p></article>}</For></div>
        </div>
      </div>
    </Modal>
  );
}
