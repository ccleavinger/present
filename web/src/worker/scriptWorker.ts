/// <reference lib="webworker" />
import type { Slide, SlideElement } from "../types";

declare const self: DedicatedWorkerGlobalScope;

interface ScriptRequest {
  id: string;
  source: string;
  slide: Slide;
  selection: string[];
}

interface MutationPatch {
  op: "update" | "add" | "remove" | "slide";
  id?: string;
  patch?: Partial<SlideElement> | Partial<Slide>;
}

const deny = (name: string) => () => {
  throw new Error(`${name} is disabled inside the scripting sandbox.`);
};

for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"]) {
  try {
    Object.defineProperty(self, name, {
      value: deny(name),
      configurable: false,
      writable: false,
    });
  } catch {
    // Some engines expose non-configurable globals. The worker still has no
    // DOM or storage, and the served worker also carries `connect-src 'none'`.
  }
}

function elementId(): string {
  return `el_${Math.random().toString(36).slice(2, 10)}`;
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

self.onmessage = async (event: MessageEvent<ScriptRequest>) => {
  const { id, source, slide: input, selection } = event.data;
  const slide: Slide = structuredClone(input);
  const patches: MutationPatch[] = [];
  const logs: string[] = [];

  const log = (...args: unknown[]) => {
    logs.push(args.map(describe).join(" "));
    if (logs.length > 300) logs.shift();
  };

  const requireElement = (elementId: string): SlideElement => {
    const element = slide.elements[elementId];
    if (!element) throw new Error(`Unknown element '${elementId}'`);
    return element;
  };

  const api = {
    selection: [...selection],
    version: "1.0",
    log,
    getSlide: () => structuredClone(slide),
    getElement: (elementId: string) => structuredClone(requireElement(elementId)),
    updateElement: (elementId: string, patch: Partial<SlideElement>) => {
      const element = requireElement(elementId);
      const next: SlideElement = { ...element, ...patch, id: element.id };
      if (patch.style) {
        next.style = { ...element.style, ...patch.style };
      }
      slide.elements[elementId] = next;
      patches.push({ op: "update", id: elementId, patch });
      return structuredClone(next);
    },
    setText: (elementId: string, text: string) => {
      const element = requireElement(elementId);
      element.text = text;
      patches.push({ op: "update", id: elementId, patch: { text } });
      return structuredClone(element);
    },
    addElement: (element: SlideElement) => {
      const next: SlideElement = {
        ...element,
        rotation: element.rotation ?? 0,
        z:
          element.z ??
          Object.values(slide.elements).reduce((max, el) => Math.max(max, el.z ?? 0), 0) + 1,
        style: element.style ?? {},
        id: element.id || elementId(),
      };
      slide.elements[next.id] = next;
      patches.push({ op: "add", id: next.id, patch: next });
      return structuredClone(next);
    },
    removeElement: (elementId: string) => {
      requireElement(elementId);
      delete slide.elements[elementId];
      patches.push({ op: "remove", id: elementId });
    },
    patchSlide: (patch: Partial<Slide>) => {
      if (patch.elements) {
        slide.elements = { ...slide.elements, ...patch.elements };
      }
      const { elements: _ignored, ...rest } = patch;
      Object.assign(slide, rest);
      patches.push({ op: "slide", patch });
    },
    /** Small helper for batch restyling. */
    styleSelection: (patch: Record<string, unknown>) => {
      for (const elementId of selection) {
        const element = slide.elements[elementId];
        if (!element) continue;
        element.style = { ...element.style, ...patch };
        patches.push({ op: "update", id: elementId, patch: { style: patch } });
      }
      return selection.length;
    },
  };

  const consoleShim = {
    log,
    info: log,
    warn: log,
    error: log,
    debug: log,
  };

  try {
    // The user program runs inside this dedicated worker only. There is no
    // DOM and no storage access; network primitives were replaced above.
    const runner = new Function(
      "api",
      "console",
      `"use strict";\n${source}\n//# sourceURL=present-user-script.js`,
    );
    const returned = runner(api, consoleShim);
    if (returned && typeof returned.then === "function") {
      await returned;
    }
    self.postMessage({ id, type: "done", slide, patches, logs });
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
      logs,
    });
  }
};
