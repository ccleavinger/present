import { createSignal, onCleanup, onMount } from "solid-js";
import type { Slide } from "../types";
import { StaticSlide } from "./ElementView";

export function DeckCardPreview(props: { slide: Slide }) {
  const [scale, setScale] = createSignal(0.16);
  let viewport: HTMLDivElement | undefined;
  onMount(() => {
    if (!viewport) return;
    const resize = () => {
      const rect = viewport!.getBoundingClientRect();
      setScale(Math.min(rect.width / 1920, rect.height / 1080));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    resize();
    onCleanup(() => observer.disconnect());
  });
  return <div class="deck-card-preview" ref={viewport} aria-hidden="true">
    <div class="deck-card-preview-canvas" style={{ transform: `scale(${scale()})` }}>
      <StaticSlide slide={props.slide} />
    </div>
  </div>;
}
