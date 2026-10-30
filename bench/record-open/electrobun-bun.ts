// Electrobun's main-process API as the benchmark's Desktop gets it: one window, its view
// served over HTTP from the generated files, and its RPC frames carried over a WebSocket.

import type { ServerWebSocket } from "bun";
import type { FrameSchema } from "../../desktop/src/shared/channel";

type Frame = FrameSchema["messages"]["frame"];
interface Rpc {
  readonly handlers: { readonly messages: { readonly frame: (frame: Frame) => void } };
  send?: { frame: (frame: Frame) => void };
}

const views = Bun.env.BENCH_VIEW_DIR ?? "";
const userData = Bun.env.BENCH_USER_DATA ?? "";
let window: Rpc | undefined;
let socket: ServerWebSocket<unknown> | undefined;

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(Bun.env.BENCH_VIEW_PORT ?? 0),
  fetch(request, server) {
    const { pathname } = new URL(request.url);
    if (pathname === "/frames")
      return server.upgrade(request) ? undefined : new Response("not a WebSocket", { status: 400 });
    const file = Bun.file(`${views}${pathname === "/" ? "/index.html" : pathname}`);
    return file
      .exists()
      .then((found) =>
        found ? new Response(file) : new Response(Bun.file(`${views}/index.html`)),
      );
  },
  websocket: {
    open: (opened) => {
      socket = opened;
    },
    message: (_, data) => window?.handlers.messages.frame(JSON.parse(String(data))),
    close: (closed) => {
      if (socket === closed) socket = undefined;
    },
  },
});

const on = () => {};

export const BrowserView = { defineRPC: (rpc: Rpc) => rpc };

export class BrowserWindow {
  readonly frame = { x: 0, y: 0, width: 1600, height: 1000 };
  readonly webview: { rpc: Rpc; setNavigationRules: () => void };
  constructor({ rpc }: { rpc: Rpc }) {
    rpc.send = { frame: (frame) => socket?.send(JSON.stringify(frame)) };
    // The board's window is the first; any other, the popped-out chat, is never shown.
    window ??= rpc;
    this.webview = { rpc, setNavigationRules: on };
  }
  getFrame = () => this.frame;
  setPageZoom = on;
  on = on;
  activate = on;
  close = on;
}

export const Screen = {
  getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 1 }],
  getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 1 }),
};

export const Utils = {
  paths: { userData },
  openExternal: on,
  clipboardReadText: () => "",
  clipboardWriteText: on,
  clipboardAvailableFormats: () => [],
  openFileDialog: () => Promise.resolve([]),
};

export const Updater = {
  getLocalInfo: () => Promise.resolve({ channel: "dev", hash: "bench", baseUrl: "" }),
  appDataFolder: () => Promise.resolve(userData),
  checkForUpdate: () => Promise.resolve({ error: "", updateAvailable: false, version: "" }),
  downloadUpdate: () => Promise.resolve(),
  updateInfo: () => ({ error: "" }),
  applyUpdate: () => Promise.resolve(),
  getStatusHistory: () => [],
};

export default { ApplicationMenu: { setApplicationMenu: on }, events: { on } };
