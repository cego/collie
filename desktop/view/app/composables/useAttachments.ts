// The files the next chat message carries. Every window of Desktop shares them, as it shares
// the chip, so popping the chat out or back in keeps them. Each is staged with Desktop's
// main process in parts as it is added, scaled first where it is a large image.

import { useAtomSet } from "@effect/atom-vue";
import { DateTime, Encoding, Exit, Option, Schema } from "effect";
import {
  type Attached,
  capRefusal,
  pastedName,
  scaledSize,
  Staged,
} from "../../../src/shared/attachments";
import { FlockClient } from "../flock";

const stageAtom = FlockClient.mutation("stage");
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

/** How much of a file goes to main in one frame. */
const PART = 1024 * 1024;

/** The types a canvas writes back as they came. */
const REDRAWN = new Set(["image/png", "image/jpeg", "image/webp"]);

export const useAttachments = () => {
  const stage = useAtomSet(() => stageAtom, { mode: "promiseExit" });
  const read = useAtomSet(() => fileAtom, { mode: "promiseExit" });
  const refused = ref<string | null>(null);

  const send = async (bytes: Uint8Array, name: string, mediaType: string, scaledOf?: string) => {
    const key = crypto.randomUUID();
    for (let offset = 0; ; offset += PART) {
      const content = Encoding.encodeBase64(bytes.subarray(offset, offset + PART));
      const payload = { key, name, mediaType, size: bytes.length, offset, content };
      const exit = await stage({
        payload: scaledOf === undefined ? payload : { ...payload, scaledOf },
      });
      if (Exit.isFailure(exit)) throw new Error(`${name} could not be attached`);
      if (exit.value !== null || offset + PART >= bytes.length) return exit.value;
    }
  };

  /** A copy of a large image, scaled down for the model; the original is what a Run gets. */
  const scaled = async (file: Blob, staged: Staged) => {
    if (!REDRAWN.has(file.type)) return;
    const image = await createImageBitmap(file);
    const size = scaledSize(image);
    if (size === null) return;
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext("2d")?.drawImage(image, 0, 0, size.width, size.height);
    const smaller = await canvas.convertToBlob({ type: file.type });
    await send(new Uint8Array(await smaller.arrayBuffer()), staged.name, file.type, staged.id);
  };

  /** Adds a file the human gave, refused in words where it would not fit. */
  const add = async (file: File, pasted: boolean) => {
    const name = pasted
      ? pastedName(file.name, file.type, DateTime.formatIso(DateTime.nowUnsafe()))
      : file.name;
    const why = capRefusal(pending.value, { name, size: file.size });
    refused.value = why;
    if (why !== null) return;
    try {
      const staged = await send(new Uint8Array(await file.arrayBuffer()), name, file.type);
      if (staged === null) return;
      await scaled(file, staged);
      if (!pending.value.some(({ id }) => id === staged.id)) share([...pending.value, staged]);
    } catch (cause) {
      refused.value = String(cause);
    }
  };

  /** Desktop's copy, read back for a thumbnail; null once Desktop no longer has it. */
  const bytesOf = async (file: Attached) => {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; ;) {
      const exit = await read({ payload: { id: file.id, offset } });
      if (Exit.isFailure(exit)) return null;
      const bytes = Encoding.decodeBase64(exit.value.content);
      if (bytes._tag === "Failure") return null;
      parts.push(new Uint8Array(bytes.success));
      offset += bytes.success.length;
      if (bytes.success.length === 0 || offset >= exit.value.size)
        return new Blob(parts, { type: file.mediaType });
    }
  };

  return {
    pending: readonly(pending),
    refused: readonly(refused),
    add,
    remove: (id: string) => share(pending.value.filter((one) => one.id !== id)),
    clear: () => {
      refused.value = null;
      share([]);
    },
    bytesOf,
  };
};
