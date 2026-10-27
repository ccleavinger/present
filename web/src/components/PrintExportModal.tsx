import { For, Show, createSignal, onMount } from "solid-js";
import type { DeckDetail, Slide } from "../types";
import { api } from "../api";
import { Modal } from "./Modal";
import { StaticSlide } from "./ElementView";
import { exportPptx } from "../pptx";

export function PrintExportModal(props: { deckId: string; detail: DeckDetail; sessionId?: string; onClose: () => void }) {
  const [slides, setSlides] = createSignal<Slide[]>([]);
  const [busy, setBusy] = createSignal(true);
  const [actionBusy, setActionBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [warnings, setWarnings] = createSignal<string[]>([]);

  onMount(async () => {
    try {
      const loaded: Slide[] = [];
      for (const summary of props.detail.slides) {
        loaded.push((await api.getSlide(props.deckId, summary.id, props.sessionId, props.detail.currentBranch)).slide);
      }
      setSlides(loaded);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  });

  const downloadPptx = async () => {
    if (!slides().length) return;
    setActionBusy(true); setError(null); setWarnings([]);
    try {
      const result = await exportPptx(props.detail.deck.title, slides());
      setWarnings(result.warnings);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${props.detail.deck.title.replace(/[^a-z0-9_-]+/gi, "-") || "presentation"}.pptx`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setActionBusy(false); }
  };

  return <>
    <Modal title="Export & print" subtitle="Download an editable PowerPoint or print your slides to PDF." onClose={props.onClose} footer={<><span class="muted small">{slides().length} slides · 16:9</span><div class="row-gap"><button class="btn ghost" disabled={actionBusy()} onClick={props.onClose}>Close</button><button class="btn ghost" disabled={busy() || actionBusy() || !!error() || !slides().length} onClick={() => void downloadPptx()}>{actionBusy() ? "Working…" : "Export PPTX"}</button><button class="btn accent" disabled={busy() || actionBusy() || !!error() || !slides().length} onClick={() => window.print()}>Print / Save PDF</button></div></>}>
      <Show when={!busy()} fallback={<p class="muted">Preparing slide previews…</p>}>
        <Show when={error()}>{(message) => <p class="script-error">{message()}</p>}</Show>
        <Show when={warnings().length > 0}><div class="pptx-warnings"><strong>Compatibility notes</strong><ul><For each={warnings()}>{(warning) => <li>{warning}</li>}</For></ul></div></Show>
        <Show when={!error()}>
          <div class="print-preview-grid"><For each={slides()}>{(slide, index) => <article><div class="print-preview-thumb"><StaticSlide slide={slide} /></div><span>{index() + 1}. {slide.name}</span></article>}</For></div>
        </Show>
      </Show>
    </Modal>
    <div class="print-output" aria-hidden="true"><For each={slides()}>{(slide) => <article class="print-output-slide"><StaticSlide slide={slide} /></article>}</For></div>
  </>;
}
