import { For, Show, createSignal, onMount } from "solid-js";
import type { Slide, TemplateBundle, TemplateBundleSummary } from "../types";
import { api } from "../api";
import { Modal } from "./Modal";
import ScriptWorker from "../worker/scriptWorker?worker";
import { StaticSlide } from "./ElementView";

interface Props { onClose: () => void; }

const starterScript = `// Return concrete slide data. The generator runs when a deck is created.
const title = api.createSlide("Title", "#ffe4d2");
api.addElement(title, { type: "text", x: 140, y: 280, w: 1500, h: 180, text: "Your presentation", style: { fontSize: 112, fontWeight: 700, color: "#3d2a20" } });

const summary = api.createSlide("Summary");
api.addElement(summary, { type: "text", x: 140, y: 110, w: 1500, h: 100, text: "Key points", style: { fontSize: 68, fontWeight: 700, color: "#3d2a20" } });

return {
  initialSlides: [title],
  slideOptions: [{ id: "summary", name: "Summary", slides: [summary] }],
  customObjectTypes: []
};`;

export function runTemplateGenerator(source: string, customObjectTypes: TemplateBundle["customObjectTypes"] = []) {
  return new Promise<{ initialSlides: Slide[]; slideOptions: TemplateBundle["slideOptions"]; customObjectTypes: TemplateBundle["customObjectTypes"] }>((resolve, reject) => {
    const worker = new ScriptWorker();
    const id = crypto.randomUUID();
    const timer = window.setTimeout(() => { worker.terminate(); reject(new Error("Template generator timed out after 2 seconds.")); }, 2000);
    worker.onmessage = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      window.clearTimeout(timer); worker.terminate();
      if (event.data.type === "error") reject(new Error(event.data.error));
      else resolve(event.data.generated);
    };
    worker.onerror = (event) => { window.clearTimeout(timer); worker.terminate(); reject(new Error(event.message || "Template worker failed.")); };
    worker.postMessage({ id, mode: "generate-template", source, customObjectTypes });
  });
}

export function TemplateLibraryModal(props: Props) {
  const [bundles, setBundles] = createSignal<TemplateBundleSummary[]>([]);
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [source, setSource] = createSignal(starterScript);
  const [codePreview, setCodePreview] = createSignal<TemplateBundle | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [tab, setTab] = createSignal<"Library" | "Code template">("Library");
  let importInput: HTMLInputElement | undefined;

  const refresh = async () => setBundles(await api.templateBundles());
  onMount(() => { void refresh().catch((err) => setError(String(err))); });

  const previewCode = async () => {
    if (!name().trim()) return;
    setBusy(true); setError(null);
    try {
      const generated = await runTemplateGenerator(source());
      const bundle: TemplateBundle = {
        id: `tpl_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
        name: name().trim(), description: description().trim(), kind: "code", version: 1, generator: source(),
        ...generated,
      };
      setCodePreview(bundle);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const saveCode = async () => {
    const preview = codePreview();
    if (!preview) return;
    setBusy(true); setError(null);
    try { await api.saveTemplateBundle({ ...preview, name: name().trim(), description: description().trim(), generator: source() }); await refresh(); setName(""); setCodePreview(null); setTab("Library"); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const exportBundle = async (summary: TemplateBundleSummary) => {
    setBusy(true); setError(null);
    try {
      const bundle = await api.getTemplateBundle(summary.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${bundle.id}.present-template.json`; anchor.click(); URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const importBundle = async (file?: File) => {
    if (!file) return;
    setError(null);
    try {
      if (file.size > 70 * 1024 * 1024) throw new Error("Template bundle files must be 70 MB or smaller.");
      const bundle = JSON.parse(await file.text()) as TemplateBundle;
      await api.saveTemplateBundle({ ...bundle, id: `tpl_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not import that template JSON."); }
  };

  return <Modal title="Template library" subtitle="Create or import templates here, then choose one when you create a deck." wide onClose={props.onClose}>
    <nav class="build-tabs" aria-label="Template library views">
      <button class={`btn small ${tab() === "Library" ? "accent" : "ghost"}`} onClick={() => setTab("Library")}>Library</button>
      <button class={`btn small ${tab() === "Code template" ? "accent" : "ghost"}`} onClick={() => setTab("Code template")}>Code template</button>
    </nav>
    <Show when={tab() === "Library"}>
      <div class="template-manager-head"><p class="muted small">Templates are applied when a deck is created. You can export or remove saved bundles here.</p>
        <div class="row-gap"><input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void importBundle(file); }} /><button class="btn ghost small" onClick={() => importInput?.click()}>Import bundle</button></div>
      </div>
      <Show when={bundles().length} fallback={<div class="template-placeholder"><strong>No reusable templates yet</strong><span>Save the current slide or create a code template.</span></div>}>
        <div class="template-list"><For each={bundles()}>{(bundle) => <article class="template-row"><div><strong>{bundle.name}</strong><span class="muted small">{bundle.kind} · {bundle.initialSlideCount} initial slide{bundle.initialSlideCount === 1 ? "" : "s"} · {bundle.slideOptionCount} Add slide option{bundle.slideOptionCount === 1 ? "" : "s"}{bundle.description ? ` · ${bundle.description}` : ""}</span></div><div class="row-gap"><button class="btn ghost small" disabled={busy()} onClick={() => void exportBundle(bundle)}>Export</button><button class="btn ghost danger small" disabled={busy()} onClick={async () => { if (!window.confirm(`Delete template “${bundle.name}”?`)) return; setBusy(true); try { await api.deleteTemplateBundle(bundle.id); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } }}>Delete</button></div></article>}</For></div>
      </Show>
    </Show>
    <Show when={tab() === "Code template"}>
      <div class="template-code-form">
        <div class="template-save-row"><input aria-label="Template name" placeholder="Template name" value={name()} onInput={(event) => setName(event.currentTarget.value)} /><input aria-label="Template description" placeholder="What does this template create?" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></div>
        <p class="muted small">Return <code>{"{ initialSlides, slideOptions, customObjectTypes }"}</code>. Each option contains a name and one or more generated slides. Use <code>api.createSlide(name, background)</code>, <code>api.addElement(slide, element)</code>, and <code>api.addObject(slide, type, x, y, w, h, inputs)</code>. Custom object definitions declare editable inputs and a generator that returns safe <code>rect</code>, <code>circle</code>, <code>line</code>, or <code>text</code> drawing commands. Scripts run in a worker without network access; no library or markup is needed.</p>
        <textarea class="template-source" spellcheck={false} aria-label="Template generator script" value={source()} onInput={(event) => { setSource(event.currentTarget.value); setCodePreview(null); }} />
        <div class="row-gap"><button class="btn accent" disabled={busy() || !name().trim()} onClick={() => void previewCode()}>{busy() ? "Generating…" : "Generate preview"}</button><Show when={codePreview()}><button class="btn" disabled={busy()} onClick={() => void saveCode()}>Save template</button></Show></div>
        <Show when={codePreview()}>{(bundle) => <div class="template-generated-preview"><h3>Preview</h3><p class="muted small">{bundle().initialSlides.length} initial slides · {bundle().slideOptions.length} Add slide options · {bundle().customObjectTypes.length} custom object types</p><div class="generated-slide-grid"><For each={[...bundle().initialSlides, ...bundle().slideOptions.flatMap((option) => option.slides)]}>{(slide) => <article><div class="generated-slide-shot"><StaticSlide slide={slide} /></div><span>{slide.name}</span></article>}</For></div></div>}</Show>
      </div>
    </Show>
    <Show when={error()}><p class="script-error">{error()}</p></Show>
  </Modal>;
}
