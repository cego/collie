// A file the human gave the Flock chat: what the composer decides before it is sent, what
// the model is told of it, and how the conversation shows it again. No Bun-only import:
// the view bundles this.

import { Option, Schema } from "effect";
import type { AttachmentFile } from "../../../src/board-model";

/** A file a message carried, as the conversation shows it. */
export const Attached = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  size: Schema.Number,
  mediaType: Schema.String,
});
export type Attached = typeof Attached.Type;

/** A file Desktop holds a copy of, and where. */
export const Staged = Schema.Struct({ ...Attached.fields, path: Schema.String });
export type Staged = typeof Staged.Type;

/** A file copied in, or why it could not be. */
export const StagedOrRefused = Schema.Union([Staged, Schema.Struct({ refused: Schema.String })]);
export type StagedOrRefused = typeof StagedOrRefused.Type;

export const FILE_CAP = 20 * 1024 * 1024;
export const MESSAGE_CAP = 30 * 1024 * 1024;
/** The most base64 a message hands the model inline: under the API's 32 MB request. */
export const INLINE_BUDGET = 24 * 1024 * 1024;
/** The longest edge the API takes in a request of more than 20 images. */
export const LONG_EDGE = 2000;

/** The image types the model is shown as images. */
export const SHOWN = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ShownImage = (typeof SHOWN)[number];
export const shownAs = (mediaType: string) => SHOWN.find((one) => one === mediaType);
/** The largest image shown: 5 MB once base64, the API's limit for one. */
export const IMAGE_BYTES = 3.75 * 1024 * 1024;
/** What may be text; a file of unknown type is, where its bytes say so. */
export const TEXTUAL = /^text\/|json|xml|javascript|yaml|toml|x-sh|^application\/octet-stream$/;

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Why `adding` cannot go with a message already holding `held`, or null where it can. */
export const capRefusal = (
  held: ReadonlyArray<{ readonly size: number }>,
  adding: { readonly name: string; readonly size: number },
) => {
  if (adding.size > FILE_CAP)
    return `${adding.name} is ${megabytes(adding.size)}, over the 20 MB one file may be.`;
  const total = held.reduce((sum, one) => sum + one.size, adding.size);
  return total > MESSAGE_CAP
    ? `With ${adding.name} this message's files come to ${megabytes(total)}, over the 30 MB one message may carry.`
    : null;
};

/** The size an image is scaled to, or null where it is sent as it is. */
export const scaledSize = (image: { readonly width: number; readonly height: number }) => {
  const long = Math.max(image.width, image.height);
  if (long <= LONG_EDGE) return null;
  const by = LONG_EDGE / long;
  return { width: Math.round(image.width * by), height: Math.round(image.height * by) };
};

/** An image's width and height from its PNG, GIF, JPEG or WebP header; null where unread. */
export const imageSize = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number, text: string) =>
    [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  const le24 = (at: number) => view.getUint16(at, true) + (view.getUint8(at + 2) << 16);
  try {
    if (bytes[0] === 0x89 && tag(1, "PNG") && tag(12, "IHDR"))
      return { width: view.getUint32(16), height: view.getUint32(20) };
    if (tag(0, "GIF8")) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (tag(0, "RIFF") && tag(8, "WEBP")) {
      if (tag(12, "VP8X")) return { width: le24(24) + 1, height: le24(27) + 1 };
      if (tag(12, "VP8 "))
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      if (tag(12, "VP8L")) {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8)
      for (let at = 2; at + 9 <= bytes.length;) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1]!;
        if (marker === 0xff) {
          at += 1;
          continue;
        }
        // Every start of frame but DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
        at += 2 + view.getUint16(at + 2);
      }
  } catch {
    // A header cut short says nothing.
  }
  return null;
};

/** Whether an image may be shown to the model: its size is known and within `LONG_EDGE`. */
export const showable = (bytes: Uint8Array) => {
  const size = imageSize(bytes);
  return size !== null && Math.max(size.width, size.height) <= LONG_EDGE;
};

