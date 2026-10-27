import type { JSX } from "solid-js";
import type { ImageCrop } from "./types";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function normalizeImageCrop(crop?: ImageCrop): ImageCrop | undefined {
  if (!crop || ![crop.x, crop.y, crop.w, crop.h].every(Number.isFinite) || crop.w <= 0 || crop.h <= 0) return;
  const w = clamp(crop.w, 0.001, 1), h = clamp(crop.h, 0.001, 1);
  return { x: clamp(crop.x, 0, 1 - w), y: clamp(crop.y, 0, 1 - h), w, h };
}

export function coverImageCrop(imageWidth: number, imageHeight: number, frameWidth: number, frameHeight: number): ImageCrop {
  const imageRatio = imageWidth / imageHeight, frameRatio = frameWidth / frameHeight;
  const w = Math.min(1, frameRatio / imageRatio), h = Math.min(1, imageRatio / frameRatio);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

export function zoomImageCrop(base: ImageCrop, zoom: number, centerX: number, centerY: number): ImageCrop {
  const w = base.w / Math.max(1, zoom), h = base.h / Math.max(1, zoom);
  return { x: clamp(centerX - w / 2, 0, 1 - w), y: clamp(centerY - h / 2, 0, 1 - h), w, h };
}

export function croppedImageCss(crop: ImageCrop): JSX.CSSProperties {
  return {
    position: "absolute", "max-width": "none", "object-fit": "fill",
    width: `${100 / crop.w}%`, height: `${100 / crop.h}%`,
    left: `${-100 * crop.x / crop.w}%`, top: `${-100 * crop.y / crop.h}%`,
  };
}
