import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { StaticSlide } from "../../src/components/ElementView";
import type { AnimationEffect, Slide, SlideAnimation } from "../../src/types";

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const effects = ["fade", "rise", "zoom", "move", "pulse", "exit"];
const animation = (elementId: string, effect: AnimationEffect, order: number, trigger: SlideAnimation["trigger"]): SlideAnimation => ({
  id: `animation_${order}`, elementId, effect, order, trigger, direction: "left", durationMs: 80, delayMs: 0,
});
const slide: Slide = {
  version: 1, id: "playback", name: "Playback", background: "white",
  elements: Object.fromEntries(effects.map((id, index) => [id, {
    id, type: "rect", x: index * 110, y: 20, w: 100, h: 100, z: index, rotation: 0, fill: "red", opacity: id === "fade" ? 0.65 : 1, style: {},
  }])),
  animations: [
    ...effects.slice(0, 5).map((id, index) => animation(id, id as AnimationEffect, index, index ? "with-previous" : "click")),
    animation("exit", "exit-fade", 5, "click"),
    animation("exit", "rise", 6, "click"),
  ],
};

async function verify() {
  const [step, setStep] = createSignal(0);
  const dispose = render(() => <StaticSlide slide={slide} animationStep={step()} />, document.getElementById("stage")!);
  const node = (id: string) => document.querySelector<HTMLDivElement>(`[data-element-id="${id}"]`)!;
  const initialNodes = effects.map(node);
  const finishAnimations = () => effects.flatMap((id) => node(id).getAnimations()).forEach((animation) => animation.finish());
  for (const id of effects.slice(0, 4)) check(getComputedStyle(node(id)).opacity === "0", `${id} must start hidden`);
  check(node("exit").style.opacity === "1", "an exit effect must start visible even when a later entrance exists");
  check(!node("pulse").classList.contains("presentation-pulse"), "emphasis must wait for its step");
  await wait(100);

  setStep(1);
  for (const id of effects.slice(0, 4)) {
    check(node(id).style.opacity === (id === "fade" ? "0.65" : "1"), `${id} did not reveal when the step advanced`);
    check(!/translate|scale/.test(node(id).style.transform), `${id} kept its hidden transform`);
    check(node(id).style.transition.includes("80ms"), `${id} lost its animation duration`);
  }
  check(node("pulse").classList.contains("presentation-pulse"), "emphasis did not start");
  check(node("fade").getAnimations().length > 0, "advancing the step did not create a browser transition");
  finishAnimations();
  check(Math.abs(Number(getComputedStyle(node("fade")).opacity) - 0.65) < 0.01, "entrance did not finish at the object's opacity");

  setStep(2);
  check(node("exit").style.opacity === "0", "exit effect did not hide its object");
  check(!node("pulse").classList.contains("presentation-pulse"), "emphasis remained active after its step");
  finishAnimations();
  check(getComputedStyle(node("exit")).opacity === "0", "exit did not finish hidden");
  setStep(3);
  check(node("exit").style.opacity === "1", "an earlier exit incorrectly hid a later entrance");
  finishAnimations();
  check(getComputedStyle(node("exit")).opacity === "1", "re-entrance did not finish visible");

  setStep(2);
  check(node("exit").style.opacity === "0", "stepping back did not restore the exit state");
  setStep(0);
  for (const id of effects.slice(0, 4)) check(node(id).style.opacity === "0", `${id} did not reset`);
  check(node("exit").style.opacity === "1", "reset did not restore initial visibility");
  effects.forEach((id, index) => check(node(id) === initialNodes[index], `${id} remounted instead of animating`));
  dispose();
}

verify().then(() => {
  document.getElementById("result")!.textContent = "PASS: object animation playback";
}).catch((error) => {
  document.getElementById("result")!.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
});
