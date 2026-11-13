// Native shell port for the desktop core. Effect RPC frames travel as NDJSON on stdio;
// platform actions are handled by the Rune shell. The window-shaped core interfaces
// remain private adapters and do not create a webview.

import { Effect, Schema } from "effect";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { rename, rm } from "node:fs/promises";
import type { FrameSchema } from "../../desktop/src/shared/channel";
import { downloadRelease } from "../../desktop/src/bun/release-download";
import { PreparedRecord, preparedRecordOf, releaseOf } from "../../src/desktop";
import { appliedSignatureOf } from "../../src/signing";

type Frame = FrameSchema["messages"]["frame"];
interface Rpc {
  readonly handlers: { readonly messages: { readonly frame: (frame: Frame) => void } };
  send: { frame: (frame: Frame) => void };
}

// stdout carries frames alone, so whatever Desktop logs goes to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const ndjson = RpcSerialization.ndjson.makeUnsafe();
const userData = Bun.env.COLLIE_RUNE_USER_DATA ?? "";
// Do not retry an archive the shell already refused at this launch.
if (Bun.env.COLLIE_RUNE_UPDATE_REFUSED === "1")
  await rm(preparedRecordOf(userData), { force: true });
let shell: Rpc | undefined;

const listen = async () => {
  for await (const bytes of Bun.stdin.stream())
    for (const frame of ndjson.decode(bytes))
      // SAFETY: the shell writes only Effect RPC frames, one a line.
      shell?.handlers.messages.frame(frame as Frame);
  // The shell has gone: nothing is left to serve.
  process.exit(0);
};

const on = (_event: string, _listener: () => void) => {};

/** Asks the shell to post it: a line of its own beside Effect's frames. */
const showNotification = ({ title, body = "", silent = false }: Notification) =>
  void process.stdout.write(`${JSON.stringify({ _tag: "Notify", title, body, silent })}\n`);
interface Notification {
  readonly title: string;
  readonly body?: string;
  readonly silent?: boolean;
}

export const BrowserView = {
  defineRPC: (rpc: {
    readonly maxRequestTime: number;
    readonly handlers: Rpc["handlers"] & { readonly requests: {} };
  }): Rpc => ({ ...rpc, send: { frame: (_frame: Frame) => {} } }),
};

export class BrowserWindow {
  readonly frame = { x: 0, y: 0, width: 1280, height: 900 };
  readonly webview: { rpc: Rpc; setNavigationRules: (rules: ReadonlyArray<string>) => void };
  constructor({
    rpc,
  }: {
    rpc: Rpc;
    title?: string;
    url?: string;
    renderer?: string;
    frame?: BrowserWindow["frame"];
  }) {
    // The board's window is the first; any other, the popped-out chat, has no shell yet.
    if (shell === undefined) {
      shell = rpc;
      rpc.send = { frame: (frame) => void process.stdout.write(ndjson.encode(frame) ?? "") };
      void listen();
    }
    this.webview = { rpc, setNavigationRules: (_rules) => {} };
  }
  getFrame = () => this.frame;
  setPageZoom = (_zoom: number) => {};
  on = on;
  activate = () => {};
  close = () => {};
}

const DISPLAY = { bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
export const Screen = { getAllDisplays: () => [DISPLAY], getPrimaryDisplay: () => DISPLAY };

export const Utils = {
  paths: { userData },
  openExternal: (_url: string) => {},
  showNotification,
  clipboardReadText: () => "",
  clipboardWriteText: (_text: string) => {},
  clipboardAvailableFormats: (): string[] => [],
  openFileDialog: (_options: {
    canChooseDirectory: boolean;
    allowsMultipleSelection: boolean;
  }): Promise<string[]> => Promise.resolve([]),
};

/** A bundle's own version.json, as `desktop-rune/scripts/bundle.ts` writes it. */
const Local = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    channel: Schema.String,
    hash: Schema.String,
    baseUrl: Schema.String,
  }),
);
const UpdateManifest = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    identifier: Schema.Literal("dk.cego.collie.desktop"),
    channel: Schema.Literal("stable"),
    platform: Schema.Literal(process.platform === "darwin" ? "macos" : "linux"),
    arch: Schema.Literal(process.arch),
    version: Schema.String,
    // Both name files on disk, so neither may name a path.
    hash: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,13}$/)),
    artifact: Schema.Struct({
      file: Schema.String.check(Schema.isPattern(/^stable-[\w.-]+\.tar\.zst$/)),
    }),
  }),
);

/** Run from a checkout, the core never updates itself. */
const local = async () =>
  Bun.env.COLLIE_RUNE_VERSION === undefined
    ? { version: "0.0.0", channel: "dev", hash: "rune-spike", baseUrl: "" }
    : Effect.runPromise(
        Schema.decodeEffect(Local)(await Bun.file(Bun.env.COLLIE_RUNE_VERSION).text()),
      );

const PLATFORM = `${process.platform === "darwin" ? "macos" : "linux"}-${process.arch}`;

/** A release asset, given up, and its request ended, after `within`. */
const fetched = (url: string, within: `${number} minute${"" | "s"}` = "1 minute") =>
  Effect.runPromise(
    downloadRelease(url).pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.timeoutOrElse({
        duration: within,
        orElse: () => Effect.fail(`${url} had no answer in ${within}`),
      }),
      Effect.provide(FetchHttpClient.layer),
    ),
  );

const latest = async () =>
  Effect.runPromise(
    Schema.decodeEffect(UpdateManifest)(
      new TextDecoder().decode(
        await fetched(`${(await local()).baseUrl}/stable-${PLATFORM}-update.json`),
      ),
    ),
  );

let downloadFailed = "";
let status: ReadonlyArray<{ message: string; restarting?: boolean }> = [];

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
      const newer = found.hash !== info.hash && Bun.semver.order(found.version, info.version) > 0;
      return { error: "", updateAvailable: newer, version: found.version };
    } catch (error) {
      return { error: String(error), updateAvailable: false, version: "" };
    }
  },
  downloadUpdate: async () => {
    downloadFailed = "";
    try {
      const found = await latest();
      const archive = new Uint8Array(
        await fetched(`${(await local()).baseUrl}/${found.artifact.file}`, "30 minutes"),
      );
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
    const signature = new TextDecoder().decode(
      await fetched(`${releaseOf((await local()).baseUrl, prepared.version)}/${named}`),
    );
    await Bun.write(`${staged}.sig`, signature);
    await Bun.write(`${staged}.json`, JSON.stringify(prepared));
    await Bun.write(`${staged}.partial`, Bun.file(prepared.retained_tar_path));
    await rename(`${staged}.partial`, staged);
    process.stdout.write(`${JSON.stringify({ _tag: "Restart" })}\n`);
    status = [
      { message: `Collie ${prepared.version} is installed as Collie restarts`, restarting: true },
    ];
  },
  getStatusHistory: () => status,
};

export interface ApplicationMenuItemConfig {
  readonly role?: string;
  readonly type?: "separator";
  readonly label?: string;
  readonly submenu?: ReadonlyArray<ApplicationMenuItemConfig>;
}
export default {
  ApplicationMenu: { setApplicationMenu: (_menu: ReadonlyArray<ApplicationMenuItemConfig>) => {} },
  events: { on },
};
