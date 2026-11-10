// Electrobun's main-process API as the Rune spike's core gets it: no window and no webview,
// and the first window's RPC frames carried as NDJSON on stdin and stdout, framed by Effect's
// own `RpcSerialization.ndjson`, so Desktop's code runs unchanged behind the Rune shell.

import { Effect, Schema } from "effect";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { rename } from "node:fs/promises";
import type { FrameSchema } from "../../desktop/src/shared/channel";
import { PreparedRecord, preparedRecordOf, releaseOf } from "../../src/desktop";
import { appliedSignatureOf } from "../../src/signing";

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

/** Asks the shell to post it: a line of its own beside Effect's frames. */
const showNotification = ({ title, body = "", silent = false }: Notification) =>
  void process.stdout.write(`${JSON.stringify({ _tag: "Notify", title, body, silent })}\n`);
interface Notification {
  readonly title: string;
  readonly body?: string;
  readonly silent?: boolean;
}

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
  showNotification,
  clipboardReadText: () => "",
  clipboardWriteText: on,
  clipboardAvailableFormats: () => [],
  openFileDialog: () => Promise.resolve([]),
};

/** A bundle's own version.json, as `desktop-rune/scripts/bundle.ts` writes it. */
const Local = Schema.fromJsonString(
  Schema.Struct({ channel: Schema.String, hash: Schema.String, baseUrl: Schema.String }),
);
const UpdateManifest = Schema.fromJsonString(
  Schema.Struct({
    identifier: Schema.String,
    channel: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
    version: Schema.String,
    // Both name files on disk, so neither may name a path.
    hash: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,13}$/)),
    artifact: Schema.Struct({
      file: Schema.String.check(Schema.isPattern(/^rune-stable-[\w.-]+\.tar\.zst$/)),
    }),
  }),
);

/** Run from a checkout, the core never updates itself. */
const local = async () =>
  Bun.env.COLLIE_RUNE_VERSION === undefined
    ? { channel: "dev", hash: "rune-spike", baseUrl: "" }
    : Effect.runPromise(
        Schema.decodeEffect(Local)(await Bun.file(Bun.env.COLLIE_RUNE_VERSION).text()),
      );

const PLATFORM = `${process.platform === "darwin" ? "macos" : "linux"}-${process.arch}`;

const fetched = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
};

const latest = async () =>
  Effect.runPromise(
    Schema.decodeEffect(UpdateManifest)(
      await (
        await fetched(`${(await local()).baseUrl}/rune-stable-${PLATFORM}-update.json`)
      ).text(),
    ),
  );

let downloadFailed = "";
let status: ReadonlyArray<{ message: string }> = [];

/**
 * Electrobun's Updater as Desktop's `electrobun-updater.ts` asks it. Checking, downloading and
 * verifying stay Desktop's; installing is the Rune shell's, at its next launch, from the tar
 * and signature staged at `COLLIE_RUNE_STAGED`.
 */
export const Updater = {
  getLocalInfo: local,
  appDataFolder: () => Promise.resolve(userData),
  checkForUpdate: async () => {
    try {
      const [info, found] = await Promise.all([local(), latest()]);
      return { error: "", updateAvailable: found.hash !== info.hash, version: found.version };
    } catch (error) {
      return { error: String(error), updateAvailable: false, version: "" };
    }
  },
  downloadUpdate: async () => {
    downloadFailed = "";
    try {
      const found = await latest();
      const archive = await (
        await fetched(`${(await local()).baseUrl}/${found.artifact.file}`)
      ).bytes();
      const retained = `${userData}/self-extraction/${found.hash}.tar`;
      await Bun.write(retained, Bun.zstdDecompressSync(archive));
      await Bun.write(
        preparedRecordOf(userData),
        await Effect.runPromise(
          Schema.encodeEffect(PreparedRecord)({
            schema_version: 1,
            identifier: found.identifier,
            channel: found.channel,
            version: found.version,
            hash: found.hash,
            platform: found.platform,
            arch: found.arch,
            retained_tar_path: retained,
            artifact_file: found.artifact.file,
          }),
        ),
      );
    } catch (error) {
      downloadFailed = String(error);
    }
  },
  updateInfo: () => ({ error: downloadFailed }),
  // Desktop verified the tar before it asked; the shell verifies it again before installing.
  applyUpdate: async () => {
    const staged = Bun.env.COLLIE_RUNE_STAGED;
    if (staged === undefined) {
      status = [{ message: "this core runs from a checkout, so no shell installs updates" }];
      return;
    }
    const prepared = await Effect.runPromise(
      Schema.decodeEffect(PreparedRecord)(await Bun.file(preparedRecordOf(userData)).text()),
    );
    const named = appliedSignatureOf(prepared.artifact_file);
    const signature = await (
      await fetched(`${releaseOf((await local()).baseUrl, prepared.version)}/${named}`)
    ).text();
    await Bun.write(`${staged}.sig`, signature);
    await Bun.write(`${staged}.partial`, Bun.file(prepared.retained_tar_path));
    await rename(`${staged}.partial`, staged);
    status = [{ message: `Collie ${prepared.version} is installed when Collie next opens` }];
  },
  getStatusHistory: () => status,
};

export default { ApplicationMenu: { setApplicationMenu: on }, events: { on } };
