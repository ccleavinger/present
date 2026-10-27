import type { Slide, SlideElement } from "./types";

export function equalValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalValue(a[key], b[key]));
}

export function changedElementIds(base: Slide | null, next: Slide): string[] {
  return [...new Set([...Object.keys(base?.elements ?? {}), ...Object.keys(next.elements)])]
    .filter((id) => !equalValue(base?.elements[id], next.elements[id]));
}

/** Keep unacknowledged local edits while accepting unrelated remote changes. */
export function mergeRemoteSlide(base: Slide, local: Slide, remote: Slide): { slide: Slide; base: Slide; conflicts: string[] } {
  const slide = structuredClone(remote), nextBase = structuredClone(remote);
  const conflicts: string[] = [];
  for (const id of changedElementIds(base, local)) {
    const before = base.elements[id], ours = local.elements[id], theirs = remote.elements[id];
    if (!equalValue(before, theirs) && !equalValue(ours, theirs)) {
      conflicts.push(id);
      if (before) nextBase.elements[id] = structuredClone(before);
      else delete nextBase.elements[id];
    }
    if (ours) slide.elements[id] = structuredClone(ours);
    else delete slide.elements[id];
  }
  for (const key of ["name", "background", "version", "animations", "transition"] as const) {
    if (equalValue(local[key], base[key])) continue;
    if (!equalValue(remote[key], base[key]) && !equalValue(remote[key], local[key])) {
      conflicts.push(key);
      Object.assign(nextBase, { [key]: base[key] });
    }
    Object.assign(slide, { [key]: local[key] });
  }
  return { slide, base: nextBase, conflicts };
}

export function contextualizeSlide(slide: Slide, deckId: string, branch: string, userId: string): Slide {
  const elements = Object.fromEntries(Object.entries(slide.elements).map(([id, element]) => {
    if (!element.src?.startsWith(`/api/decks/${deckId}/slides/`)) return [id, element];
    return [id, { ...element, src: `${element.src.split("?")[0]}?${new URLSearchParams({ branch, demoUserId: userId })}` }];
  }));
  return { ...slide, elements };
}

export function collaboratorColor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ["#b7442d", "#246bb2", "#7950b0", "#147a6d", "#a66a12", "#a33d78"][hash % 6];
}

export type LiveElement = { element: SlideElement | null; connectionId: string; sessionId?: string; seen: number };
