import type { Panel } from "../../../../src/board-model";

/**
 * A panel's text whole: as sent, or read again by `item` where the host cut it, with a note
 * while it is cut.
 */
export const useWhole = (
  where: () => { installation: string; runId: string },
  item: string,
  panel: () => Panel,
) => {
  const { textOf } = useActions();
  const whole = ref<{ text: string } | { failed: true } | null>(null);
  let asked = 0;
  watch(
    () => {
      const shown = panel();
      return shown._tag === "Text" && shown.truncated ? shown.text : null;
    },
    (cut) => {
      whole.value = null;
      const mine = ++asked;
      if (cut === null) return;
      const { installation, runId } = where();
      void textOf(installation, runId, item).then((text) => {
        if (mine === asked) whole.value = text === null ? { failed: true } : { text };
      });
    },
    { immediate: true },
  );
  return computed(() => {
    const shown = panel();
    if (shown._tag !== "Text") return null;
    if (!shown.truncated) return { text: shown.text, cut: null };
    if (whole.value !== null && "text" in whole.value) return { text: whole.value.text, cut: null };
    return {
      text: shown.text,
      cut:
        whole.value === null
          ? "This is cut short; reading the rest…"
          : "This is cut short, and the rest could not be read.",
    };
  });
};
