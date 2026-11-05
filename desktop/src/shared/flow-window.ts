// Which of a Flow's Steps, in the order it draws them, are drawn yet: a large Run's 220 Steps
// cost a record's first frame several times its budget, and a view shows about 50 of them.

/** Steps drawn from `from` up to, not including, `to`. */
export interface StepWindow {
  readonly from: number;
  readonly to: number;
}

/** Steps drawn with a Flow's first frame: more than a record's view shows. */
export const FIRST_STEPS = 64;
/** Steps drawn on each frame after, until every Step is. */
export const LATER_STEPS = 24;

export const firstWindow = (count: number, anchor: number): StepWindow => {
  const from = Math.max(0, Math.min(anchor - FIRST_STEPS / 2, count - FIRST_STEPS));
  return { from, to: Math.min(count, from + FIRST_STEPS) };
};

export const wholeWindow = (window: StepWindow, count: number): boolean =>
  window.from === 0 && window.to >= count;

/** One frame's more Steps, split between both sides while both have Steps left. */
export const grownWindow = (window: StepWindow, count: number): StepWindow => {
  const to = Math.min(window.to, count);
  const from = Math.min(window.from, to);
  const down = Math.min(from, Math.max(LATER_STEPS / 2, LATER_STEPS - (count - to)));
  return { from: from - down, to: to + Math.min(count - to, LATER_STEPS - down) };
};
