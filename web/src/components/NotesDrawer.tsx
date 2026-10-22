import { Show } from "solid-js";

interface NotesDrawerProps {
  open: boolean;
  notes: string;
  onToggle: () => void;
  onInput: (value: string) => void;
  onFlush: () => void;
}

export function NotesDrawer(props: NotesDrawerProps) {
  return (
    <section
      class={`notes-drawer flex flex-none flex-col overflow-hidden border-t border-cream-300 bg-cream-50/95 transition-[height] duration-200 ${
        props.open ? "h-[238px]" : "h-10"
      }`}
      classList={{ open: props.open }}
    >
      <header class="notes-head flex h-10 shrink-0 items-center justify-between gap-3 px-4">
        <button
          class="notes-toggle flex items-center gap-2 text-xs font-semibold text-cocoa-700 transition-colors hover:text-cocoa-900"
          onClick={props.onToggle}
        >
          <span class="chevron w-3 text-coral-600">{props.open ? "▾" : "▸"}</span>
          Speaker notes
          <span class="hidden font-mono text-[10px] font-normal text-cocoa-500 sm:inline">
            slides/&lt;id&gt;/notes.md
          </span>
        </button>
        <div class="notes-actions flex items-center gap-2">
          <span class="text-[11px] text-cocoa-500">{props.notes.length} chars</span>
          <Show when={props.open}>
            <button class="btn ghost small" onClick={props.onFlush}>
              Flush
            </button>
          </Show>
        </div>
      </header>
      <Show when={props.open}>
        <div class="notes-body min-h-0 flex-1 px-4 pb-3">
          <textarea
            class="h-full w-full resize-none rounded-xl border border-cream-300 bg-cream-100 p-3 font-mono text-xs leading-6 text-cocoa-800 outline-none transition placeholder:text-cocoa-500/70 focus:border-coral-400 focus:bg-cream-50 focus:ring-4 focus:ring-coral-200/40"
            placeholder="Write speaker notes in Markdown…"
            value={props.notes}
            spellcheck={false}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                props.onFlush();
              }
            }}
          />
        </div>
      </Show>
    </section>
  );
}
