import { For, Show, createEffect } from "solid-js";
import type { SlideElement } from "../types";
import { elementCss, styleString, textCss } from "../elements";

interface ElementViewProps {
  element: SlideElement;
  editing?: boolean;
  interactive?: boolean;
  onTextCommit?: (text: string) => void;
}

/** Renders one element. Used by the live stage, thumbnails, and merge previews. */
export function ElementView(props: ElementViewProps) {
  let textRef: HTMLDivElement | undefined;
  const textStyle = () => textCss(props.element);

  createEffect(() => {
    if (!props.editing || !textRef) return;
    const node = textRef;
    queueMicrotask(() => {
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  });

  const commit = (event: FocusEvent & { currentTarget: HTMLElement }) => {
    props.onTextCommit?.(event.currentTarget.innerText);
  };

  return (
    <div
      class={`slide-element kind-${props.element.type}`}
      data-element-id={props.element.id}
      style={elementCss(props.element)}
    >
      <Show when={props.element.type === "text"}>
        <div
          class="text-box"
          classList={{ editing: props.editing }}
          style={textStyle()}
          contentEditable={props.editing ? true : undefined}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
              event.preventDefault();
              (event.currentTarget as HTMLElement).blur();
            }
            event.stopPropagation();
          }}
          ref={(node) => {
            textRef = node;
          }}
        >
          {props.element.text ?? ""}
        </div>
      </Show>

      <Show when={props.element.type === "rect" || props.element.type === "ellipse"}>
        <div
          class="shape-box"
          style={{
            background: props.element.fill ?? "transparent",
            "border-radius": props.element.type === "ellipse" ? "50%" : "0",
            border: props.element.stroke
              ? `${props.element.strokeWidth ?? 2}px solid ${props.element.stroke}`
              : undefined,
            width: "100%",
            height: "100%",
          }}
        />
      </Show>

      <Show when={props.element.type === "image"}>
        <img
          class="image-box"
          src={props.element.src ?? ""}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            "object-fit": styleString(props.element.style, "fit", "cover") as
              | "cover"
              | "contain"
              | "fill"
              | "none"
              | "scale-down",
            "border-radius":
              typeof props.element.style.radius === "number"
                ? `${props.element.style.radius}px`
                : undefined,
          }}
        />
      </Show>

      <Show when={props.element.type === "line"}>
        <div
          style={{
            width: "100%",
            height: `${Math.max(2, props.element.strokeWidth ?? 2)}px`,
            background: props.element.stroke ?? props.element.fill ?? "#3d2a20",
            "margin-top": `${props.element.h / 2}px`,
          }}
        />
      </Show>
    </div>
  );
}

/** Non-interactive slide surface for thumbnails and merge previews. */
export function StaticSlide(props: { slide: { background: string; elements: Record<string, SlideElement> }; class?: string }) {
  const ordered = () => Object.values(props.slide.elements).sort((a, b) => a.z - b.z);
  return (
    <div
      class={`static-slide ${props.class ?? ""}`}
      style={{
        background: props.slide.background,
        position: "absolute",
        inset: "0",
        overflow: "hidden",
      }}
    >
      <For each={ordered()}>{(element) => <ElementView element={element} />}</For>
    </div>
  );
}


