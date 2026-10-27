import { expect, test } from "bun:test";
import { coverImageCrop, normalizeImageCrop, zoomImageCrop } from "../src/imageCrop";

test("cropping a wide image into a square starts centered without stretching", () => {
  const crop = coverImageCrop(2000, 1000, 400, 400);
  expect(crop).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
  expect(crop.w * 2000 / (crop.h * 1000)).toBe(1);
});

test("zoom and pan keep the crop inside the original image and preserve the frame aspect", () => {
  const crop = zoomImageCrop(coverImageCrop(2000, 1000, 400, 400), 2, 100, -100);
  expect(crop).toEqual({ x: 0.75, y: 0, w: 0.25, h: 0.5 });
  expect(crop.x + crop.w).toBeLessThanOrEqual(1);
  expect(crop.y + crop.h).toBeLessThanOrEqual(1);
  expect(crop.w * 2000 / (crop.h * 1000)).toBe(1);
});

test("invalid or oversized stored crop data cannot create an empty or off-image viewport", () => {
  expect(normalizeImageCrop({ x: NaN, y: 0, w: 1, h: 1 })).toBeUndefined();
  expect(normalizeImageCrop({ x: 0, y: 0, w: 0, h: 1 })).toBeUndefined();
  expect(normalizeImageCrop({ x: 4, y: -2, w: 2, h: 0.5 })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
});
