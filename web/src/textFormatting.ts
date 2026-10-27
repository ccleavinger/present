import type { SlideElement } from "./types";

export const TEXT_FONTS = [
  { name: "Default", value: "" },
  { name: "Sans serif (system)", value: "sans-serif" },
  { name: "Serif (system)", value: "serif" },
  { name: "Monospace (system)", value: "monospace" },
  ...["Arial", "Verdana", "Trebuchet MS", "Georgia", "Times New Roman", "Courier New", "Inter"].map((font) => ({ name: font, value: font })),
];

export function isBold(element: SlideElement): boolean {
  const weight = element.style.fontWeight;
  return weight === "bold" || Number(weight ?? 400) >= 600;
}

export function isItalic(element: SlideElement): boolean { return element.style.fontStyle === "italic"; }

export const TEXT_ALIGNMENTS = ["left", "center", "right"] as const;
export function textAlignment(element: SlideElement): (typeof TEXT_ALIGNMENTS)[number] {
  return element.style.align === "center" || element.style.align === "right" ? element.style.align : "left";
}
