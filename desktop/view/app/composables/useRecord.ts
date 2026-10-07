// Which card's record is open, by its key across the Flock, and the tab asked for with it
// until the record takes it. The board's gestures decide which; this only holds it.

const opened = ref<string | null>(null);
const asked = ref<string | null>(null);

export const useRecord = () => ({
  opened: readonly(opened),
  asked: readonly(asked),
  show: (key: string | null, tab: string | null = null) => {
    opened.value = key;
    asked.value = tab;
  },
  taken: () => (asked.value = null),
});
