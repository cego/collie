// When a Desktop terminal tells herdr's controller its size. Each resize redraws the agent's
// whole pane, so a drag or a layout change sends only the size it settles at.

export interface Timers<Handle> {
  readonly set: (run: () => void, ms: number) => Handle;
  readonly clear: (handle: Handle) => void;
}

/** How long a size must hold before the pane is resized to it. */
export const SETTLE_MS = 120;

export const settledResizes = <Handle>(
  send: (cols: number, rows: number) => void,
  timers: Timers<Handle>,
) => {
  let sent: { cols: number; rows: number } | null = null;
  let pending: { handle: Handle } | null = null;
  const cancel = () => {
    if (pending !== null) timers.clear(pending.handle);
    pending = null;
  };
  const tell = (cols: number, rows: number) => {
    sent = { cols, rows };
    send(cols, rows);
  };
  return {
    /** A controller just opened, and refused any resize sent while it was starting. */
    opened: (cols: number, rows: number) => {
      cancel();
      tell(cols, rows);
    },
    resized: (cols: number, rows: number) => {
      cancel();
      pending = {
        handle: timers.set(() => {
          pending = null;
          if (sent?.cols !== cols || sent.rows !== rows) tell(cols, rows);
        }, SETTLE_MS),
      };
    },
    stop: cancel,
  };
};
