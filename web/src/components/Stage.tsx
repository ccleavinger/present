import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { Slide, SlideElement } from "../types";
import type { DemoUser, PresenceEvent } from "../types";
import { collaboratorColor } from "../collaboration";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../types";
import { elementCss, measureTextHeight } from "../elements";
import { ElementView } from "./ElementView";

type Handle = "nw" | "ne" | "sw" | "se";

interface StageProps {
  slide: Slide;
  selectedId: string | null;
  selectedIds: string[];
  onSelect: (id: string | null) => boolean | Promise<boolean>;
  onSelectMany: (ids: string[]) => void;
  onCursorMove?: (x: number, y: number) => void;
  onCursorLeave?: () => void;
  remoteLocks?: Record<string, DemoUser>;
  remoteCursors?: PresenceEvent[];
  readOnly?: boolean;
  onChange: (id: string, patch: Partial<SlideElement>) => void;
  onTextCommit: (id: string, text: string, height: number) => void;
  onCropImage?: (id: string) => void;
  onTransformStart?: () => void;
  onTransformEnd?: () => void;
  onDropFiles?: (files: FileList) => void;
  onContextAction?: (action: "copy" | "duplicate" | "front" | "back" | "delete" | "paste") => void;
}

export function Stage(props: StageProps) {
  let containerRef: HTMLDivElement | undefined;
  let stageRef: HTMLDivElement | undefined;
  const [scale, setScale] = createSignal(0.5);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [lasso, setLasso] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; hasElement: boolean } | null>(null);

  let editingSlideId = props.slide.id;
  createEffect(() => {
    const nextSlide = props.slide.id;
    if (nextSlide !== editingSlideId) { editingSlideId = nextSlide; setEditingId(null); }
    const id = editingId();
    if (id && (props.readOnly || !props.selectedIds.includes(id) || !props.slide.elements[id])) setEditingId(null);
  });

  const fitTextHeight = (id: string, shrink = false) => {
    const element = props.slide.elements[id];
    const node = stageRef?.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(id)}"] .text-box`,
    );
    if (props.readOnly || !props.selectedIds.includes(id) || !element || element.type !== "text" || !node) return;
    const height = measureTextHeight(node);
    if (shrink ? Math.abs(height - element.h) > 1 : height > element.h + 1) {
      props.onChange(id, { h: height });
    }
  };

  let layoutSlideId: string | undefined;
  let previousTextLayout = new Map<string, string>();
  createEffect(() => {
    const slideId = props.slide.id;
    const textLayout = new Map(Object.values(props.slide.elements)
      .filter((element) => element.type === "text")
      .map((element) => [element.id, JSON.stringify([
        element.text, element.w, element.style.fontSize, element.style.fontWeight,
        element.style.lineHeight, element.style.fontFamily, element.style.fontStyle, element.style.letterSpacing,
      ])]));
    // Loading or selecting a slide must not mutate every text box's stored height.
    const changed = layoutSlideId === slideId
      ? [...textLayout].filter(([id, layout]) => previousTextLayout.has(id) && previousTextLayout.get(id) !== layout).map(([id]) => id)
      : [];
    layoutSlideId = slideId;
    previousTextLayout = textLayout;
    if (!changed.length || !stageRef || props.readOnly) return;
    const frame = requestAnimationFrame(() => {
      for (const id of changed) fitTextHeight(id, true);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

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
    startClient = { x: event.clientX, y: event.clientY },
    pendingMove?: PointerEvent,
  ): (() => void) => {
    if (event.button !== 0) return () => undefined;
    event.preventDefault();
    event.stopPropagation();
    props.onTransformStart?.();
    const start = slidePoint(startClient.x, startClient.y);
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
    const group = mode === "drag" && props.selectedIds.includes(element.id)
      ? props.selectedIds.map((id) => props.slide.elements[id]).filter((item): item is SlideElement => !!item)
      : [element];
    const groupInitial = new Map(group.map((item) => [item.id, { x: item.x, y: item.y }]));
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
        for (const item of group) {
          const origin = groupInitial.get(item.id)!;
          props.onChange(item.id, { x: snap(origin.x + (moveEvent.shiftKey && Math.abs(dx) <= Math.abs(dy) ? 0 : dx)), y: snap(origin.y + (moveEvent.shiftKey && Math.abs(dx) > Math.abs(dy) ? 0 : dy)) });
        }
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
      if (element.type === "text" && mode !== "drag") {
        requestAnimationFrame(() => fitTextHeight(element.id, true));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    if (pendingMove) move(pendingMove);
    return up;
  };

  type ShapeParameter = "cornerRadius" | "innerRadius" | "shaftWidth" | "headLength" | "headWidth" | "tailPosition" | "tailLength";
  const beginShapeParameter = (event: PointerEvent, element: SlideElement, parameter: ShapeParameter) => {
    event.preventDefault(); event.stopPropagation();
    props.onTransformStart?.();
    const start = slidePoint(event.clientX, event.clientY);
    const origin = element.shapeParams?.[parameter] ?? ({ cornerRadius: 0, innerRadius: 22, shaftWidth: 28, headLength: 32, headWidth: 60, tailPosition: 25, tailLength: 18 }[parameter]);
    const radians = (element.rotation ?? 0) * Math.PI / 180;
    const move = (moveEvent: PointerEvent) => {
      const point = slidePoint(moveEvent.clientX, moveEvent.clientY);
      const globalX = point.x - start.x; const globalY = point.y - start.y;
      const dx = globalX * Math.cos(radians) + globalY * Math.sin(radians);
      const dy = -globalX * Math.sin(radians) + globalY * Math.cos(radians);
      let value = origin;
      if (parameter === "cornerRadius") value = origin + (dx + dy) / 2;
      else if (parameter === "innerRadius") value = origin - dy * 100 / element.h;
      else if (parameter === "headLength") value = origin - dx * 100 / element.w;
      else if (parameter === "headWidth") value = origin - dy * 2 * 100 / element.h;
      else if (parameter === "shaftWidth") value = origin - dy * 2 * 100 / element.h;
      else if (parameter === "tailPosition") value = origin + dx * 100 / element.w;
      else if (parameter === "tailLength") value = origin + dy * 100 / element.h;
      const limits: Record<ShapeParameter, [number, number]> = { cornerRadius: [0, Math.min(element.w, element.h) / 2], innerRadius: [8, 46], shaftWidth: [8, 64], headLength: [18, 54], headWidth: [32, 92], tailPosition: [12, 88], tailLength: [8, 45] };
      const [min, max] = limits[parameter];
      props.onChange(element.id, { shapeParams: { ...element.shapeParams, [parameter]: Math.round(Math.max(min, Math.min(max, value))) } });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); props.onTransformEnd?.(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const shapeHandles = (element: SlideElement) => {
    const params = element.shapeParams ?? {};
    const add = (parameter: ShapeParameter, left: string, top: string, label: string) => <button type="button" class="shape-param-handle" data-handle="shape-param" aria-label={label} title={label} style={{ left, top }} onPointerDown={(event) => beginShapeParameter(event, element, parameter)} />;
    return <>
      {element.type === "rect" && add("cornerRadius", `${params.cornerRadius ?? 0}px`, `${params.cornerRadius ?? 0}px`, "Adjust corner radius")}
      {element.type === "star" && add("innerRadius", "50%", `${50 - (params.innerRadius ?? 22)}%`, "Adjust star inner radius")}
      {element.type === "arrow" && <>{add("shaftWidth", "45%", `${50 - (params.shaftWidth ?? 28) / 2}%`, "Adjust arrow shaft width")}{add("headLength", `${96 - (params.headLength ?? 32)}%`, "50%", "Adjust arrow head length")}{add("headWidth", `${96 - (params.headLength ?? 32)}%`, `${50 - (params.headWidth ?? 60) / 2}%`, "Adjust arrow head width")}</>}
      {element.type === "callout" && <>{add("tailPosition", `${params.tailPosition ?? 25}%`, "78%", "Adjust callout tail position")}{add("tailLength", `${params.tailPosition ?? 25}%`, `${78 + (params.tailLength ?? 18)}%`, "Adjust callout tail length")}</>}
    </>;
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-handle]")) return;
    const elementNode = target.closest("[data-element-id]") as HTMLElement | null;
    if (!elementNode) {
      setEditingId(null);
      if (props.readOnly) { void props.onSelect(null); return; }
      event.preventDefault();
      const start = slidePoint(event.clientX, event.clientY);
      setLasso({ x: start.x, y: start.y, w: 0, h: 0 });
      let moved = false;
      const move = (moveEvent: PointerEvent) => {
        const current = slidePoint(moveEvent.clientX, moveEvent.clientY);
        const rect = { x: Math.min(start.x, current.x), y: Math.min(start.y, current.y), w: Math.abs(current.x - start.x), h: Math.abs(current.y - start.y) };
        moved = rect.w > 4 || rect.h > 4;
        setLasso(rect);
      };
      const up = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const end = slidePoint(upEvent.clientX, upEvent.clientY);
        setLasso(null);
        if (!moved) { void props.onSelect(null); return; }
        const rect = { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
        const ids = ordered().filter((item) => item.x <= rect.right && item.x + item.w >= rect.left && item.y <= rect.bottom && item.y + item.h >= rect.top).map((item) => item.id);
        props.onSelectMany(ids);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    const id = elementNode.dataset.elementId!;
    if (editingId() === id) return;
    const element = props.slide.elements[id];
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    const alreadySelected = props.selectedIds.includes(id);
    const startClient = { x: event.clientX, y: event.clientY };
    let latestMove: PointerEvent | undefined;
    let pointerEnded = false;
    const trackMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === event.pointerId) latestMove = moveEvent;
    };
    const trackUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      latestMove = upEvent;
      pointerEnded = true;
      window.removeEventListener("pointermove", trackMove);
      window.removeEventListener("pointerup", trackUp);
    };
    window.addEventListener("pointermove", trackMove);
    window.addEventListener("pointerup", trackUp);
    void Promise.resolve(alreadySelected ? true : props.onSelect(id)).then((allowed) => {
      window.removeEventListener("pointermove", trackMove);
      window.removeEventListener("pointerup", trackUp);
      if (!allowed || props.readOnly) return;
      const finish = beginTransform(event, element, "drag", startClient, latestMove);
      if (pointerEnded) finish();
    }, () => {
      window.removeEventListener("pointermove", trackMove);
      window.removeEventListener("pointerup", trackUp);
    });
  };

  const onDoubleClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const elementNode = target.closest("[data-element-id]") as HTMLElement | null;
    if (!elementNode) return;
    const id = elementNode.dataset.elementId!;
    const element = props.slide.elements[id];
    if (element?.type === "text" || element?.type === "image") {
      void Promise.resolve(props.onSelect(id)).then((allowed) => {
        if (!allowed || props.readOnly) return;
        if (element.type === "text") setEditingId(id);
        else { setEditingId(null); props.onCropImage?.(id); }
      });
    }
  };

  const onContextMenu = (event: MouseEvent) => {
    if (props.readOnly) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    const node = target.closest("[data-element-id]") as HTMLElement | null;
    const id = node?.dataset.elementId;
    const show = () => setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - (id ? 250 : 54))),
      hasElement: !!id,
    });
    if (id && !props.selectedIds.includes(id)) {
      void Promise.resolve(props.onSelect(id)).then((allowed) => { if (allowed) show(); });
    } else show();
  };

  const closeContextMenu = (event: PointerEvent) => {
    if (!(event.target as HTMLElement).closest(".stage-context-menu")) setContextMenu(null);
  };
  onMount(() => document.addEventListener("pointerdown", closeContextMenu));
  onCleanup(() => document.removeEventListener("pointerdown", closeContextMenu));

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
          onPointerMove={(event) => {
            const point = slidePoint(event.clientX, event.clientY);
            props.onCursorMove?.(point.x, point.y);
          }}
          onPointerLeave={() => props.onCursorLeave?.()}
          onDblClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onDragOver={(event) => {
            if (props.onDropFiles) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!props.onDropFiles) return;
            event.preventDefault();
            if (event.dataTransfer?.files.length) props.onDropFiles(event.dataTransfer.files);
          }}
        >
          <For each={ordered().map((element) => element.id)}>
            {(id) => <ElementView
              element={props.slide.elements[id]}
              editing={editingId() === id}
              onTextInput={(text, height) => props.onTextCommit(id, text, height)}
              onTextCommit={(text, height) => {
                props.onTextCommit(id, text, height);
                setEditingId(null);
              }}
            />}
          </For>

          <For each={Object.entries(props.remoteLocks ?? {})}>{([id, user]) => {
            const element = props.slide.elements[id];
            return element ? <div class="selection remote-selection" style={{ ...elementCss(element), "--collaborator-color": collaboratorColor(user.id) }}><span class="selection-label">{user.username} editing</span></div> : null;
          }}</For>
          <For each={(props.remoteCursors ?? []).filter((cursor) => cursor.slideId === props.slide.id).map((cursor) => cursor.connectionId!)}>{(id) => {
            const cursor = () => props.remoteCursors?.find((item) => item.connectionId === id);
            return <Show when={cursor()}>{(current) => <div class="remote-cursor" aria-label={`${current().user?.username ?? "Collaborator"}’s cursor`}
              style={{ left: `${current().x ?? 0}px`, top: `${current().y ?? 0}px`, "--collaborator-color": collaboratorColor(current().user?.id ?? id) }}>
              <svg class="remote-cursor-pointer" viewBox="0 0 32 40" aria-hidden="true"><path d="M3 2L3 30L10 23L16 36L22 33L16 21L29 21Z" /></svg>
              <span class="remote-cursor-name">{current().user?.username}</span>
            </div>}</Show>;
          }}</For>

          <Show when={lasso()}>{(rect) => <div class="selection-lasso" style={{ left: `${rect().x}px`, top: `${rect().y}px`, width: `${rect().w}px`, height: `${rect().h}px` }} />}</Show>

          <For each={props.selectedIds}>{(id) => {
            const current = () => props.slide.elements[id];
            const primary = () => id === props.selectedId;
            return <Show when={current()}>{(element) => <div class={`selection ${primary() ? "" : "selection-secondary"}`} style={elementCss(element())}>
              <div class="selection-label">{element().type}</div>
              <Show when={!props.readOnly && props.selectedIds.length === 1}><For each={["nw", "ne", "sw", "se"] as Handle[]}>
                {(handle) => <button type="button" class={`handle handle-${handle}`} data-handle={handle} aria-label={`Resize ${handle}`} onPointerDown={(event) => beginTransform(event, element(), handle)} />}
              </For><button type="button" class="handle handle-rotate" data-handle="rotate" aria-label="Rotate element" onPointerDown={(event) => beginTransform(event, element(), "rotate")}>↻</button>{primary() ? shapeHandles(element()) : null}</Show>
            </div>}</Show>;
          }}</For>
          {/* Legacy single selection remains a fallback while slide selection changes settle. */}
          <Show when={props.selectedIds.length === 0 ? selected() : undefined}>
            {(element) => (
              <div class="selection" style={elementCss(element())}>
                <div class="selection-label">{element().type}</div>
                <Show when={!props.readOnly}><For each={["nw", "ne", "sw", "se"] as Handle[]}>
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
                {shapeHandles(element())}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
      <Show when={contextMenu()}>{(menu) => <div class="stage-context-menu" role="menu" style={{ left: `${menu().x}px`, top: `${menu().y}px` }}>
        <Show when={menu().hasElement}>
          <button role="menuitem" onClick={() => { props.onContextAction?.("copy"); setContextMenu(null); }}>Copy</button>
          <button role="menuitem" onClick={() => { props.onContextAction?.("duplicate"); setContextMenu(null); }}>Duplicate</button>
          <button role="menuitem" onClick={() => { props.onContextAction?.("front"); setContextMenu(null); }}>Bring to front</button>
          <button role="menuitem" onClick={() => { props.onContextAction?.("back"); setContextMenu(null); }}>Send to back</button>
          <div class="context-menu-divider" />
          <button class="danger" role="menuitem" onClick={() => { props.onContextAction?.("delete"); setContextMenu(null); }}>Delete</button>
        </Show>
        <Show when={!menu().hasElement}><button role="menuitem" onClick={() => { props.onContextAction?.("paste"); setContextMenu(null); }}>Paste</button></Show>
      </div>}</Show>
      <div class="zoom-badge">{Math.round(scale() * 100)}%</div>
    </div>
  );
}
