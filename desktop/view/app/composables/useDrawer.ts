// Which card's drawer is open, by its key across the Flock.

const opened = ref<string | null>(null);

export const useDrawer = () => ({
  opened,
  open: (key: string) => (opened.value = key),
  close: () => (opened.value = null),
});
