import { For, Show, createEffect, createMemo } from "solid-js";
import type { Slide, SlideAnimation, SlideElement } from "../types";
import { elementCss, measureTextHeight, styleString, textCss } from "../elements";
import { animationGroups } from "../animations";
import { croppedImageCss, normalizeImageCrop } from "../imageCrop";

function starPoints(points: number, innerRadius: number): string {
  const count = Math.min(12, Math.max(3, Math.round(points)));
  const inner = Math.min(46, Math.max(8, innerRadius));
  return Array.from({ length: count * 2 }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / count;
    const radius = index % 2 === 0 ? 48 : inner;
    return `${50 + Math.cos(angle) * radius},${50 + Math.sin(angle) * radius}`;
  }).join(" ");
}

function arrowPath(shaftWidth: number, headLength: number, headWidth: number): string {
  const shaft = Math.min(64, Math.max(8, shaftWidth)) / 2;
  const head = Math.min(92, Math.max(32, headWidth)) / 2;
  const tip = Math.min(54, Math.max(18, headLength));
  const base = 96 - tip;
  return `M4 ${50 - shaft} H${base} V${50 - head} L98 50 ${base} ${50 + head} V${50 + shaft} H4 Z`;
}

function calloutPath(tailPosition: number, tailWidth: number, tailLength: number): string {
  const tail = Math.min(45, Math.max(8, tailLength));
  const width = Math.min(36, Math.max(8, tailWidth)) / 2;
  const x = Math.min(88, Math.max(12, tailPosition));
  return `M10 8 H90 Q96 8 96 14 V72 Q96 78 90 78 H${x + width} L${x} ${78 + tail} L${x - width} 78 H10 Q4 78 4 72 V14 Q4 8 10 8 Z`;
}

interface ElementViewProps {
  element: SlideElement;
  editing?: boolean;
  interactive?: boolean;
  onTextCommit?: (text: string, height: number) => void;
  onTextInput?: (text: string, height: number) => void;
  presentationAnimation?: SlideAnimation & { revealed: boolean; pulse?: boolean; pulseDurationMs?: number; pulseDelayMs?: number };
}

