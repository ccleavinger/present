import { For, onCleanup, onMount } from "solid-js";

interface ToolbarProps {
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onAddText: () => void;
  onAddShape: (kind: "rect" | "ellipse" | "triangle" | "diamond" | "star" | "arrow" | "callout") => void;
  onPickImage: () => void;
  onAddQrCode: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onLayer: (direction: "front" | "back") => void;
  onUndo: () => void;
  onRedo: () => void;
}

const toolClass =
  "inline-flex h-9 items-center gap-2 rounded-xl border border-transparent px-2.5 text-xs font-semibold text-cocoa-600 transition-colors hover:bg-cream-200 hover:text-cocoa-900 disabled:opacity-40";

const iconClass =
  "inline-flex h-9 w-9 items-center justify-center rounded-xl border border-transparent text-sm font-semibold text-cocoa-600 transition-colors hover:bg-cream-200 hover:text-cocoa-900 disabled:opacity-40";

const shapes = [
  { kind: "rect", label: "Rectangle" },
  { kind: "ellipse", label: "Ellipse" },
  { kind: "triangle", label: "Triangle" },
  { kind: "diamond", label: "Diamond" },
  { kind: "star", label: "Star" },
  { kind: "arrow", label: "Arrow" },
  { kind: "callout", label: "Callout" },
] as const;

function ShapeIcon(props: { kind: (typeof shapes)[number]["kind"] }) {
  return <svg viewBox="0 0 24 24" class="shape-menu-icon" aria-hidden="true">
    {props.kind === "rect" && <rect x="3.5" y="5" width="17" height="14" rx="1.5" />}
    {props.kind === "ellipse" && <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />}
    {props.kind === "triangle" && <polygon points="12,4 21,20 3,20" />}
    {props.kind === "diamond" && <polygon points="12,3 21,12 12,21 3,12" />}
    {props.kind === "star" && <path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.5 6.3-.9L12 3Z" />}
    {props.kind === "arrow" && <path d="M3 10h11V5l7 7-7 7v-5H3z" />}
    {props.kind === "callout" && <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />}
  </svg>;
}

export function Toolbar(props: ToolbarProps) {
  let shapeDetails: HTMLDetailsElement | undefined;
  let shapePopup: HTMLDivElement | undefined;

  const positionShapePopup = () => {
    if (!shapeDetails?.open || !shapePopup) return;
    const bounds = shapeDetails.querySelector("summary")?.getBoundingClientRect();
    if (!bounds) return;
    shapePopup.style.top = `${Math.min(bounds.bottom + 5, window.innerHeight - shapePopup.offsetHeight - 8)}px`;
    shapePopup.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - shapePopup.offsetWidth - 8))}px`;
  };

  const closeOnOutsidePointer = (event: PointerEvent) => {
    if (shapeDetails?.open && !shapeDetails.contains(event.target as Node)) shapeDetails.open = false;
  };
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && shapeDetails?.open) {
      shapeDetails.open = false;
      shapeDetails.querySelector("summary")?.focus();
    }
  };
  onMount(() => {
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", closeOnOutsidePointer);
    document.removeEventListener("keydown", closeOnEscape);
  });

  return (
    <div class="toolbar flex h-12 items-center gap-2 overflow-x-auto border-b border-cream-300 bg-cream-50/90 px-3">
      <div class="tool-group flex items-center gap-0.5">
        <button class={`tool ${toolClass}`} title="Add text (T)" onClick={props.onAddText}>
          <span class="font-mono text-[13px] font-bold text-coral-600">T</span>
          <span>Text</span>
        </button>
        <details class="shape-menu-root" ref={shapeDetails} onToggle={positionShapePopup}>
          <summary class={`tool shape-tool ${toolClass}`} title="Add a shape" aria-label="Add a shape">
            <span class="shape-tool-icon" aria-hidden="true"><ShapeIcon kind="rect" /></span>
            <span>Shape</span>
            <span class="shape-tool-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="shape-menu-popup" role="menu" ref={shapePopup}>
            <For each={shapes}>{(shape) => <button type="button" role="menuitem" class="shape-menu-item" onClick={() => {
              props.onAddShape(shape.kind);
              if (shapeDetails) shapeDetails.open = false;
            }}>
              <ShapeIcon kind={shape.kind} />
              <span>{shape.label}</span>
            </button>}</For>
          </div>
        </details>
        <button class={`tool ${toolClass}`} title="Upload image" onClick={props.onPickImage}>
          <span class="text-[13px]">▧</span>
          <span>Image</span>
        </button>
        <button class={`tool ${toolClass}`} title="Add a parameterized QR code" onClick={props.onAddQrCode}><span class="text-[13px]">▦</span><span>QR code</span></button>
      </div>
      <div class="tool-divider h-5 w-px shrink-0 bg-cream-300" />
      <div class="tool-group flex items-center gap-0.5">
        <button class={`tool icon-only ${iconClass}`} title="Undo (Ctrl+Z)" disabled={!props.canUndo} onClick={props.onUndo}>
          ↶
        </button>
        <button class={`tool icon-only ${iconClass}`} title="Redo (Ctrl+Shift+Z)" disabled={!props.canRedo} onClick={props.onRedo}>
          ↷
        </button>
      </div>
      <div class="tool-divider h-5 w-px shrink-0 bg-cream-300" />
      <div class="tool-group flex items-center gap-0.5">
        <button
          class={`tool icon-only ${iconClass}`}
          title="Bring to front"
          disabled={!props.hasSelection}
          onClick={() => props.onLayer("front")}
        >
          ⇧
        </button>
        <button
          class={`tool icon-only ${iconClass}`}
          title="Send to back"
          disabled={!props.hasSelection}
          onClick={() => props.onLayer("back")}
        >
          ⇩
        </button>
        <button
          class={`tool icon-only ${iconClass}`}
          title="Duplicate (Ctrl+D)"
          disabled={!props.hasSelection}
          onClick={props.onDuplicate}
        >
          ⧉
        </button>
        <button
          class={`tool icon-only ${iconClass} hover:bg-blush-200/70 hover:text-red-700`}
          title="Delete (Del)"
          disabled={!props.hasSelection}
          onClick={props.onDelete}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
