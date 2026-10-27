import { For, Show, createSignal, onCleanup } from "solid-js";
import { api } from "../api";
import { importPptx } from "../pptx";
import type { Slide, TemplateBundle } from "../types";
import { Modal } from "./Modal";
import { StaticSlide } from "./ElementView";

export function ImportPptxModal(props: { onClose: () => void; onCreated: (deckId: string) => void }) {
  const [title, setTitle] = createSignal("");
  const [filename, setFilename] = createSignal("");
  const [slides, setSlides] = createSignal<Slide[]>([]);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let generation = 0;
  onCleanup(() => { generation += 1; });

  const choose = async (file?: File) => {
    if (!file) return;
    const current = ++generation;
    setBusy(true); setError(null); setSlides([]); setWarnings([]);
    setFilename(file.name); setTitle(file.name.replace(/\.pptx$/i, ""));
    try {
      const imported = await importPptx(file);
      if (current !== generation) return;
      setSlides(imported.slides); setWarnings(imported.warnings);
    } catch (reason) { if (current === generation) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current === generation) setBusy(false); }
  };

  const create = async () => {
    if (creating() || busy() || !title().trim() || !slides().length) return;
    setCreating(true); setError(null);
    try {
      const bundle: TemplateBundle = {
        id: `pptx_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
        name: title().trim(), description: `Imported from ${filename()}`, kind: "pptx", version: 1,
        initialSlides: slides(), slideOptions: [], customObjectTypes: [],
      };
      const deck = await api.createDeck(title().trim(), undefined, bundle.id, bundle);
      props.onCreated(deck.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setCreating(false); }
  };

  return <Modal title="Import PowerPoint" subtitle="Create a new deck from a .pptx file. Preview the editable slides before importing." wide onClose={() => { if (!creating()) props.onClose(); }} footer={<>
    <span class="muted small">{slides().length ? `${slides().length} slides` : "Choose a PowerPoint file"}</span>
    <div class="row-gap"><button class="btn ghost" disabled={creating()} onClick={props.onClose}>Cancel</button><button class="btn accent" disabled={busy() || creating() || !title().trim() || !slides().length} onClick={() => void create()}>{creating() ? "Creating deck…" : "Create deck"}</button></div>
  </>}>
    <label class="field"><span>PowerPoint file</span><input type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" disabled={creating()} onChange={(event) => { void choose(event.currentTarget.files?.[0]); }} /></label>
    <Show when={filename()}><label class="field"><span>Deck title</span><input value={title()} disabled={creating()} onInput={(event) => setTitle(event.currentTarget.value)} /></label></Show>
    <Show when={busy()}><p class="muted">Reading slides and embedded images…</p></Show>
    <Show when={error()}><p class="script-error" role="alert">{error()}</p></Show>
    <Show when={warnings().length}><details class="pptx-warnings"><summary>{warnings().length} compatibility note(s)</summary><ul><For each={warnings()}>{(warning) => <li>{warning}</li>}</For></ul></details></Show>
    <div class="print-preview-grid"><For each={slides()}>{(slide, index) => <article><div class="print-preview-thumb"><StaticSlide slide={slide} /></div><span>{index() + 1}. {slide.name}</span></article>}</For></div>
  </Modal>;
}