/** Which of a paste's items become attachments: its image files. Anything else pastes as it did. */
export const pastedImages = (
  items: ReadonlyArray<{ readonly kind: string; readonly type: string }>,
) =>
  items.flatMap((item, at) => (item.kind === "file" && item.type.startsWith("image/") ? [at] : []));

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/**
 * The paths of a `text/uri-list` of files copied or dropped, and why any other line is
 * not one. A file manager names files as `file://` URIs, which only main can read.
 */
export const uriListPaths = (text: string) => {
  const paths: string[] = [];
  const refused: string[] = [];
  for (const line of text.split(/\r?\n/).map((one) => one.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    const url = URL.parse(line);
    const path =
      url?.protocol === "file:" && (url.host === "" || url.host === "localhost")
        ? decoded(url.pathname)
        : null;
    if (path !== null) paths.push(path);
    else refused.push(`${line} is not a file on this computer`);
  }
  return { paths, refused };
};

/** The files the system clipboard names as text: `file://` URIs, or absolute paths. */
export const clipboardPaths = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .flatMap((line) =>
      line.startsWith("/") ? [line] : line.startsWith("file:") ? uriListPaths(line).paths : [],
    );

/** What a drop carries: files named by URI, files' bytes, or text. */
export const dropKind = (types: ReadonlyArray<string>) =>
  types.includes("text/uri-list") ? "uris" : types.includes("Files") ? "files" : "text";

/** A clipboard image's name: its own, or when it was pasted where the browser gave it none. */
export const pastedName = (name: string, mediaType: string, at: string) =>
  name !== "" && name !== "image.png"
    ? name
    : `pasted-${at.slice(0, 19).replaceAll(/[T:]/g, "-")}.${mediaType.split("/")[1] ?? "png"}`;

/** How Desktop's own block about a message's files begins. */
export const ATTACHED = "[Desktop: the human attached these files to this message]";

const LINE = /^- (.+) \(([^,()]+), (\d+) bytes\): (.+)$/;

/** The block the model is handed beside the human's words, apart from them. */
export const listing = (files: ReadonlyArray<Staged>) =>
  [
    ATTACHED,
    ...files.map(
      ({ name, mediaType, size, path }) => `- ${name} (${mediaType}, ${size} bytes): ${path}`,
    ),
  ].join("\n");

/** The files a block of Desktop's lists, or null for any other text. */
export const fromListing = (text: string): ReadonlyArray<Attached> | null => {
  const [first, ...lines] = text.split("\n");
  if (first !== ATTACHED) return null;
  return lines.flatMap((line) => {
    const [, name, mediaType, size, path] = LINE.exec(line) ?? [];
    if (name === undefined || mediaType === undefined || size === undefined || path === undefined)
      return [];
    // A copy is kept at `<sha256>/<name>`, which is its id.
    return [{ id: path.split("/").slice(-2).join("/"), name, size: Number(size), mediaType }];
  });
};

/** A file as a part of the human's message, in the shape TanStack AI's client keeps. */
export const AttachmentPart = Schema.Struct({
  type: Schema.Literal("document"),
  id: Schema.String,
  source: Schema.Struct({
    type: Schema.Literal("file"),
    value: Schema.String,
    mimeType: Schema.String,
  }),
  metadata: Schema.Struct({ name: Schema.String, size: Schema.Number }),
});
export type AttachmentPart = typeof AttachmentPart.Type;

export const attachmentPart = (file: Attached): AttachmentPart => ({
  type: "document",
  id: file.id,
  source: { type: "file", value: file.id, mimeType: file.mediaType },
  metadata: { name: file.name, size: file.size },
});

const decodePart = Schema.decodeUnknownOption(AttachmentPart);

/** The file a message part is, where it is one. */
export const attachedIn = (part: { readonly type: string }): Option.Option<Attached> =>
  Option.map(decodePart(part), ({ id, source, metadata }) => ({
    id,
    name: metadata.name,
    size: metadata.size,
    mediaType: source.mimeType,
  }));

/** A Run's attachments: images as thumbnails, everything else by name. */
export const attachmentsShown = (files: ReadonlyArray<AttachmentFile>) => {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const image = (file: AttachmentFile) => shownAs(file.mediaType) !== undefined;
  return { thumbnails: sorted.filter(image), named: sorted.filter((file) => !image(file)) };
};
