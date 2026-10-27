import type { JSX } from "solid-js";
import type { Slide, SlideElement } from "./types";

let counter = 0;

export function newElementId(prefix = "el"): string {
  counter += 1;
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}${counter}`;
}

export function nextZ(slide: Slide): number {
  return (
    Object.values(slide.elements).reduce((max, el) => Math.max(max, el.z ?? 0), 0) + 1
  );
}

export function createTextElement(x: number, y: number, text = "New text"): SlideElement {
  return {
    id: newElementId(),
    type: "text",
    x,
    y,
    w: 720,
    h: 120,
    rotation: 0,
    z: 0,
    text,
    style: {
      fontSize: 64,
      fontWeight: 600,
      color: "#3d2a20",
      align: "left",
      lineHeight: 1.2,
    },
  };
}

export function createShapeElement(
  kind: "rect" | "ellipse" | "triangle" | "diamond" | "star" | "arrow" | "callout",
  x: number,
  y: number,
): SlideElement {
  return {
    id: newElementId(),
    type: kind,
    x,
    y,
    w: 360,
    h: 240,
    rotation: 0,
    z: 0,
    fill: "#ffb9a5",
    style: {},
    shapeParams: kind === "rect" ? { cornerRadius: 0 }
      : kind === "star" ? { points: 5, innerRadius: 22 }
        : kind === "arrow" ? { shaftWidth: 28, headLength: 32, headWidth: 60 }
          : kind === "callout" ? { tailPosition: 25, tailWidth: 24, tailLength: 18 }
            : {},
  };
}

export function createImageElement(
  url: string,
  x: number,
  y: number,
  width: number,
  height: number,
): SlideElement {
  return {
    id: newElementId(),
    type: "image",
    x,
    y,
    w: width,
    h: height,
    rotation: 0,
    z: 0,
    src: url,
    style: { fit: "contain" },
  };
}

export function createQrCodeElement(x: number, y: number): SlideElement {
  return {
    id: newElementId("qr"),
    type: "custom",
    customType: "qr-code",
    customProps: { text: "https://example.com", color: "#000000" },
    x, y, w: 320, h: 320, rotation: 0, z: 0, style: {}, renderData: [],
  };
}

export function fontSizeOf(element: SlideElement): number {
  return styleNumber(element.style, "fontSize", 48);
}

export function styleNumber(
  style: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = style[key];
  return typeof value === "number" ? value : Number(value) || fallback;
}

export function styleString(
  style: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = style[key];
  return typeof value === "string" ? value : fallback;
}

export function elementCss(el: SlideElement): JSX.CSSProperties {
  const css: JSX.CSSProperties = {
    position: "absolute",
    left: `${el.x}px`,
    top: `${el.y}px`,
    width: `${el.w}px`,
    height: `${el.h}px`,
    transform: `rotate(${el.rotation ?? 0}deg)`,
    "z-index": String(el.z ?? 0),
    opacity: String(el.opacity ?? 1),
    "box-sizing": "border-box",
  };
  return css;
}

export function textCss(el: SlideElement, scale = 1): JSX.CSSProperties {
  return {
    "font-size": `${styleNumber(el.style, "fontSize", 48) * scale}px`,
    "font-weight": String(styleNumber(el.style, "fontWeight", 400)),
    color: styleString(el.style, "color", "#3d2a20"),
    "text-align": styleString(el.style, "align", "left") as JSX.CSSProperties["text-align"],
    "line-height": String(styleNumber(el.style, "lineHeight", 1.25)),
    "letter-spacing":
      typeof el.style.letterSpacing === "number" ? `${el.style.letterSpacing}px` : undefined,
    "font-family": styleString(
      el.style,
      "fontFamily",
      "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
    ),
    "font-style": styleString(el.style, "fontStyle", "normal"),
    "text-decoration": styleString(el.style, "textDecoration", "none"),
    "white-space": "pre-wrap",
    "word-break": "break-word",
    "overflow-wrap": "anywhere",
    width: "100%",
  };
}

export function measureTextHeight(node: HTMLElement): number {
  const style = window.getComputedStyle(node);
  const fontSize = Number.parseFloat(style.fontSize) || 48;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2;
  return Math.ceil(Math.max(node.scrollHeight, lineHeight));
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

export function cloneSlide(slide: Slide): Slide {
  return structuredClone(slide);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
