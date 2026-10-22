import { For, Show } from "solid-js";
import type { CommitInfo, Slide, SlideElement } from "../types";
import { formatTime } from "../api";
import { fontSizeOf, styleString } from "../elements";

interface InspectorProps {
  slide: Slide;
  selected: SlideElement | undefined;
  commits: CommitInfo[];
  onElementChange: (patch: Partial<SlideElement>) => void;
  onSlideChange: (patch: Partial<Slide>) => void;
  onDelete: () => void;
  onCheckpoint: () => void;
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
              <label class="field">
                <span>ID</span>
                <input type="text" value={element().id} disabled />
              </label>
            </section>

            <Show when={element().type === "text"}>
              <section class="panel">
                <div class="panel-head">
                  <h3>Typography</h3>
                </div>
                <label class="field">
                  <span>Text</span>
                  <textarea
                    rows={4}
                    value={element().text ?? ""}
                    onInput={(event) => props.onElementChange({ text: event.currentTarget.value })}
                  />
                </label>
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
                      value={String(styleString(element().style, "fontWeight", "400"))}
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
                <div class="field-grid">
                  <label class="field">
                    <span>Align</span>
                    <select
                      value={styleString(element().style, "align", "left")}
                      onChange={(event) => setStyle("align", event.currentTarget.value)}
                    >
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </label>
                  <NumberField
                    label="Line height"
                    value={Number(styleString(element().style, "lineHeight", "1.25"))}
                    step={0.05}
                    onInput={(value) => setStyle("lineHeight", value)}
                  />
                </div>
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

            <Show when={element().type === "rect" || element().type === "ellipse" || element().type === "line"}>
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

            <Show when={element().type === "image"}>
              <section class="panel">
                <div class="panel-head">
                  <h3>Image</h3>
                </div>
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
                Delete element
              </button>
            </section>
          </>
        )}
      </Show>

      <section class="panel history-panel">
        <div class="panel-head">
          <h3>Recent commits</h3>
          <button class="link" onClick={props.onCheckpoint}>
            Checkpoint
          </button>
        </div>
        <Show
          when={props.commits.length > 0}
          fallback={<p class="muted small">No commits yet.</p>}
        >
          <ol class="commit-list">
            <For each={props.commits.slice(0, 8)}>
              {(commit) => (
                <li>
                  <span class="commit-dot" />
                  <div>
                    <div class="commit-summary">{commit.summary}</div>
                    <div class="commit-meta">
                      {commit.id.slice(0, 7)} · {formatTime(commit.time)}
                    </div>
                  </div>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>
    </aside>
  );
}

function normalizeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#000000";
}
