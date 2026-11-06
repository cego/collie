// Electrobun's main-process API as the Rune spike's core gets it: no window and no webview,
// and the first window's RPC frames carried as NDJSON on stdin and stdout, framed by Effect's
// own `RpcSerialization.ndjson`, so Desktop's code runs unchanged behind the Rune shell.

import * as RpcSerialization from "effect/rpc/RpcSerialization";
import type { FrameSchema } from "../../desktop/src/shared/channel";

type Frame = FrameSchema["messages"]["frame"];
interface Rpc {
  readonly handlers: { readonly messages: { readonly frame: (frame: Frame) => void } };
  send?: { frame: (frame: Frame) => void };
}

// stdout carries frames alone, so whatever Desktop logs goes to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const ndjson = RpcSerialization.ndjson.makeUnsafe();
const userData = Bun.env.COLLIE_RUNE_USER_DATA ?? "";
let shell: Rpc | undefined;

const listen = async () => {
  for await (const bytes of Bun.stdin.stream())
    for (const frame of ndjson.decode(bytes))
      // SAFETY: the shell writes only Effect RPC frames, one a line.
      shell?.handlers.messages.frame(frame as Frame);
  // The shell has gone: nothing is left to serve.
  process.exit(0);
};

const on = () => {};

export const BrowserView = { defineRPC: (rpc: Rpc) => rpc };

export class BrowserWindow {
  readonly frame = { x: 0, y: 0, width: 1280, height: 900 };
  readonly webview: { rpc: Rpc; setNavigationRules: () => void };
  constructor({ rpc }: { rpc: Rpc }) {
    // The board's window is the first; any other, the popped-out chat, has no shell yet.
    if (shell === undefined) {
      shell = rpc;
      rpc.send = { frame: (frame) => void process.stdout.write(ndjson.encode(frame) ?? "") };
      void listen();
    }
    this.webview = { rpc, setNavigationRules: on };
  }
  getFrame = () => this.frame;
  setPageZoom = on;
  on = on;
  activate = on;
  close = on;
}

const DISPLAY = { bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
export const Screen = { getAllDisplays: () => [DISPLAY], getPrimaryDisplay: () => DISPLAY };

export const Utils = {
  paths: { userData },
  openExternal: on,
  showNotification: on,
  clipboardReadText: () => "",
  clipboardWriteText: on,
  clipboardAvailableFormats: () => [],
  openFileDialog: () => Promise.resolve([]),
};

export const Updater = {
  getLocalInfo: () => Promise.resolve({ channel: "dev", hash: "rune-spike", baseUrl: "" }),
  appDataFolder: () => Promise.resolve(userData),
  checkForUpdate: () => Promise.resolve({ error: "", updateAvailable: false, version: "" }),
  downloadUpdate: () => Promise.resolve(),
  updateInfo: () => ({ error: "" }),
  applyUpdate: () => Promise.resolve(),
  getStatusHistory: () => [],
};

export default { ApplicationMenu: { setApplicationMenu: on }, events: { on } };
