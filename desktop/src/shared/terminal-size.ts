// WARNING: each resize redraws the agent's whole pane, so only the size a drag settles at is sent.
export interface Timers<Handle> {
  readonly set: (run: () => void, ms: number) => Handle;
  readonly clear: (handle: Handle) => void;
}

export const SETTLE_MS = 120;

export const settledResizes = <Handle>(
  send: (cols: number, rows: number) => void,
  timers: Timers<Handle>,
) => {
  let sent: { cols: number; rows: number } | null = null;
  let pending: { handle: Handle } | null = null;
  const cancel = () => {
    if (pending !== null) {
      timers.clear(pending.handle);
    }
    pending = null;
  };
  const tell = (cols: number, rows: number) => {
    sent = { cols, rows };
    send(cols, rows);
  };
  return {
    // WARNING: a controller just opened refuses any resize sent while it starts.
    opened: (cols: number, rows: number) => {
      cancel();
      tell(cols, rows);
    },
    resized: (cols: number, rows: number) => {
      cancel();
      pending = {
        handle: timers.set(() => {
          pending = null;
          if (sent?.cols !== cols || sent.rows !== rows) {
            tell(cols, rows);
          }
        }, SETTLE_MS),
      };
    },
    stop: cancel,
  };
};
