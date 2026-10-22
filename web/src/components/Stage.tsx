import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { Slide, SlideElement } from "../types";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../types";
import { elementCss } from "../elements";
import { ElementView } from "./ElementView";

type Handle = "nw" | "ne" | "sw" | "se";

interface StageProps {
  slide: Slide;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<SlideElement>) => void;
  onTextCommit: (id: string, text: string) => void;
  onTransformStart?: () => void;
  onTransformEnd?: () => void;
  onDropFiles?: (files: FileList) => void;
}

export function Stage(props: StageProps) {
  let containerRef: HTMLDivElement | undefined;
  let stageRef: HTMLDivElement | undefined;
  const [scale, setScale] = createSignal(0.5);
  const [editingId, setEditingId] = createSignal<string | null>(null);

  const fit = () => {
    if (!containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    const pad = 56;
    const next = Math.min(
      (rect.width - pad * 2) / CANVAS_WIDTH,
      (rect.height - pad * 2) / CANVAS_HEIGHT,
    );
    setScale(Math.max(0.05, Math.min(next, 2)));
  };

  onMount(() => {
    fit();
    const observer = new ResizeObserver(fit);
    if (containerRef) observer.observe(containerRef);
    window.addEventListener("resize", fit);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    });
  });

  const selected = () => (props.selectedId ? props.slide.elements[props.selectedId] : undefined);
  const ordered = () => Object.values(props.slide.elements).sort((a, b) => a.z - b.z);

  const slidePoint = (clientX: number, clientY: number) => {
    const rect = stageRef!.getBoundingClientRect();
    const s = scale();
    return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
  };

  const beginTransform = (
    event: PointerEvent,
    element: SlideElement,
    mode: "drag" | Handle | "rotate",
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    props.onTransformStart?.();
    const start = slidePoint(event.clientX, event.clientY);
    const initial = {
      x: element.x,
      y: element.y,
      w: element.w,
      h: element.h,
      rotation: element.rotation ?? 0,
    };
    const center = {
      x: element.x + element.w / 2,
      y: element.y + element.h / 2,
    };
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    let moved = false;

    const move = (moveEvent: PointerEvent) => {
      const point = slidePoint(moveEvent.clientX, moveEvent.clientY);
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved = true;
      const snap = (value: number) => (moveEvent.altKey ? Math.round(value) : Math.round(value));

      if (mode === "drag") {
        let nextX = initial.x + dx;
        let nextY = initial.y + dy;
        if (moveEvent.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) nextY = initial.y;
          else nextX = initial.x;
        }
        props.onChange(element.id, { x: snap(nextX), y: snap(nextY) });
        return;
      }

      if (mode === "rotate") {
        const angle = Math.atan2(point.y - center.y, point.x - center.x);
        let degrees = initial.rotation + ((angle - startAngle) * 180) / Math.PI;
        if (moveEvent.shiftKey) degrees = Math.round(degrees / 15) * 15;
        else degrees = Math.round(degrees * 10) / 10;
        props.onChange(element.id, { rotation: degrees });
        return;
      }

      const min = 16;
      let x = initial.x;
      let y = initial.y;
      let w = initial.w;
      let h = initial.h;
      if (mode === "se") {
        w = Math.max(min, initial.w + dx);
        h = Math.max(min, initial.h + dy);
      } else if (mode === "sw") {
        w = Math.max(min, initial.w - dx);
        h = Math.max(min, initial.h + dy);
        x = initial.x + (initial.w - w);
      } else if (mode === "ne") {
        w = Math.max(min, initial.w + dx);
        h = Math.max(min, initial.h - dy);
        y = initial.y + (initial.h - h);
      } else if (mode === "nw") {
        w = Math.max(min, initial.w - dx);
        h = Math.max(min, initial.h - dy);
        x = initial.x + (initial.w - w);
        y = initial.y + (initial.h - h);
      }
      props.onChange(element.id, {
        x: snap(x),
        y: snap(y),
        w: snap(w),
        h: snap(h),
      });
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      props.onTransformEnd?.();
      if (!moved && mode === "drag") props.onSelect(element.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-handle]")) return;
    const elementNode = target.closest("[data-element-id]") as HTMLElement | null;
    if (!elementNode) {
      props.onSelect(null);
      setEditingId(null);
      return;
    }
    const id = elementNode.dataset.elementId!;
    if (editingId() === id) return;
    const element = props.slide.elements[id];
    if (!element) return;
    props.onSelect(id);
    beginTransform(event, element, "drag");
  };

  const onDoubleClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const elementNode = target.closest("[data-element-id]") as HTMLElement | null;
    if (!elementNode) return;
    const id = elementNode.dataset.elementId!;
    const element = props.slide.elements[id];
    if (element?.type === "text") {
      props.onSelect(id);
      setEditingId(id);
    }
  };

  return (
    <div class="stage-container" ref={containerRef}>
      <div
        class="stage-outer"
        style={{
          width: `${CANVAS_WIDTH * scale()}px`,
          height: `${CANVAS_HEIGHT * scale()}px`,
        }}
      >
        <div
          class="stage"
          ref={stageRef}
          style={{
            width: `${CANVAS_WIDTH}px`,
            height: `${CANVAS_HEIGHT}px`,
            transform: `scale(${scale()})`,
            background: props.slide.background,
            "--inv-scale": String(1 / scale()),
          }}
          onPointerDown={onPointerDown}
          onDblClick={onDoubleClick}
          onDragOver={(event) => {
            if (props.onDropFiles) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!props.onDropFiles) return;
            event.preventDefault();
            if (event.dataTransfer?.files.length) props.onDropFiles(event.dataTransfer.files);
          }}
        >
          <For each={ordered()}>
            {(element) => (
              <ElementView
                element={element}
                editing={editingId() === element.id}
                onTextCommit={(text) => {
                  props.onTextCommit(element.id, text);
                  setEditingId(null);
                }}
              />
            )}
          </For>

          <Show when={ordered().length === 0}>
            <div class="empty-slide">Empty slide — add text or a shape from the toolbar.</div>
          </Show>

          <Show when={selected()}>
            {(element) => (
              <div class="selection" style={elementCss(element())}>
                <div class="selection-label">
                  {element().type} · {element().id}
                </div>
                <For each={["nw", "ne", "sw", "se"] as Handle[]}>
                  {(handle) => (
                    <button
                      type="button"
                      class={`handle handle-${handle}`}
                      data-handle={handle}
                      aria-label={`Resize ${handle}`}
                      onPointerDown={(event) => beginTransform(event, element(), handle)}
                    />
                  )}
                </For>
                <button
                  type="button"
                  class="handle handle-rotate"
                  data-handle="rotate"
                  aria-label="Rotate element"
                  onPointerDown={(event) => beginTransform(event, element(), "rotate")}
                >
                  ↻
                </button>
              </div>
            )}
          </Show>
        </div>
      </div>
      <div class="zoom-badge">{Math.round(scale() * 100)}%</div>
    </div>
  );
}
