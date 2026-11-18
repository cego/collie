export const DELAY_MS = 300;
export const SKIP_MS = 300;

export interface StepTip {
  readonly open: string | null;
  readonly waiting: string | null;
  readonly instantUntil: number;
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

const closed = (tip: StepTip, at: number) => ({
  ...tip,
  open: null,
  waiting: null,
  instantUntil: tip.open === null ? tip.instantUntil : at + SKIP_MS,
});

export interface TipNext {
  readonly tip: StepTip;
  readonly wait: number | null;
}

export const tipAfter = (tip: StepTip, event: TipEvent) => {
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
