// The Flock chat's width beside the board, in CSS pixels: a larger Zoom makes the window fewer of them.

/** The chat's sizes in px, and the share of the window it starts at. */
export const CHAT_WIDTH = {
  start: 512,
  startShare: 0.4,
  min: 320,
  boardMin: 480,
  step: 16,
} as const;

/** The widest the chat is drawn in a window `window` wide. */
export const chatWidthMax = (window: number): number =>
  Math.max(CHAT_WIDTH.min, window - CHAT_WIDTH.boardMin);

/** The chat's drawn width: the chosen one, or the start where none is, within its least and greatest. */
export const chatWidth = (chosen: number | undefined, window: number): number =>
  Math.max(
    CHAT_WIDTH.min,
    Math.min(
      chosen ?? Math.min(CHAT_WIDTH.start, window * CHAT_WIDTH.startShare),
      chatWidthMax(window),
    ),
  );

/** The width a drag from `from` to `x` chooses; the chat is right of its edge. */
export const dragged = (from: { x: number; width: number }, x: number, window: number) =>
  chatWidth(from.width + from.x - x, window);

/** The width `key` chooses, stepped from the drawn width, or null for a key that does not size it. */
export const nudged = (chosen: number | undefined, window: number, key: string): number | null => {
  const by = key === "ArrowLeft" ? 1 : key === "ArrowRight" ? -1 : null;
  return by === null ? null : chatWidth(chatWidth(chosen, window) + by * CHAT_WIDTH.step, window);
};

type Box<A> = { value: A };

/** The splitter's hold on the chosen width: one save per drag or held key, and a width the
 * settings tell back never undoes a newer choice. */
export const chatWidthControl = (
  view: { chosen: Box<number | undefined>; dragging: Box<{ x: number; width: number } | null> },
  save: (width: number | undefined) => Promise<void>,
) => {
  let saving = 0;
  let before: { chosen: number | undefined } | null = null;
  const keep = () => {
    saving += 1;
    return save(view.chosen.value).finally(() => {
      saving -= 1;
    });
  };
  const begin = () => {
    before ??= { chosen: view.chosen.value };
  };
  return {
    told: (saved: number | undefined) => {
      if (saving === 0 && before === null) view.chosen.value = saved;
    },
    startDrag: (x: number, window: number) => {
      begin();
      view.dragging.value = { x, width: chatWidth(view.chosen.value, window) };
    },
    drag: (x: number, window: number) => {
      const from = view.dragging.value;
      if (from !== null) view.chosen.value = dragged(from, x, window);
    },
    /** False for a key that does not size the chat. */
    nudge: (key: string, window: number): boolean => {
      const width = nudged(view.chosen.value, window, key);
      if (width === null) return false;
      begin();
      view.chosen.value = width;
      return true;
    },
    /** Ends a drag or a run of nudges, saving the width if it changed. */
    settle: (): Promise<void> => {
      view.dragging.value = null;
      const from = before;
      before = null;
      return from !== null && from.chosen !== view.chosen.value ? keep() : Promise.resolve();
    },
    reset: (): Promise<void> => {
      before = null;
      view.dragging.value = null;
      view.chosen.value = undefined;
      return keep();
    },
  };
};
