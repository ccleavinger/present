import { For, Show } from "solid-js";
import type { AnimationDirection, AnimationEffect, AnimationTrigger, CustomObjectDefinition, Slide, SlideAnimation, SlideElement } from "../types";
import { fontSizeOf, styleString } from "../elements";
import { isBold, isItalic, textAlignment, TEXT_ALIGNMENTS, TEXT_FONTS } from "../textFormatting";

interface InspectorProps {
  slide: Slide;
  selected: SlideElement | undefined;
  onElementChange: (patch: Partial<SlideElement>) => void;
  onSlideChange: (patch: Partial<Slide>) => void;
  onDelete: () => void;
  onPreview: () => void;
  onElementSelect: (id: string) => void;
  onCropImage: () => void;
  customObjectTypes?: CustomObjectDefinition[];
  onCustomInput?: (inputId: string, value: unknown) => void;
}

function NumberField(props: {
  label: string;
  value: number;
  step?: number;
  onInput: (value: number) => void;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        type="number"
        value={Number.isFinite(props.value) ? props.value : 0}
        step={props.step ?? 1}
        onInput={(event) => props.onInput(Number(event.currentTarget.value))}
      />
    </label>
  );
}

export function Inspector(props: InspectorProps) {
  const el = () => props.selected;
  const setStyle = (key: string, value: unknown) => {
    const element = el();
    if (!element) return;
    props.onElementChange({ style: { ...element.style, [key]: value } });
  };
  const setShapeParam = (key: keyof NonNullable<SlideElement["shapeParams"]>, value: number) => {
    const element = el();
    if (element) props.onElementChange({ shapeParams: { ...element.shapeParams, [key]: value } });
  };
  const animations = () => [...(props.slide.animations ?? [])].sort((a, b) => a.order - b.order);
  const addAnimation = () => {
    const element = el();
    if (!element) return;
    props.onSlideChange({ animations: [...animations(), { id: `anim_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`, elementId: element.id, effect: "fade", order: animations().length, durationMs: 500, delayMs: 0, trigger: "click" }] });
  };
  const patchAnimation = (id: string, patch: Partial<SlideAnimation>) => {
    props.onSlideChange({ animations: animations().map((item) => item.id === id ? { ...item, ...patch } : item) });
  };
  const removeAnimation = (id: string) => {
    props.onSlideChange({ animations: animations().filter((item) => item.id !== id).map((item, order) => ({ ...item, order })) });
  };
  const moveAnimation = (id: string, direction: -1 | 1) => {
    const ordered = [...animations()].sort((a, b) => a.order - b.order);
    const index = ordered.findIndex((item) => item.id === id);
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    props.onSlideChange({ animations: ordered.map((item, order) => ({ ...item, order })) });
  };

  return (
    <aside class="inspector">
      <Show
        when={el()}
        fallback={
          <>
            <section class="panel">
              <div class="panel-head">
                <h3>Slide</h3>
                <span class="muted">{Object.keys(props.slide.elements).length} elements</span>
              </div>
              <label class="field">
                <span>Name</span>
                <input
                  type="text"
                  value={props.slide.name}
                  onInput={(event) => props.onSlideChange({ name: event.currentTarget.value })}
                />
              </label>
              <label class="field color-field">
                <span>Background</span>
                <div class="color-row">
                  <input
                    type="color"
                    value={normalizeColor(props.slide.background)}
                    onInput={(event) => props.onSlideChange({ background: event.currentTarget.value })}
                  />
                  <input
                    type="text"
                    value={props.slide.background}
                    onInput={(event) => props.onSlideChange({ background: event.currentTarget.value })}
                  />
                </div>
              </label>
              <div class="dimension-note">
                Fixed canvas · 1920 × 1080
                <br />
                Coordinates stay stable at every zoom.
              </div>
            </section>
            <section class="panel hint-panel">
              <h3>Nothing selected</h3>
              <p>Select an element on the stage to edit its position, typography, and colors.</p>
            </section>
          </>
        }
      >
        {(element) => (
          <>
            <section class="panel">
              <div class="panel-head">
                <h3>Element</h3>
                <span class="type-badge">{element().type}</span>
              </div>
              <div class="field-grid">
                <NumberField label="X" value={element().x} onInput={(x) => props.onElementChange({ x })} />
                <NumberField label="Y" value={element().y} onInput={(y) => props.onElementChange({ y })} />
                <NumberField label="W" value={element().w} onInput={(w) => props.onElementChange({ w })} />
                <NumberField label="H" value={element().h} onInput={(h) => props.onElementChange({ h })} />
              </div>
              <div class="field-grid">
                <NumberField
                  label="Rotate"
                  value={element().rotation ?? 0}
                  step={0.5}
                  onInput={(rotation) => props.onElementChange({ rotation })}
                />
                <NumberField
                  label="Z"
                  value={element().z ?? 0}
                  onInput={(z) => props.onElementChange({ z })}
                />
              </div>
            </section>

            <Show when={element().type === "text"}>
              <section class="panel">
                <div class="panel-head">
                  <h3>Typography</h3>
                </div>
                <label class="field">
                  <span>Text</span>
                  <textarea
                    class="text-content-editor"
                    rows={4}
                    value={element().text ?? ""}
                    onInput={(event) => props.onElementChange({ text: event.currentTarget.value })}
                  />
                </label>
                <label class="field"><span>Font</span><select aria-label="Text font" value={styleString(element().style, "fontFamily", "")} onChange={(event) => setStyle("fontFamily", event.currentTarget.value || undefined)}>
                  <Show when={!TEXT_FONTS.some((font) => font.value === styleString(element().style, "fontFamily", ""))}><option value={styleString(element().style, "fontFamily", "")}>{styleString(element().style, "fontFamily", "")}</option></Show>
                  <For each={TEXT_FONTS}>{(font) => <option value={font.value} style={{ "font-family": font.value || "inherit" }}>{font.name}</option>}</For>
                </select></label>
                <div class="row-gap text-format-controls" role="group" aria-label="Text box formatting">
                  <button class={`btn small ${isBold(element()) ? "accent" : "ghost"}`} aria-label="Bold" aria-pressed={isBold(element())} title="Bold (Ctrl/Cmd+B)" onPointerDown={(event) => event.preventDefault()} onClick={() => setStyle("fontWeight", isBold(element()) ? 400 : 700)}><strong>B</strong></button>
                  <button class={`btn small ${isItalic(element()) ? "accent" : "ghost"}`} aria-label="Italic" aria-pressed={isItalic(element())} title="Italic (Ctrl/Cmd+I)" onPointerDown={(event) => event.preventDefault()} onClick={() => setStyle("fontStyle", isItalic(element()) ? "normal" : "italic")}><em>I</em></button>
                </div>
                <div class="text-alignment-controls" role="group" aria-label="Text alignment">
                  <For each={TEXT_ALIGNMENTS}>{(alignment) => <button class={`btn small ${textAlignment(element()) === alignment ? "accent" : "ghost"}`} aria-label={`Align ${alignment}`} aria-pressed={textAlignment(element()) === alignment} title={`Align ${alignment} (Ctrl/Cmd+Shift+${alignment === "left" ? "L" : alignment === "center" ? "E" : "R"})`} onPointerDown={(event) => event.preventDefault()} onClick={() => setStyle("align", alignment)}>
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d={`M2 4H18 M${alignment === "right" ? 7 : alignment === "center" ? 4.5 : 2} 8H${alignment === "left" ? 13 : alignment === "center" ? 15.5 : 18} M2 12H18 M${alignment === "right" ? 7 : alignment === "center" ? 4.5 : 2} 16H${alignment === "left" ? 13 : alignment === "center" ? 15.5 : 18}`} /></svg>
                    <span>{alignment[0].toUpperCase() + alignment.slice(1)}</span>
                  </button>}</For>
                </div>
                <div class="field-grid">
                  <label class="field">
                    <span>Size</span>
                    <input
                      type="number"
                      min="4"
                      value={fontSizeOf(element())}
                      onInput={(event) => setStyle("fontSize", Number(event.currentTarget.value))}
                    />
                  </label>
                  <label class="field">
                    <span>Weight</span>
                    <select
                      value={String(element().style.fontWeight ?? 400)}
                      onChange={(event) => setStyle("fontWeight", Number(event.currentTarget.value))}
                    >
                      <option value="300">Light</option>
                      <option value="400">Regular</option>
                      <option value="500">Medium</option>
                      <option value="600">Semibold</option>
                      <option value="700">Bold</option>
                      <option value="800">Extrabold</option>
                    </select>
                  </label>
                </div>
                <NumberField
                    label="Line height"
                    value={Number(styleString(element().style, "lineHeight", "1.25"))}
                    step={0.05}
                    onInput={(value) => setStyle("lineHeight", value)}
                />
                <label class="field color-field">
                  <span>Color</span>
                  <div class="color-row">
                    <input
                      type="color"
                      value={normalizeColor(styleString(element().style, "color", "#3d2a20"))}
                      onInput={(event) => setStyle("color", event.currentTarget.value)}
                    />
                    <input
                      type="text"
                      value={styleString(element().style, "color", "#3d2a20")}
                      onInput={(event) => setStyle("color", event.currentTarget.value)}
                    />
                  </div>
                </label>
              </section>
            </Show>

            <Show when={element().type === "custom"}>
              <section class="panel">
                <div class="panel-head"><h3>{props.customObjectTypes?.find((item) => item.id === element().customType)?.name ?? "Custom object"}</h3></div>
                <Show when={(props.customObjectTypes?.find((item) => item.id === element().customType)?.inputs.length ?? 0) > 0} fallback={<p class="muted small">This object has no editable inputs.</p>}>
                  <For each={props.customObjectTypes?.find((item) => item.id === element().customType)?.inputs ?? []}>{(input) => {
                    const value = () => element().customProps?.[input.id] ?? input.defaultValue;
                    return <label class="field"><span>{input.label}</span>
                      <Show when={input.type === "boolean"} fallback={<input type={input.type === "number" ? "number" : input.type === "color" ? "color" : "text"} value={String(value() ?? "")} onChange={(event) => props.onCustomInput?.(input.id, input.type === "number" ? Number(event.currentTarget.value) : event.currentTarget.value)} />}>
                        <input type="checkbox" checked={Boolean(value())} onChange={(event) => props.onCustomInput?.(input.id, event.currentTarget.checked)} />
                      </Show>
                    </label>;
                  }}</For>
                </Show>
              </section>
            </Show>

            <Show when={["rect", "ellipse", "triangle", "diamond", "star", "arrow", "callout", "line"].includes(element().type)}>
              <section class="panel">
                <div class="panel-head">
                  <h3>Fill & stroke</h3>
                </div>
                <label class="field color-field">
                  <span>Fill</span>
                  <div class="color-row">
                    <input
                      type="color"
                      value={normalizeColor(element().fill ?? "#ffb9a5")}
                      onInput={(event) => props.onElementChange({ fill: event.currentTarget.value })}
                    />
                    <input
                      type="text"
                      value={element().fill ?? ""}
                      placeholder="transparent"
                      onInput={(event) =>
                        props.onElementChange({ fill: event.currentTarget.value || undefined })
                      }
                    />
                  </div>
                </label>
                <label class="field color-field">
                  <span>Stroke</span>
                  <div class="color-row">
                    <input
                      type="color"
                      value={normalizeColor(element().stroke ?? "#3d2a20")}
                      onInput={(event) => props.onElementChange({ stroke: event.currentTarget.value })}
                    />
                    <input
                      type="text"
                      value={element().stroke ?? ""}
                      placeholder="none"
                      onInput={(event) =>
                        props.onElementChange({ stroke: event.currentTarget.value || undefined })
                      }
                    />
                  </div>
                </label>
                <NumberField
                  label="Stroke width"
                  value={element().strokeWidth ?? 2}
                  onInput={(strokeWidth) => props.onElementChange({ strokeWidth })}
                />
              </section>
            </Show>

            <Show when={["rect", "star", "arrow", "callout"].includes(element().type)}>
              <section class="panel">
                <div class="panel-head"><h3>Shape controls</h3></div>
                <Show when={element().type === "rect"}>
                  <label class="field"><span>Corner radius · {Math.round(element().shapeParams?.cornerRadius ?? 0)}</span><input type="range" min="0" max={Math.round(Math.min(element().w, element().h) / 2)} value={element().shapeParams?.cornerRadius ?? 0} onInput={(event) => setShapeParam("cornerRadius", Number(event.currentTarget.value))} /></label>
                </Show>
                <Show when={element().type === "star"}>
                  <label class="field"><span>Points · {element().shapeParams?.points ?? 5}</span><input type="range" min="3" max="12" step="1" value={element().shapeParams?.points ?? 5} onInput={(event) => setShapeParam("points", Number(event.currentTarget.value))} /></label>
                  <label class="field"><span>Inner radius · {element().shapeParams?.innerRadius ?? 22}%</span><input type="range" min="8" max="46" value={element().shapeParams?.innerRadius ?? 22} onInput={(event) => setShapeParam("innerRadius", Number(event.currentTarget.value))} /></label>
                </Show>
                <Show when={element().type === "arrow"}>
                  <label class="field"><span>Shaft width · {element().shapeParams?.shaftWidth ?? 28}%</span><input type="range" min="8" max="64" value={element().shapeParams?.shaftWidth ?? 28} onInput={(event) => setShapeParam("shaftWidth", Number(event.currentTarget.value))} /></label>
                  <label class="field"><span>Head length · {element().shapeParams?.headLength ?? 32}%</span><input type="range" min="18" max="54" value={element().shapeParams?.headLength ?? 32} onInput={(event) => setShapeParam("headLength", Number(event.currentTarget.value))} /></label>
                  <label class="field"><span>Head width · {element().shapeParams?.headWidth ?? 60}%</span><input type="range" min="32" max="92" value={element().shapeParams?.headWidth ?? 60} onInput={(event) => setShapeParam("headWidth", Number(event.currentTarget.value))} /></label>
                </Show>
                <Show when={element().type === "callout"}>
                  <label class="field"><span>Tail position · {element().shapeParams?.tailPosition ?? 25}%</span><input type="range" min="12" max="88" value={element().shapeParams?.tailPosition ?? 25} onInput={(event) => setShapeParam("tailPosition", Number(event.currentTarget.value))} /></label>
                  <label class="field"><span>Tail width · {element().shapeParams?.tailWidth ?? 24}%</span><input type="range" min="8" max="36" value={element().shapeParams?.tailWidth ?? 24} onInput={(event) => setShapeParam("tailWidth", Number(event.currentTarget.value))} /></label>
                  <label class="field"><span>Tail length · {element().shapeParams?.tailLength ?? 18}%</span><input type="range" min="8" max="45" value={element().shapeParams?.tailLength ?? 18} onInput={(event) => setShapeParam("tailLength", Number(event.currentTarget.value))} /></label>
                </Show>
              </section>
            </Show>

            <Show when={element().type === "image"}>
              <section class="panel">
                <div class="panel-head">
                  <h3>Image</h3>
                </div>
                <button class="btn block" onClick={props.onCropImage}>Crop image</button>
                <Show when={element().imageCrop}><button class="btn ghost block small" onClick={() => props.onElementChange({ imageCrop: undefined })}>Reset crop</button></Show>
                <p class="muted small">Double-click the image on the slide to crop it.</p>
                <label class="field">
                  <span>Source</span>
                  <input type="text" value={element().src ?? ""} disabled />
                </label>
              </section>
            </Show>

            <section class="panel">
              <label class="field">
                <span>Opacity · {Math.round((element().opacity ?? 1) * 100)}%</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={element().opacity ?? 1}
                  onInput={(event) =>
                    props.onElementChange({ opacity: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <button class="btn danger block" onClick={props.onDelete}>
                Delete { ["rect", "ellipse", "triangle", "diamond", "star", "arrow", "callout", "line"].includes(element().type) ? "shape" : "element" }
              </button>
            </section>
          </>
        )}
      </Show>

      <section class="panel playback-panel">
        <div class="panel-head"><h3>Slide transition</h3><button class="btn ghost small" onClick={props.onPreview}>Preview</button></div>
        <label class="field"><span>Effect</span><select value={props.slide.transition?.effect ?? "none"} onChange={(event) => {
          const effect = event.currentTarget.value as "none" | "fade" | "push" | "wipe";
          props.onSlideChange({ transition: effect === "none" ? undefined : { effect, durationMs: props.slide.transition?.durationMs ?? 500, direction: props.slide.transition?.direction ?? "left" } });
        }}>
          <option value="none">None</option><option value="fade">Fade</option><option value="push">Push</option><option value="wipe">Wipe</option>
        </select></label>
        <Show when={props.slide.transition && props.slide.transition.effect !== "none"}>
          <div class="field-grid">
            <label class="field"><span>Direction</span><select value={props.slide.transition!.direction} onChange={(event) => props.onSlideChange({ transition: { ...props.slide.transition!, direction: event.currentTarget.value as AnimationDirection } })}>
              <option value="left">From left</option><option value="right">From right</option><option value="up">From top</option><option value="down">From bottom</option>
            </select></label>
            <NumberField label="Duration · ms" value={props.slide.transition!.durationMs} step={50} onInput={(durationMs) => props.onSlideChange({ transition: { ...props.slide.transition!, durationMs: Math.max(100, Math.min(2000, durationMs)) } })} />
          </div>
        </Show>
      </section>

      <section class="panel animation-sequence-panel">
        <div class="panel-head"><h3>Animation sequence</h3><span class="muted">{animations().length} effects</span></div>
        <Show when={animations().length > 0} fallback={<p class="muted small">Select an object, then add an effect. Click Preview to try the sequence.</p>}>
          <ol class="animation-sequence">
            <For each={animations()}>{(animation, index) => {
              const target = () => props.slide.elements[animation.elementId];
              const label = () => target()?.text?.split("\n")[0]?.slice(0, 24) || target()?.type || "Missing object";
              return <li class={`animation-sequence-item ${el()?.id === animation.elementId ? "active" : ""}`}>
                <button class="animation-target" title="Select this object" onClick={() => target() && props.onElementSelect(animation.elementId)}><span class="animation-step-number">{index() + 1}</span><span>{label()}</span></button>
                <div class="field-grid">
                  <label class="field"><span>Effect</span><select value={animation.effect} onChange={(event) => patchAnimation(animation.id, { effect: event.currentTarget.value as AnimationEffect })}>
                    <option value="fade">Fade in</option><option value="rise">Rise in</option><option value="zoom">Zoom in</option><option value="move">Move in</option><option value="pulse">Emphasis</option><option value="exit-fade">Fade out</option><option value="exit-rise">Rise out</option>
                  </select></label>
                  <label class="field"><span>Start</span><select value={animation.trigger ?? "click"} onChange={(event) => patchAnimation(animation.id, { trigger: event.currentTarget.value as AnimationTrigger })}>
                    <option value="click">On click</option><option value="with-previous">With previous</option><option value="after-previous">After previous</option>
                  </select></label>
                </div>
                <div class="field-grid">
                  <label class="field"><span>Direction</span><select value={animation.direction ?? "up"} onChange={(event) => patchAnimation(animation.id, { direction: event.currentTarget.value as AnimationDirection })}>
                    <option value="left">From left</option><option value="right">From right</option><option value="up">From top</option><option value="down">From bottom</option>
                  </select></label>
                  <NumberField label="Duration · ms" value={animation.durationMs} step={50} onInput={(durationMs) => patchAnimation(animation.id, { durationMs: Math.max(100, Math.min(5000, durationMs)) })} />
                </div>
                <NumberField label="Delay · ms" value={animation.delayMs} step={50} onInput={(delayMs) => patchAnimation(animation.id, { delayMs: Math.max(0, Math.min(5000, delayMs)) })} />
                <div class="row-gap"><button class="btn ghost small" disabled={index() === 0} onClick={() => moveAnimation(animation.id, -1)} aria-label="Move effect earlier">↑</button><button class="btn ghost small" disabled={index() === animations().length - 1} onClick={() => moveAnimation(animation.id, 1)} aria-label="Move effect later">↓</button><button class="btn ghost small" onClick={() => props.onSlideChange({ animations: [...animations(), { ...animation, id: `anim_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`, order: animations().length }] })}>Duplicate</button><button class="btn ghost danger small" onClick={() => removeAnimation(animation.id)}>Remove</button></div>
              </li>;
            }}</For>
          </ol>
        </Show>
        <button class="btn block" disabled={!el()} onClick={addAnimation}>{el() ? `Add effect to ${el()!.type}` : "Select an object to add an effect"}</button>
      </section>

    </aside>
  );
}

function normalizeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#000000";
}
