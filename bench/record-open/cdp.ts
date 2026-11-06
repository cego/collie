// The Chrome DevTools Protocol, as much of it as the benchmark speaks: one page of its own
// in the shared Chrome, its commands answered in order, its events heard.

type CdpValue = string | number | boolean | null | CdpObject | ReadonlyArray<CdpValue>;
interface CdpObject {
  readonly [key: string]: CdpValue;
}

export interface Page {
  readonly send: <A = CdpObject>(method: string, params?: CdpObject) => Promise<A>;
  readonly close: () => Promise<void>;
}

export const openPage = async (cdp: string, url: string): Promise<Page> => {
  // SAFETY: `/json/new` answers with the target it opened.
  const target = (await (
    await fetch(`${cdp}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
  ).json()) as { id: string; webSocketDebuggerUrl: string };
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((opened, failed) => {
    socket.onopen = opened;
    socket.onerror = failed;
  });
  let next = 0;
  const waiting = new Map<
    number,
    { done: (value: CdpObject) => void; failed: (e: Error) => void }
  >();
  socket.onmessage = (event) => {
    // SAFETY: Chrome's DevTools socket sends CDP messages; events, which carry no id, are not heard.
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: CdpObject;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const asked = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) asked?.failed(new Error(message.error.message));
    else asked?.done(message.result ?? {});
  };
  return {
    send: <A>(method: string, params: CdpObject = {}) =>
      new Promise<A>((done, failed) => {
        const id = ++next;
        // SAFETY: the caller names the result of the method it sends.
        waiting.set(id, { done: (result) => done(result as A), failed });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: async () => {
      socket.close();
      await fetch(`${cdp}/json/close/${target.id}`).catch(() => undefined);
    },
  };
};
