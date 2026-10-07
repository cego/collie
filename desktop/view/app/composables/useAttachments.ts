// The files the next chat message carries. Every window of Desktop shares them, as it shares
// the chip, so popping the chat out or back in keeps them. Each is staged with Desktop's
// main process in parts as it is added, scaled first where it is a large image.

import { useAtomSet } from "@effect/atom-vue";
import { DateTime, Effect, Encoding, Exit, Option, Random, Schema } from "effect";
import {
  type Attached,
  capRefusal,
  pastedName,
  scaledSize,
  Staged,
  type StagedOrRefused,
} from "../../../src/shared/attachments";
import { FlockClient } from "../flock";

const stageAtom = FlockClient.mutation("stage");
const stagePathsAtom = FlockClient.mutation("stagePaths");
const pickAtom = FlockClient.mutation("pickFiles");
const clipboardAtom = FlockClient.mutation("clipboardFiles");
const fileAtom = FlockClient.mutation("attachmentFile");

const decodePending = Schema.decodeUnknownOption(Schema.Array(Staged));
const pending = ref<ReadonlyArray<Staged>>([]);
const windows = new BroadcastChannel("collie-attachments");
windows.onmessage = (event) => {
  const told = decodePending(event.data);
  if (Option.isSome(told)) pending.value = told.value;
};
const share = (next: ReadonlyArray<Staged>) => {
  pending.value = next;
  windows.postMessage(next);
};
const holding = (file: Staged) => {
  if (!pending.value.some(({ id }) => id === file.id)) share([...pending.value, file]);
};

/** How much of a file goes to main in one frame. */
const PART = 1024 * 1024;

/** The types a canvas writes back as they came. */
const REDRAWN = new Set(["image/png", "image/jpeg", "image/webp"]);

const bytesIn = (blob: Blob) =>
  Effect.promise(() => blob.arrayBuffer()).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

export const useAttachments = () => {
  const stage = useAtomSet(() => stageAtom, { mode: "promiseExit" });
  const read = useAtomSet(() => fileAtom, { mode: "promiseExit" });
  const stagePaths = useAtomSet(() => stagePathsAtom, { mode: "promiseExit" });
  const pick = useAtomSet(() => pickAtom, { mode: "promiseExit" });
  const fromClipboard = useAtomSet(() => clipboardAtom, { mode: "promiseExit" });
  const refused = ref<string | null>(null);

  const send = Effect.fnUntraced(function* (
    bytes: Uint8Array,
    name: string,
    mediaType: string,
    scaledOf?: string,
  ) {
    const key = `${yield* Random.nextIntBetween(0, 2 ** 31)}-${bytes.length}`;
    for (let offset = 0; ; offset += PART) {
      const content = Encoding.encodeBase64(bytes.subarray(offset, offset + PART));
      const payload = { key, name, mediaType, size: bytes.length, offset, content };
      const exit = yield* Effect.promise(() =>
        stage({ payload: scaledOf === undefined ? payload : { ...payload, scaledOf } }),
      );
      if (Exit.isFailure(exit)) return yield* Effect.fail(`${name} could not be attached`);
      if (exit.value !== null || offset + PART >= bytes.length) return exit.value;
    }
  });

  /** A copy of a large image, scaled down for the model; the original is what a Run gets. */
  const scaled = Effect.fnUntraced(function* (file: Blob, staged: Staged) {
    if (!REDRAWN.has(file.type)) return;
    const image = yield* Effect.promise(() => createImageBitmap(file));
    const size = scaledSize(image);
    if (size === null) return;
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext("2d")?.drawImage(image, 0, 0, size.width, size.height);
    const smaller = yield* Effect.promise(() => canvas.convertToBlob({ type: file.type }));
    yield* send(yield* bytesIn(smaller), staged.name, file.type, staged.id);
  });

  /** Desktop's copy, read back for a thumbnail; null once Desktop no longer has it. */
  const bytesOf = Effect.fnUntraced(function* (file: Attached) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; ;) {
      const exit = yield* Effect.promise(() => read({ payload: { id: file.id, offset } }));
      if (Exit.isFailure(exit)) return null;
      const bytes = Encoding.decodeBase64(exit.value.content);
      if (bytes._tag === "Failure") return null;
      parts.push(new Uint8Array(bytes.success));
      offset += bytes.success.length;
      if (bytes.success.length === 0 || offset >= exit.value.size)
        return new Blob(parts, { type: file.mediaType });
    }
  });

  /** Adds a file the human gave, refused in words where it would not fit. */
  const add = Effect.fnUntraced(function* (file: File, pasted: boolean) {
    const name = pasted
      ? pastedName(file.name, file.type, DateTime.formatIso(yield* DateTime.now))
      : file.name;
    const why = capRefusal(pending.value, { name, size: file.size });
    refused.value = why;
    if (why !== null) return;
    const staged = yield* send(yield* bytesIn(file), name, file.type);
    if (staged === null) return;
    yield* scaled(file, staged);
    holding(staged);
  });

  /** Files main copied in, held to the message's cap and scaled as a pasted image is. */
  const took = Effect.fnUntraced(function* (
    exit: Exit.Exit<ReadonlyArray<StagedOrRefused>, unknown>,
    also: ReadonlyArray<string> = [],
  ) {
    if (Exit.isFailure(exit)) return;
    const said = [...also];
    for (const one of exit.value) {
      if ("refused" in one) {
        said.push(one.refused);
        continue;
      }
      const why = capRefusal(pending.value, one);
      if (why !== null) {
        said.push(why);
        continue;
      }
      const bytes = one.mediaType.startsWith("image/") ? yield* bytesOf(one) : null;
      if (bytes !== null) yield* scaled(bytes, one).pipe(Effect.ignore);
      holding(one);
    }
    refused.value = said.length === 0 ? null : said.join(" ");
  });

  /** Runs one of these for the view, a failure said in the composer. */
  const run = <E>(effect: Effect.Effect<void, E>) =>
    Effect.runPromise(
      effect.pipe(Effect.catch((cause) => Effect.sync(() => void (refused.value = String(cause))))),
    );

  return {
    pending: readonly(pending),
    refused: readonly(refused),
    add: (file: File, pasted: boolean) => run(add(file, pasted)),
    /** Files named by path, as a file manager copies or drops them; `also` are refusals of its own. */
    addPaths: (paths: ReadonlyArray<string>, also: ReadonlyArray<string> = []) =>
      run(
        Effect.promise(() => stagePaths({ payload: { paths } })).pipe(
          Effect.flatMap((exit) => took(exit, also)),
        ),
      ),
    /** The files a dialog lets the human choose. */
    pick: () =>
      run(
        Effect.promise(() => pick({ payload: undefined })).pipe(
          Effect.flatMap((exit) => took(exit)),
        ),
      ),
    /** The files on the system clipboard, where a paste handed the view none. */
    fromClipboard: () =>
      run(
        Effect.promise(() => fromClipboard({ payload: undefined })).pipe(
          Effect.flatMap((exit) => took(exit)),
        ),
      ),
    remove: (id: string) => share(pending.value.filter((one) => one.id !== id)),
    clear: () => {
      refused.value = null;
      share([]);
    },
    bytesOf: (file: Attached) => Effect.runPromise(bytesOf(file)),
  };
};
