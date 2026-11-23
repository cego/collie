export const CHAT_WIDTH = {
  start: 512,
  startShare: 0.4,
  min: 320,
  boardMin: 480,
  step: 16,
} as const;

export const chatWidthMax = (window: number) =>
  Math.max(CHAT_WIDTH.min, window - CHAT_WIDTH.boardMin);

export const chatWidth = (chosen: number | undefined, window: number) =>
  Math.max(
    CHAT_WIDTH.min,
    Math.min(
      chosen ?? Math.min(CHAT_WIDTH.start, window * CHAT_WIDTH.startShare),
      chatWidthMax(window),
    ),
  );

export const dragged = (from: { x: number; width: number }, x: number, window: number) =>
  chatWidth(from.width + from.x - x, window);

export const nudged = (chosen: number | undefined, window: number, key: string) => {
  const by = key === "ArrowLeft" ? 1 : key === "ArrowRight" ? -1 : null;
  return by === null ? null : chatWidth(chatWidth(chosen, window) + by * CHAT_WIDTH.step, window);
};

type Box<A> = { value: A };

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
      if (saving === 0 && before === null) {
        view.chosen.value = saved;
      }
    },
    startDrag: (x: number, window: number) => {
      begin();
      view.dragging.value = { x, width: chatWidth(view.chosen.value, window) };
    },
    drag: (x: number, window: number) => {
      const from = view.dragging.value;
      if (from !== null) {
        view.chosen.value = dragged(from, x, window);
      }
    },
    nudge: (key: string, window: number) => {
      const width = nudged(view.chosen.value, window, key);
      if (width === null) {
        return false;
      }
      begin();
      view.chosen.value = width;
      return true;
    },
    settle: () => {
      view.dragging.value = null;
      const from = before;
      before = null;
      return from !== null && from.chosen !== view.chosen.value ? keep() : Promise.resolve();
    },
    reset: () => {
      before = null;
      view.dragging.value = null;
      view.chosen.value = undefined;
      return keep();
    },
  };
};
