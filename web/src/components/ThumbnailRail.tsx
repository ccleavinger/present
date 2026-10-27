import { For, Show, createSignal } from "solid-js";
import type { DeckDetail, PresenceEvent, Slide } from "../types";
import { CANVAS_WIDTH } from "../types";
import { StaticSlide } from "./ElementView";

const THUMB_WIDTH = 176;
const THUMB_SCALE = THUMB_WIDTH / CANVAS_WIDTH;

interface ThumbnailRailProps {
  detail: DeckDetail;
  currentId: string | null;
  previews: Record<string, Slide>;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onReorder: (ids: string[]) => void;
  onDelete: (id: string) => void;
  presence: PresenceEvent[];
  readOnly?: boolean;
}

export function ThumbnailRail(props: ThumbnailRailProps) {
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [overId, setOverId] = createSignal<string | null>(null);

  const slides = () => [...props.detail.slides].sort((a, b) => a.index - b.index);

  const placeholder = (id: string, name: string, background: string): Slide => ({
    version: 1,
    id,
    name,
    background,
    elements: {},
  });

  const dropOn = (targetId: string, after: boolean) => {
    const source = dragId();
    setOverId(null);
    setDragId(null);
    if (!source || source === targetId) return;
    const ids = slides().map((s) => s.id);
    const from = ids.indexOf(source);
    const target = ids.indexOf(targetId);
    if (from < 0 || target < 0) return;
    ids.splice(from, 1);
    const to = ids.indexOf(targetId);
    ids.splice(to + (after ? 1 : 0), 0, source);
    props.onReorder(ids);
  };

  return (
    <aside class="rail flex min-h-0 flex-col border-r border-cream-300 bg-cream-100">
      <div class="rail-head flex h-11 shrink-0 items-center justify-between border-b border-cream-300 px-3">
        <span class="text-[10.5px] font-bold uppercase tracking-[0.1em] text-cocoa-500">Slides</span>
        <span class="rounded-full border border-cream-300 bg-cream-50 px-2 py-0.5 font-mono text-[10px] text-cocoa-500">
          {slides().length}
        </span>
      </div>
      <div class="rail-list flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2.5">
        <For each={slides()}>
          {(slide) => {
            const active = () => slide.id === props.currentId;
            return (
              <div
                class={`thumb group relative cursor-grab rounded-xl border p-1.5 transition active:cursor-grabbing ${
                  active()
                    ? "border-coral-400 bg-coral-200/40 shadow-[0_0_0_3px_rgba(238,125,96,0.12)]"
                    : "border-cream-300 bg-cream-50/70 hover:border-tan-300 hover:bg-cream-50"
                } ${overId() === slide.id ? "border-dashed border-coral-500" : ""}`}
                draggable={!props.readOnly}
                onDragStart={(event) => {
                  setDragId(slide.id);
                  event.dataTransfer?.setData("text/plain", slide.id);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(event) => {
                  if (dragId() && dragId() !== slide.id) {
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                    setOverId(slide.id);
                  }
                }}
                onDragLeave={() => {
                  if (overId() === slide.id) setOverId(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  dropOn(slide.id, event.clientY >= rect.top + rect.height / 2);
                }}
                onClick={() => props.onSelect(slide.id)}
              >
                <Show when={!props.readOnly}><button
                  class="thumb-delete absolute -right-1.5 -top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full border border-tan-300 bg-cream-50 text-xs font-bold text-cocoa-600 shadow-sm transition hover:border-red-300 hover:bg-red-50 hover:text-red-700"
                  title={`Delete ${slide.name}`}
                  aria-label={`Delete ${slide.name}`}
                  disabled={slides().length <= 1}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDelete(slide.id);
                  }}
                >
                  ×
                </button></Show>
                <span
                  class={`thumb-index absolute -left-1.5 -top-1.5 z-10 grid h-5 w-5 place-items-center rounded-full border font-mono text-[9px] font-bold ${
                    active()
                      ? "border-coral-500 bg-coral-400 text-cocoa-900"
                      : "border-cream-300 bg-cream-50 text-cocoa-500"
                  }`}
                >
                  {slide.index + 1}
                </span>
                <div class="thumb-shot">
                  <div
                    class="thumb-inner"
                    style={{
                      width: "1920px",
                      height: "1080px",
                      transform: `scale(${THUMB_SCALE})`,
                      "transform-origin": "top left",
                    }}
                  >
                    <StaticSlide
                      slide={
                        props.previews[slide.id] ??
                        placeholder(slide.id, slide.name, slide.background)
                      }
                    />
                  </div>
                  <div class="thumb-presence">
                    <For each={props.presence.filter((item) => item.slideId === slide.id && item.user).slice(0, 3)}>{(item) => <span class="user-avatar tiny" title={item.user!.username}>{item.user!.username.slice(0, 1).toUpperCase()}</span>}</For>
                  </div>
                </div>
                <div class="thumb-caption mt-1.5 flex items-center justify-between gap-1.5 px-0.5">
                  <span class="thumb-name truncate text-[10.5px] font-semibold text-cocoa-700">{slide.name}</span>
                  <span class="thumb-count font-mono text-[9px] text-cocoa-500">{slide.elementCount}</span>
                </div>
              </div>
            );
          }}
        </For>
        <Show when={slides().length === 0}>
          <p class="rail-empty px-1 py-6 text-center text-xs text-cocoa-500">No slides yet.</p>
        </Show>
      </div>
      <div class="rail-actions flex shrink-0 items-center justify-between gap-1 border-t border-cream-300 bg-cream-50/70 px-2 py-2">
        <Show when={!props.readOnly}><button class="btn ghost small block" onClick={props.onAdd}>
          + Slide
        </button></Show>
      </div>
    </aside>
  );
}
