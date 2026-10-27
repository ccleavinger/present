import type { JSX } from "solid-js";
import { Show } from "solid-js";

interface ModalProps {
  title: string;
  subtitle?: string;
  wide?: boolean;
  class?: string;
  bodyClass?: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
}

export function Modal(props: ModalProps) {
  return (
    <div
      class="modal-backdrop fixed inset-0 z-[5000] grid place-items-center overflow-y-auto bg-cocoa-900/40 p-4 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        class={`modal my-auto flex max-h-[90vh] w-full flex-col overflow-hidden rounded-3xl border border-cream-300 bg-cream-50 shadow-[0_8px_24px_-16px_rgba(55,38,29,0.22)] ${
          props.wide ? "wide max-w-5xl" : "max-w-xl"
        } ${props.class ?? ""}`}
        role="dialog"
        aria-modal="true"
      >
        <header class="modal-head flex items-start justify-between gap-5 border-b border-cream-300 px-5 py-4">
          <div>
            <h2 class="text-lg font-bold tracking-tight text-cocoa-900">{props.title}</h2>
            <Show when={props.subtitle}>
              <p class="mt-1 text-xs text-cocoa-500">{props.subtitle}</p>
            </Show>
          </div>
          <button class="icon-btn" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div class={`modal-body min-h-0 overflow-y-auto px-5 py-5 ${props.bodyClass ?? ""}`}>{props.children}</div>
        <Show when={props.footer}>
          <footer class="modal-foot flex items-center justify-between gap-4 border-t border-cream-300 bg-cream-100/80 px-5 py-3">
            {props.footer}
          </footer>
        </Show>
      </div>
    </div>
  );
}
