interface ToolbarProps {
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onAddText: () => void;
  onAddRect: () => void;
  onAddEllipse: () => void;
  onPickImage: () => void;
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

export function Toolbar(props: ToolbarProps) {
  return (
    <div class="toolbar flex h-12 items-center gap-2 overflow-x-auto border-b border-cream-300 bg-cream-50/90 px-3">
      <div class="tool-group flex items-center gap-0.5">
        <button class={`tool ${toolClass}`} title="Add text (T)" onClick={props.onAddText}>
          <span class="font-mono text-[13px] font-bold text-coral-600">T</span>
          <span>Text</span>
        </button>
        <button class={`tool ${toolClass}`} title="Add rectangle (R)" onClick={props.onAddRect}>
          <span class="text-[13px]">▭</span>
          <span>Rect</span>
        </button>
        <button class={`tool ${toolClass}`} title="Add ellipse (O)" onClick={props.onAddEllipse}>
          <span class="text-[13px]">◯</span>
          <span>Ellipse</span>
        </button>
        <button class={`tool ${toolClass}`} title="Upload image" onClick={props.onPickImage}>
          <span class="text-[13px]">▧</span>
          <span>Image</span>
        </button>
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
