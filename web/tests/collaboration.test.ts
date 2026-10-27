import { expect, test } from "bun:test";
import { changedElementIds, equalValue, mergeRemoteSlide, contextualizeSlide, collaboratorColor } from "../src/collaboration";
import type { Slide } from "../src/types";
const initial = (): Slide => ({ id: "s1", version: 1, name: "Original", background: "white", elements: {
  a: { id: "a", type: "rect", x: 10, y: 10, w: 100, h: 100, z: 1, rotation: 0, style: {} },
  b: { id: "b", type: "text", text: "Hello", x: 200, y: 20, w: 100, h: 100, z: 2, rotation: 0, style: {} },
} });

test("remote changes merge with a different local object without creating extra dirty objects", () => {
  const base = initial(), local = initial(), remote = initial();
  local.elements.a.x = 70; remote.elements.b.text = "Remote text";
  const result = mergeRemoteSlide(base, local, remote);
  expect(result.slide.elements.a.x).toBe(70);
  expect(result.slide.elements.b.text).toBe("Remote text");
  expect(changedElementIds(result.base, result.slide)).toEqual(["a"]);
  expect(result.conflicts).toEqual([]);
});

test("a conflicting object retains its original base and the local draft", () => {
  const base = initial(), local = initial(), remote = initial();
  local.elements.a.x = 70; remote.elements.a.x = 80;
  const result = mergeRemoteSlide(base, local, remote);
  expect(result.conflicts).toEqual(["a"]);
  expect(result.slide.elements.a.x).toBe(70);
  expect(result.base.elements.a.x).toBe(10);
});

test("an acknowledgement keeps edits made during the request and accepts remote additions", () => {
  const sent = initial(), current = initial(), response = initial();
  current.elements.b.text = "Still typing";
  response.elements.c = { ...response.elements.a, id: "c" };
  const result = mergeRemoteSlide(sent, current, response);
  expect(result.slide.elements.b.text).toBe("Still typing");
  expect(result.slide.elements.c.id).toBe("c");
  expect(changedElementIds(result.base, result.slide)).toEqual(["b"]);
});

test("remote deletions and local deletions stay independent", () => {
  const base = initial(), local = initial(), remote = initial();
  delete local.elements.a; delete remote.elements.b;
  const result = mergeRemoteSlide(base, local, remote);
  expect(Object.keys(result.slide.elements)).toEqual([]);
  expect(changedElementIds(result.base, result.slide)).toEqual(["a"]);
});

test("JSON property order does not create a new edit", () => {
  expect(equalValue({ style: { fontSize: 34, color: "red" } }, { style: { color: "red", fontSize: 34 } })).toBe(true);
  expect(equalValue({ x: 1 }, { x: 2 })).toBe(false);
});

test("remote images use the receiving identity and cursors retain a stable user color", () => {
  const slide = initial();
  slide.elements.a.src = "/api/decks/deck/slides/s1/assets/photo.png?demoUserId=sender&branch=old";
  const localized = contextualizeSlide(slide, "deck", "feature/room", "receiver");
  const url = new URL(localized.elements.a.src!, "http://present.test");
  expect(url.searchParams.get("demoUserId")).toBe("receiver");
  expect(url.searchParams.get("branch")).toBe("feature/room");
  expect(collaboratorColor("receiver")).toBe(collaboratorColor("receiver"));
});
