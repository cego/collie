// Which card's drawer is open, by its key across the Flock, and the tab asked for with it
// until the drawer takes it.

const opened = ref<string | null>(null);
const asked = ref<string | null>(null);

export const useDrawer = () => ({
  opened,
  asked: readonly(asked),
  open: (key: string, tab: string | null = null) => {
    opened.value = key;
    asked.value = tab;
  },
  taken: () => (asked.value = null),
  close: () => (opened.value = null),
});