/** Renders one element. Used by the live stage, thumbnails, and merge previews. */
export function ElementView(props: ElementViewProps) {
  let textRef: HTMLDivElement | undefined;
  const textStyle = () => textCss(props.element);
  const imageCrop = () => normalizeImageCrop(props.element.imageCrop);

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

  // Keep the editable DOM stable while typing; remote updates must not reset
  // the caret. Non-editing surfaces still follow every incoming text change.
  createEffect(() => {
    const text = props.element.text ?? "";
    if (textRef && !props.editing && textRef.textContent !== text) textRef.textContent = text;
  });

  const commit = (event: FocusEvent & { currentTarget: HTMLElement }) => {
    if (props.editing) {
      props.onTextCommit?.(event.currentTarget.innerText, measureTextHeight(event.currentTarget));
    }
  };

  const presentationStyle = () => {
    const style = elementCss(props.element);
    const animation = props.presentationAnimation;
    if (!animation) return style;
    const isExit = animation.effect.startsWith("exit-");
    const hidden = isExit ? animation.revealed : !animation.revealed;
    const direction = animation.direction ?? "up";
    const offset = direction === "left" ? "translateX(-54px)" : direction === "right" ? "translateX(54px)" : direction === "down" ? "translateY(54px)" : "translateY(-54px)";
    const usesOffset = animation.effect === "rise" || animation.effect === "move" || animation.effect === "exit-rise";
    const usesScale = animation.effect === "zoom";
    const transformed = `${usesOffset && hidden ? ` ${offset}` : ""}${usesScale && hidden ? isExit ? " scale(1.15)" : " scale(.82)" : ""}`;
    return {
      ...style,
      opacity: hidden ? "0" : String(props.element.opacity ?? 1),
      transform: `rotate(${props.element.rotation ?? 0}deg)${transformed}`,
      transition: `opacity ${animation.durationMs}ms ease ${animation.revealed ? animation.delayMs : 0}ms, transform ${animation.durationMs}ms cubic-bezier(.2,.75,.25,1) ${animation.revealed ? animation.delayMs : 0}ms`,
      animation: animation.pulse ? `presentation-emphasis ${animation.pulseDurationMs ?? animation.durationMs}ms ease-out ${animation.pulseDelayMs ?? 0}ms both` : undefined,
    };
  };

  return (
    <div
      class={`slide-element kind-${props.element.type} ${props.presentationAnimation?.pulse ? "presentation-pulse" : ""}`}
      data-element-id={props.element.id}
      style={presentationStyle()}
    >
      <Show when={props.element.type === "text"}>
        <div
          class="text-box"
          classList={{ editing: props.editing }}
          style={textStyle()}
          contentEditable={props.editing ? true : undefined}
          onBlur={commit}
          onInput={(event) => props.onTextInput?.(event.currentTarget.innerText, measureTextHeight(event.currentTarget))}
          onKeyDown={(event) => {
            if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
              event.preventDefault();
              (event.currentTarget as HTMLElement).blur();
            }
            event.stopPropagation();
          }}
          ref={(node) => {
            textRef = node;
            node.textContent = props.element.text ?? "";
          }}
        />
      </Show>

      <Show when={["rect", "ellipse", "triangle", "diamond", "star", "arrow", "callout"].includes(props.element.type)}>
        <div
          class="shape-box"
          style={{
            background: ["rect", "ellipse"].includes(props.element.type) ? props.element.fill ?? "transparent" : "transparent",
            "border-radius": props.element.type === "ellipse" ? "50%" : `${props.element.shapeParams?.cornerRadius ?? 0}px`,
            border: ["rect", "ellipse"].includes(props.element.type) && props.element.stroke
              ? `${props.element.strokeWidth ?? 2}px solid ${props.element.stroke}`
              : undefined,
            width: "100%",
            height: "100%",
          }}
        >
          <Show when={!["rect", "ellipse"].includes(props.element.type)}>
            <svg class="primitive-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ fill: props.element.fill ?? "#ffb9a5", stroke: props.element.stroke, "stroke-width": props.element.strokeWidth ?? 2, "stroke-linejoin": "round" }}>
              <Show when={props.element.type === "triangle"}><polygon points="50,4 97,96 3,96" /></Show>
              <Show when={props.element.type === "diamond"}><polygon points="50,3 97,50 50,97 3,50" /></Show>
              <Show when={props.element.type === "star"}><polygon points={starPoints(props.element.shapeParams?.points ?? 5, props.element.shapeParams?.innerRadius ?? 22)} /></Show>
              <Show when={props.element.type === "arrow"}><path d={arrowPath(props.element.shapeParams?.shaftWidth ?? 28, props.element.shapeParams?.headLength ?? 32, props.element.shapeParams?.headWidth ?? 60)} /></Show>
              <Show when={props.element.type === "callout"}><path d={calloutPath(props.element.shapeParams?.tailPosition ?? 25, props.element.shapeParams?.tailWidth ?? 24, props.element.shapeParams?.tailLength ?? 18)} /></Show>
            </svg>
          </Show>
        </div>
      </Show>

      <Show when={props.element.type === "image"}>
        <div class="image-viewport" style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", "border-radius": typeof props.element.style.radius === "number" ? `${props.element.style.radius}px` : undefined }}>
        <img
          class="image-box"
          src={props.element.src ?? ""}
          alt=""
          draggable={false}
          style={imageCrop() ? croppedImageCss(imageCrop()!) : {
            width: "100%",
            height: "100%",
            "object-fit": styleString(props.element.style, "fit", "contain") as
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
        </div>
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

      <Show when={props.element.type === "custom"}>
        <svg class="custom-object-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label={String(props.element.customType ?? "Custom object")}>
          <For each={props.element.renderData ?? []}>{(command) => <Show when={command.type === "rect"}>
            <rect x={command.x} y={command.y} width={command.w} height={command.h} fill={command.fill ?? "#3d2a20"} stroke={command.stroke} stroke-width={command.strokeWidth} />
          </Show>}</For>
          <For each={props.element.renderData ?? []}>{(command) => <Show when={command.type === "circle"}>
            <ellipse cx={command.x + command.w / 2} cy={command.y + command.h / 2} rx={command.w / 2} ry={command.h / 2} fill={command.fill ?? "#3d2a20"} stroke={command.stroke} stroke-width={command.strokeWidth} />
          </Show>}</For>
          <For each={props.element.renderData ?? []}>{(command) => <Show when={command.type === "line"}>
            <line x1={command.x} y1={command.y} x2={command.x + command.w} y2={command.y + command.h} stroke={command.stroke ?? command.fill ?? "#3d2a20"} stroke-width={command.strokeWidth ?? 4} />
          </Show>}</For>
          <For each={props.element.renderData ?? []}>{(command) => <Show when={command.type === "text"}>
            <text x={command.x} y={command.y + command.h} fill={command.fill ?? "#3d2a20"} font-size={String(command.h)}>{command.text ?? ""}</text>
          </Show>}</For>
        </svg>
      </Show>
    </div>
  );
}

/** Non-interactive slide surface for thumbnails and merge previews. */
export function StaticSlide(props: { slide: { background: string; elements: Record<string, SlideElement>; animations?: SlideAnimation[] }; class?: string; animationStep?: number }) {
  const ordered = () => Object.values(props.slide.elements).sort((a, b) => a.z - b.z);
  const grouped = () => animationGroups(props.slide);
  const step = () => props.animationStep ?? Number.POSITIVE_INFINITY;
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
      <For each={ordered()}>{(element) => {
        // For retains each object's component between steps. Read the step in a
        // tracked memo so its visibility updates without remounting the object.
        const presentationAnimation = createMemo(() => {
          const effects = grouped().filter((item) => item.elementId === element.id);
          const completed = effects.filter((item) => item.group < step());
          const current = completed.filter((item) => item.effect !== "pulse").at(-1)
            ?? effects.find((item) => item.effect !== "pulse");
          const pulse = completed.find((item) => item.effect === "pulse" && item.group === step() - 1);
          return current ? {
            ...current,
            revealed: current.group < step(),
            pulse: !!pulse,
            pulseDurationMs: pulse?.durationMs,
            pulseDelayMs: pulse?.delayMs,
          } : pulse ? {
            ...pulse,
            revealed: true,
            pulse: true,
            pulseDurationMs: pulse.durationMs,
            pulseDelayMs: pulse.delayMs,
          } : undefined;
        });
        return <ElementView element={element} presentationAnimation={presentationAnimation()} />;
      }}</For>
    </div>
  );
}


