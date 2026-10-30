// User Timing marks for opening a record (docs/internals.md, Measuring a record open), also
// logged by the main process where the record timing setting is on.

import { useAtomSet } from "@effect/atom-vue";
import { recordTiming } from "../../../src/shared/record";
import { FlockClient } from "../flock";

const recordMarkAtom = FlockClient.mutation("recordMark");

// oxlint-disable-next-line no-restricted-globals -- A mark shares the click event's `timeStamp` clock, which Effect's Clock is not.
const userTiming = performance;

let logged: (mark: { name: string; at: number; card: string }) => void = () => {};

const timing = recordTiming((name, at, card) => {
  userTiming.mark(name, { startTime: at, detail: { card } });
  logged({ name, at: userTiming.timeOrigin + at, card });
});

export const useRecordTiming = () => {
  const { desktopSettings } = useDesktopSettings();
  const log = useAtomSet(() => recordMarkAtom);
  logged = (mark) => {
    if (desktopSettings.value.recordTiming === true) log({ payload: mark });
  };
  return {
    click: timing.click,
    mounted: (card: string) => timing.mounted(card, userTiming.now()),
    frame: (card: string) => timing.frame(card, userTiming.now()),
    usable: (card: string) => timing.usable(card, userTiming.now()),
  };
};
