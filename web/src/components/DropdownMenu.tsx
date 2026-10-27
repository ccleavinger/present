import { onCleanup, onMount, type JSX } from "solid-js";

export function DropdownMenu(props: { label: string; trigger: JSX.Element; triggerClass?: string; children: JSX.Element }) {
  let root!: HTMLDetailsElement;
  const close = () => { root.open = false; };
  const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(); };
  onMount(() => document.addEventListener("pointerdown", outside));
  onCleanup(() => document.removeEventListener("pointerdown", outside));
  return <details class="dropdown-root" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && root.open) {
      event.preventDefault(); event.stopPropagation(); close(); root.querySelector("summary")?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      root.open = true;
      const items = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')).filter((item) => item.getClientRects().length > 0);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0 ? event.key === "ArrowDown" ? 0 : items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>
    <summary class={props.triggerClass ?? "btn ghost small"} aria-label={props.label} aria-haspopup="menu">{props.trigger}</summary>
    <div class="dropdown-popup" role="menu" aria-label={props.label} onClick={(event) => {
      if ((event.target as Element).closest('button[role="menuitem"]')) close();
    }}>{props.children}</div>
  </details>;
}
