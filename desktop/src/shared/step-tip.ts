// When a Flow's one shared tooltip shows which Step's text, by the rules each Step's own tooltip
// followed: shown after a hover's delay, at once on a keyboard focus or straight from another
// tip, and closed by leaving, blurring, pressing or Escape.

/** How long a hover waits before the tip shows. */
export const DELAY_MS = 300;
/** How long after a tip closes the next hover shows its tip at once. */
export const SKIP_MS = 300;

export interface StepTip {
  readonly open: string | null;
  readonly waiting: string | null;
  readonly instantUntil: number;
  /** A press focuses its Step without that being a reason to show it. */
  readonly pressed: boolean;
}
export const CLOSED: StepTip = {
  open: null,
  waiting: null,
  instantUntil: Number.NEGATIVE_INFINITY,
  pressed: false,
};

export type TipEvent =
  | { readonly kind: "enter"; readonly step: string; readonly at: number }
  | { readonly kind: "due"; readonly step: string }
  | { readonly kind: "focus"; readonly step: string }
  | { readonly kind: "press"; readonly at: number }
  | { readonly kind: "release" }
  | { readonly kind: "leave" | "blur" | "dismiss"; readonly at: number };

const closed = (tip: StepTip, at: number): StepTip => ({
  ...tip,
  open: null,
  waiting: null,
  instantUntil: tip.open === null ? tip.instantUntil : at + SKIP_MS,
});

/** A tip, and how long to wait before sending `due` for the Step it waits on. */
export interface TipNext {
  readonly tip: StepTip;
  readonly wait: number | null;
}

export const tipAfter = (tip: StepTip, event: TipEvent): TipNext => {
  switch (event.kind) {
    case "enter":
      return tip.open !== null || event.at < tip.instantUntil
        ? { tip: { ...tip, open: event.step, waiting: null }, wait: null }
        : { tip: { ...tip, waiting: event.step }, wait: DELAY_MS };
    case "due":
      return {
        tip: tip.waiting === event.step ? { ...tip, open: event.step, waiting: null } : tip,
        wait: null,
      };
    case "focus":
      return {
        tip: tip.pressed ? tip : { ...tip, open: event.step, waiting: null },
        wait: null,
      };
    case "press":
      return { tip: { ...closed(tip, event.at), pressed: true }, wait: null };
    case "release":
      return { tip: { ...tip, pressed: false }, wait: null };
    default:
      return { tip: closed(tip, event.at), wait: null };
  }
};
