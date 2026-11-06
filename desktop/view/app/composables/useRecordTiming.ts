// User Timing marks for opening a record (docs/internals.md, Measuring a record open), also
// logged by the main process where the record timing setting is on, as are Desktop's other
// marks (desktop/README.md, Measuring a record open natively).

import { useAtomSet } from "@effect/atom-vue";
import { desktopTiming, recordTiming } from "../../../src/shared/record";
import { FlockClient } from "../flock";

const recordMarkAtom = FlockClient.mutation("recordMark");

// oxlint-disable-next-line no-restricted-globals -- A mark shares the click event's `timeStamp` clock, which Effect's Clock is not.
const userTiming = performance;

type Mark = { name: string; at: number; card: string };
let sent: (mark: Mark) => void = () => {};
let logged: (mark: Mark) => void = () => {};

const timing = recordTiming((name, at, card) => {
  userTiming.mark(name, { startTime: at, detail: { card } });
  logged({ name, at: userTiming.timeOrigin + at, card });
});
const desktop = desktopTiming((name, at, card) => {
  const mark = { name, at: userTiming.timeOrigin + at, card };
  // Drawn before the view may hold the settings, so the main process alone decides.
  if (name === "board-usable") sent(mark);
  else logged(mark);
});

const now = () => userTiming.now();
/** At the frame after this one, which draws what was just changed. */
const drawn = (mark: (at: number) => void) => requestAnimationFrame(() => mark(now()));

export const useRecordTiming = () => {
  const { desktopSettings } = useDesktopSettings();
  const log = useAtomSet(() => recordMarkAtom);
  sent = (mark) => log({ payload: mark });
  logged = (mark) => {
    if (desktopSettings.value.recordTiming === true) sent(mark);
  };
  const frames = () => requestAnimationFrame(() => desktop.frame(now()) && frames());
  return {
    click: timing.click,
    mounted: (card: string) => timing.mounted(card, now()),
    frame: (card: string) => timing.frame(card, now()),
    usable: (card: string) => timing.usable(card, now()),
    boardDrawn: () => drawn(desktop.boardUsable),
    key: (pane: string) => desktop.key(pane, now()),
    echoed: () => drawn(desktop.echoed),
    chunk: (message: string) => desktop.chunk(message, now()),
    chatDrawn: () => drawn(desktop.chatDrawn),
    /** Marks each frame of the scroll this starts, until it settles. */
    scrolled: (view: "log" | "diff") => desktop.scrolled(view, now()) && frames(),
  };
};
