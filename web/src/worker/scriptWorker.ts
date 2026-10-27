/// <reference lib="webworker" />
import type { AnimationEffect, CustomDrawCommand, Slide, SlideAnimation, SlideElement } from "../types";
import qrCode from "qrcode-generator";

declare const self: DedicatedWorkerGlobalScope;

interface ScriptRequest {
  id: string;
  mode?: "edit-slide" | "generate-template" | "render-custom-object";
  source: string;
  slide?: Slide;
  selection?: string[];
  customObjectTypes?: Array<{ id: string; name: string; generator: string; inputs?: Array<{ id: string; label: string; type: string; defaultValue?: unknown }> }>;
  props?: Record<string, unknown>;
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

function safeDrawData(value: unknown): CustomDrawCommand[] {
  if (!Array.isArray(value) || value.length > 4000) throw new Error("Custom object generator returned invalid drawing data.");
  const paint = (color: unknown) => typeof color === "string" && color.length <= 64 && /^(#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d.% ,]+\)|hsla?\([\d.% ,deg]+\)|none|transparent|currentcolor)$/i.test(color) ? color : undefined;
  return value.map((command: any) => {
    if (!command || !["rect", "circle", "line", "text"].includes(command.type)) throw new Error("Custom object generator returned an unsupported drawing command.");
    for (const key of ["x", "y", "w", "h"]) if (!Number.isFinite(command[key]) || Math.abs(command[key]) > 100000) throw new Error("Custom object generator returned invalid geometry.");
    return { type: command.type, x: command.x, y: command.y, w: command.w, h: command.h, fill: paint(command.fill), stroke: paint(command.stroke), strokeWidth: Number.isFinite(command.strokeWidth) ? Math.max(0, Math.min(command.strokeWidth, 100)) : undefined, text: typeof command.text === "string" ? command.text.slice(0, 4096) : undefined };
  });
}

function makeQrCode(value: unknown, colorValue: unknown): CustomDrawCommand[] {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > 256) throw new Error("QR code text must contain between 1 and 256 characters.");
  const color = typeof colorValue === "string" && /^(#[\da-f]{6}|#[\da-f]{3})$/i.test(colorValue) ? colorValue : "#000000";
  const code = qrCode(0, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const unit = 900 / count;
  const commands: CustomDrawCommand[] = [{ type: "rect", x: 0, y: 0, w: 1000, h: 1000, fill: "#ffffff" }];
  for (let row = 0; row < count; row += 1) for (let col = 0; col < count; col += 1) {
    if (code.isDark(row, col)) commands.push({ type: "rect", x: 50 + col * unit, y: 50 + row * unit, w: unit + 0.1, h: unit + 0.1, fill: color });
  }
  return safeDrawData(commands);
}

const drawApi = { qrCode: makeQrCode };

self.onmessage = async (event: MessageEvent<ScriptRequest>) => {
  const { id, source } = event.data;
  const { mode = "edit-slide" } = event.data;
  if (mode === "render-custom-object") {
    try {
      const render = new Function("props", "api", `"use strict";\n${source}\n//# sourceURL=present-custom-object.js`);
      self.postMessage({ id, type: "generated", generated: safeDrawData(render(event.data.props ?? {}, drawApi)), logs: [] });
    } catch (error) {
      self.postMessage({ id, type: "error", error: error instanceof Error ? error.message : String(error), logs: [] });
    }
    return;
  }
  if (mode === "generate-template") {
    const logs: string[] = [];
    const log = (...args: unknown[]) => { logs.push(args.map(describe).join(" ")); if (logs.length > 300) logs.shift(); };
    const api = {
      version: "1.3",
      log,
      createSlide: (name: string, background = "#fff6e9"): Slide => ({ version: 1, id: elementId(), name, background, elements: {} }),
      addElement: (slide: Slide, element: SlideElement): SlideElement => {
        const id = element.id || elementId();
        const next = { ...element, id, rotation: element.rotation ?? 0, z: element.z ?? Object.keys(slide.elements).length, style: element.style ?? {} };
        slide.elements[id] = next;
        return next;
      },
      addObject: (slide: Slide, customType: string, x: number, y: number, w: number, h: number, customProps: Record<string, unknown> = {}): SlideElement => {
        return api.addElement(slide, { type: "custom", customType, customProps, x, y, w, h, rotation: 0, z: Object.keys(slide.elements).length, style: {} } as SlideElement);
      },
      addAnimation: (slide: Slide, target: string | SlideElement, effect: AnimationEffect, options: Partial<Pick<SlideAnimation, "durationMs" | "delayMs" | "trigger" | "direction">> = {}): SlideAnimation => {
        const targetId = typeof target === "string" ? target : target.id;
        if (!slide.elements[targetId]) throw new Error(`Unknown animation target '${targetId}'`);
        if (!["fade", "rise", "zoom", "pulse", "move", "exit-fade", "exit-rise"].includes(effect)) throw new Error(`Unsupported animation effect '${effect}'`);
        const animation: SlideAnimation = { id: elementId(), elementId: targetId, effect, order: slide.animations?.length ?? 0, durationMs: Math.max(100, Math.min(10000, options.durationMs ?? 500)), delayMs: Math.max(0, Math.min(10000, options.delayMs ?? 0)), trigger: options.trigger ?? "click", direction: options.direction ?? "up" };
        slide.animations = [...(slide.animations ?? []), animation];
        return animation;
      },
      qrCode: makeQrCode,
    };
    try {
      const runner = new Function("api", "console", `"use strict";\n${source}\n//# sourceURL=present-template-generator.js`);
      const generated = await runner(api, { log, info: log, warn: log, error: log, debug: log });
      if (!generated || typeof generated !== "object") throw new Error("Generator must return an object with initialSlides and slideOptions.");
      const value = generated as { initialSlides?: Slide[]; slideOptions?: Array<{ id?: string; name: string; slides: Slide[] }>; customObjectTypes?: Array<{ id: string; name: string; generator: string; inputs?: Array<{ id: string; label: string; type: string; defaultValue?: unknown }> }> };
      if (!Array.isArray(value.initialSlides) || value.initialSlides.length > 100 || !Array.isArray(value.slideOptions) || value.slideOptions.length > 10 || value.slideOptions.some((option) => !Array.isArray(option.slides) || option.slides.length < 1 || option.slides.length > 20)) throw new Error("Generator must return up to 100 initial slides and no more than 10 options, each with 1–20 slides.");
      value.slideOptions.forEach((option, index) => {
        option.id ||= `option_${index + 1}`;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(option.id) || !option.name?.trim()) throw new Error("Every slide option needs a valid ID and name.");
      });
      if (value.customObjectTypes?.some((definition) => !/^[A-Za-z0-9_-]{1,128}$/.test(definition.id) || !definition.name?.trim() || !definition.generator?.trim() || definition.inputs?.some((input) => !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || !input.label?.trim() || !["text", "number", "color", "boolean"].includes((input as any).type)))) throw new Error("A custom object definition has an invalid ID, name, generator, or input field.");
      const definitions = new Map((event.data.customObjectTypes ?? value.customObjectTypes ?? []).map((definition) => [definition.id, definition]));
      const slides = [...value.initialSlides, ...value.slideOptions.flatMap((option) => option.slides ?? [])];
      if (slides.length > 300 || slides.some((slide) => !slide?.elements || Object.keys(slide.elements).length > 2000)) throw new Error("Generator returned too many slides or objects.");
      let drawBudget = 0;
      for (const slide of slides) {
        if (!slide || typeof slide.name !== "string" || !slide.elements || typeof slide.elements !== "object") throw new Error("Generator returned an invalid slide.");
        for (const element of Object.values(slide.elements)) {
          if (element.type !== "custom") continue;
          const typeId = String(element.customType ?? "");
          const definition = definitions.get(typeId);
          if (!definition) throw new Error(`Missing custom object generator: ${typeId}`);
          const defaults = Object.fromEntries((definition.inputs ?? []).map((input) => [input.id, input.defaultValue]));
          element.customProps = { ...defaults, ...(element.customProps ?? {}) };
          const render = new Function("props", "api", `"use strict";\n${definition.generator}\n//# sourceURL=present-custom-object.js`);
          element.renderData = safeDrawData(render(element.customProps, drawApi));
          drawBudget += element.renderData.length;
          if (drawBudget > 50000) throw new Error("Template output exceeds the custom object drawing limit.");
        }
      }
      self.postMessage({ id, type: "generated", generated: value, logs });
    } catch (error) {
      self.postMessage({ id, type: "error", error: error instanceof Error ? error.message : String(error), logs });
    }
    return;
  }
  const { slide: input, selection = [] } = event.data;
  if (!input) { self.postMessage({ id, type: "error", error: "Missing slide input", logs: [] }); return; }
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

  const customTypes = new Map((event.data.customObjectTypes ?? []).map((definition) => [definition.id, definition]));

  const api = {
    selection: [...selection],
    version: "1.3",
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
    addObject: (definitionId: string, x: number, y: number, w: number, h: number, customProps: Record<string, unknown> = {}) => {
      const definition = customTypes.get(definitionId);
      if (!definition) throw new Error(`Unknown custom object type '${definitionId}'`);
      const defaults = Object.fromEntries((definition.inputs ?? []).map((input) => [input.id, input.defaultValue]));
      const props = { ...defaults, ...customProps };
      const render = new Function("props", "api", `"use strict";\n${definition.generator}\n//# sourceURL=present-custom-object.js`);
      const element = api.addElement({ type: "custom", customType: definitionId, customProps: props, renderData: safeDrawData(render(props, drawApi)), x, y, w, h, rotation: 0, z: 0, style: {} } as SlideElement);
      return element;
    },
    addAnimation: (target: string | SlideElement, effect: AnimationEffect, options: Partial<Pick<SlideAnimation, "durationMs" | "delayMs" | "trigger" | "direction">> = {}) => {
      const element = typeof target === "string" ? requireElement(target) : requireElement(target.id);
      if (!["fade", "rise", "zoom", "pulse", "move", "exit-fade", "exit-rise"].includes(effect)) throw new Error(`Unsupported animation effect '${effect}'`);
      const animation: SlideAnimation = { id: elementId(), elementId: element.id, effect, order: slide.animations?.length ?? 0, durationMs: Math.max(100, Math.min(10000, options.durationMs ?? 500)), delayMs: Math.max(0, Math.min(10000, options.delayMs ?? 0)), trigger: options.trigger ?? "click", direction: options.direction ?? "up" };
      slide.animations = [...(slide.animations ?? []), animation];
      patches.push({ op: "slide", patch: { animations: slide.animations } });
      return structuredClone(animation);
    },
    updateAnimation: (animationId: string, patch: Partial<Pick<SlideAnimation, "effect" | "order" | "durationMs" | "delayMs" | "trigger" | "direction">>) => {
      const animations = [...(slide.animations ?? [])];
      const index = animations.findIndex((item) => item.id === animationId);
      if (index < 0) throw new Error(`Unknown animation '${animationId}'`);
      if (patch.effect && !["fade", "rise", "zoom", "pulse", "move", "exit-fade", "exit-rise"].includes(patch.effect)) throw new Error(`Unsupported animation effect '${patch.effect}'`);
      animations[index] = { ...animations[index], ...patch, durationMs: patch.durationMs === undefined ? animations[index].durationMs : Math.max(100, Math.min(10000, patch.durationMs)), delayMs: patch.delayMs === undefined ? animations[index].delayMs : Math.max(0, Math.min(10000, patch.delayMs)) };
      slide.animations = animations;
      patches.push({ op: "slide", patch: { animations } });
      return structuredClone(animations[index]);
    },
    removeAnimation: (animationId: string) => {
      const animations = slide.animations ?? [];
      if (!animations.some((item) => item.id === animationId)) throw new Error(`Unknown animation '${animationId}'`);
      slide.animations = animations.filter((item) => item.id !== animationId).map((item, order) => ({ ...item, order }));
      patches.push({ op: "slide", patch: { animations: slide.animations } });
    },
    removeElement: (elementId: string) => {
      requireElement(elementId);
      delete slide.elements[elementId];
      patches.push({ op: "remove", id: elementId });
      const animations = slide.animations ?? [];
      if (animations.some((item) => item.elementId === elementId)) {
        slide.animations = animations.filter((item) => item.elementId !== elementId).map((item, order) => ({ ...item, order }));
        patches.push({ op: "slide", patch: { animations: slide.animations } });
      }
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
