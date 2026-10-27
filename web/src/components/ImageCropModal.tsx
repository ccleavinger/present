import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { ImageCrop, SlideElement } from "../types";
import { coverImageCrop, croppedImageCss, normalizeImageCrop, zoomImageCrop } from "../imageCrop";
import { Modal } from "./Modal";

export function ImageCropModal(props: { element: SlideElement; onApply: (crop: ImageCrop | undefined) => void; onClose: () => void }) {
  const [size, setSize] = createSignal<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = createSignal(1);
  const [maxZoom, setMaxZoom] = createSignal(6);
  const [center, setCenter] = createSignal({ x: 0.5, y: 0.5 });
  const [error, setError] = createSignal("");
  const base = () => size() ? coverImageCrop(size()!.w, size()!.h, props.element.w, props.element.h) : { x: 0, y: 0, w: 1, h: 1 };
  const crop = createMemo(() => zoomImageCrop(base(), zoom(), center().x, center().y));
  let frame: HTMLDivElement | undefined;
  let drag: { pointerId: number; x: number; y: number; crop: ImageCrop; width: number; height: number } | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  onMount(() => {
    const image = new Image(); image.src = props.element.src ?? "";
    void image.decode().then(() => {
      if (disposed) return;
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("This image could not be opened.");
      setSize({ w: image.naturalWidth, h: image.naturalHeight });
      const existing = normalizeImageCrop(props.element.imageCrop);
      if (existing) {
        const initialZoom = Math.max(1, Math.min(base().w / existing.w, base().h / existing.h));
        setMaxZoom(Math.max(6, initialZoom)); setZoom(initialZoom);
        setCenter({ x: existing.x + existing.w / 2, y: existing.y + existing.h / 2 });
      }
      queueMicrotask(() => frame?.focus({ preventScroll: true }));
    }).catch(() => { if (!disposed) setError("This image could not be loaded for cropping."); });
  });
  const setScale = (value: number) => setZoom(Math.max(1, Math.min(maxZoom(), value)));
  const pan = (x: number, y: number) => {
    const current = crop();
    const next = zoomImageCrop(base(), zoom(), current.x + current.w / 2 + x, current.y + current.h / 2 + y);
    setCenter({ x: next.x + next.w / 2, y: next.y + next.h / 2 });
  };
  return <Modal title="Crop image" subtitle="Drag to reposition the image and zoom to choose what stays in the frame." onClose={props.onClose} footer={<>
    <button class="btn ghost" onClick={() => props.onApply(undefined)}>Reset image</button>
    <div class="row-gap"><button class="btn ghost" onClick={props.onClose}>Cancel</button><button class="btn accent" disabled={!size() || !!error()} onClick={() => props.onApply(crop())}>Apply crop</button></div>
  </>}>
    <div class="image-crop-editor" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onClose(); } }}>
      <Show when={error()}><p class="script-error" role="alert">{error()}</p></Show>
      <Show when={size()} fallback={<p class="muted">Loading image…</p>}>
        <div class="image-crop-frame" role="group" aria-label="Crop preview. Drag the image or use arrow keys to reposition it." tabIndex={0} ref={frame}
          style={{ position: "relative", overflow: "hidden", width: `min(100%, 620px, ${52 * props.element.w / props.element.h}vh)`, "aspect-ratio": String(props.element.w / props.element.h), "touch-action": "none" }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault(); frame?.focus({ preventScroll: true });
            const bounds = event.currentTarget.getBoundingClientRect();
            drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, crop: crop(), width: bounds.width, height: bounds.height };
            if (event.isTrusted) event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag || event.pointerId !== drag.pointerId || !drag.width || !drag.height) return;
            const next = zoomImageCrop(base(), zoom(), drag.crop.x + drag.crop.w / 2 - (event.clientX - drag.x) / drag.width * drag.crop.w, drag.crop.y + drag.crop.h / 2 - (event.clientY - drag.y) / drag.height * drag.crop.h);
            setCenter({ x: next.x + next.w / 2, y: next.y + next.h / 2 });
          }}
          onPointerUp={() => { drag = undefined; }} onPointerCancel={() => { drag = undefined; }}
          onWheel={(event) => { event.preventDefault(); setScale(zoom() * (event.deltaY > 0 ? 0.95 : 1.05)); }}
          onKeyDown={(event) => {
            const amount = (event.shiftKey ? 0.1 : 0.01) / zoom();
            if (event.key.startsWith("Arrow")) {
              event.preventDefault(); event.stopPropagation();
              pan(event.key === "ArrowLeft" ? amount : event.key === "ArrowRight" ? -amount : 0, event.key === "ArrowUp" ? amount : event.key === "ArrowDown" ? -amount : 0);
            }
          }}>
          <img src={props.element.src} alt="Crop preview" draggable={false} style={croppedImageCss(crop())} />
          <div class="image-crop-grid" aria-hidden="true" />
        </div>
        <label class="field crop-zoom"><span>Zoom · {Math.round(zoom() * 100)}%</span><input type="range" aria-label="Crop zoom" min="1" max={maxZoom()} step="0.01" value={zoom()} onInput={(event) => setScale(Number(event.currentTarget.value))} /></label>
        <div class="row-gap"><button class="btn ghost small" onClick={() => { setZoom(1); setCenter({ x: 0.5, y: 0.5 }); }}>Fit frame</button><button class="btn ghost small" onClick={() => setCenter({ x: 0.5, y: 0.5 })}>Center image</button></div>
      </Show>
    </div>
  </Modal>;
}
