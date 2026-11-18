export interface StepWindow {
  readonly from: number;
  readonly to: number;
}

export const FIRST_STEPS = 64;
export const LATER_STEPS = 24;

export const firstWindow = (count: number, anchor: number) => {
  const from = Math.max(0, Math.min(anchor - FIRST_STEPS / 2, count - FIRST_STEPS));
  return { from, to: Math.min(count, from + FIRST_STEPS) };
};

export const wholeWindow = (window: StepWindow, count: number) =>
  window.from === 0 && window.to >= count;

export const grownWindow = (window: StepWindow, count: number) => {
  const to = Math.min(window.to, count);
  const from = Math.min(window.from, to);
  const down = Math.min(from, Math.max(LATER_STEPS / 2, LATER_STEPS - (count - to)));
  return { from: from - down, to: to + Math.min(count - to, LATER_STEPS - down) };
};
