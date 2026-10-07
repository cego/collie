// Which card's record is open, by its key across the Flock, and the tab asked for with it
// until the record takes it. The board's gestures decide which, and focus returns
// to where it was once the record closes.

const opened = ref<string | null>(null);
const asked = ref<string | null>(null);
let returnTo: Element | null = null;

export const useRecord = () => ({
  opened: readonly(opened),
  asked: readonly(asked),
  show: (key: string | null, tab: string | null = null) => {
    if (opened.value === null) returnTo = document.activeElement;
    opened.value = key;
    asked.value = tab;
  },
  taken: () => (asked.value = null),
  /** Back where focus was when the record opened, once it is closed rather than remounted. */
  returnFocus: () => {
    const to = returnTo;
    if (opened.value === null && to instanceof HTMLElement) void nextTick(() => to.focus());
  },
});
