import { Show, createSignal, onCleanup } from "solid-js";
import type { Slide } from "../types";
import { Modal } from "./Modal";
import ScriptWorker from "../worker/scriptWorker?worker";

interface ScriptModalProps {
  slide: Slide;
  selection: string[];
  onClose: () => void;
  onApply: (slide: Slide) => void;
}

const TEMPLATE = `// Runs in an isolated worker. No DOM, storage, or network.
// API: api.selection, api.getSlide(), api.getElement(id),
//      api.updateElement(id, patch), api.setText(id, text),
//      api.addElement(el), api.removeElement(id), api.patchSlide(patch),
//      api.styleSelection({...}), api.log(...)

const targets = api.selection.length
  ? api.selection
  : Object.keys(api.getSlide().elements);

for (const id of targets) {
  api.updateElement(id, { opacity: 0.9 });
}

api.log("Touched", targets.length, "element(s)");
`;

interface ScriptResult {
  slide: Slide;
  patches: Array<{ op: string; id?: string }>;
  logs: string[];
}

export function ScriptModal(props: ScriptModalProps) {
  const [source, setSource] = createSignal(TEMPLATE);
  const [timeoutMs, setTimeoutMs] = createSignal(2000);
  const [running, setRunning] = createSignal(false);
  const [result, setResult] = createSignal<ScriptResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [logs, setLogs] = createSignal<string[]>([]);

  let worker: Worker | null = null;
  const shutdown = () => {
    worker?.terminate();
    worker = null;
    setRunning(false);
  };
  onCleanup(shutdown);

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
    });
  };

  return (
    <Modal
      title="Run script"
      subtitle="A sandboxed Web Worker with a 2s watchdog. Network APIs are stripped at runtime."
      wide
      onClose={props.onClose}
      footer={
        <>
          <span class="muted small">
            {props.selection.length
              ? `${props.selection.length} selected element(s)`
              : "No selection"}
          </span>
          <div class="row-gap">
            <button class="btn ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button class="btn" disabled={running()} onClick={run}>
              {running() ? "Running…" : "Run"}
            </button>
            <Show when={result()}>
              {(value) => (
                <button
                  class="btn accent"
                  onClick={() => {
                    props.onApply(value().slide);
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
      <div class="script-grid">
        <div class="script-editor">
          <div class="script-bar">
            <span>user-script.js</span>
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
          <textarea
            class="code"
            spellcheck={false}
            value={source()}
            onInput={(event) => setSource(event.currentTarget.value)}
          />
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
    </Modal>
  );
}
