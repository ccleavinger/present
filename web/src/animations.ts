import type { Slide, SlideAnimation } from "./types";

export function orderedAnimations(slide: Pick<Slide, "animations">): SlideAnimation[] {
  return [...(slide.animations ?? [])].sort((a, b) => a.order - b.order);
}

export function animationGroups(slide: Pick<Slide, "animations">): Array<SlideAnimation & { group: number }> {
  let group = -1;
  return orderedAnimations(slide).map((animation, index) => {
    if (index === 0 || animation.trigger !== "with-previous") group += 1;
    return { ...animation, group };
  });
}

export function animationStepCount(slide: Pick<Slide, "animations">): number {
  const groups = animationGroups(slide);
  return groups.length ? groups[groups.length - 1].group + 1 : 0;
}

export function animationGroupDuration(slide: Pick<Slide, "animations">, group: number): number {
  return Math.max(0, ...animationGroups(slide).filter((item) => item.group === group).map((item) => item.durationMs + item.delayMs));
}

export function isAfterPreviousGroup(slide: Pick<Slide, "animations">, group: number): boolean {
  return animationGroups(slide).find((item) => item.group === group)?.trigger === "after-previous";
}
