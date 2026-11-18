import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Option, Schema } from "effect";
import type { AttachmentFile } from "../../../src/board-model";

export const Attached = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  size: Schema.Finite,
  mediaType: Schema.String,
});
export type Attached = typeof Attached.Type;

export const Staged = Schema.Struct({ ...Attached.fields, path: Schema.String });
export type Staged = typeof Staged.Type;

export const StagedOrRefused = Schema.Union([Staged, Schema.Struct({ refused: Schema.String })]);
export type StagedOrRefused = typeof StagedOrRefused.Type;

export const FILE_CAP = 20 * 1024 * 1024;
export const MESSAGE_CAP = 30 * 1024 * 1024;
export const INLINE_BUDGET = 24 * 1024 * 1024;
export const LONG_EDGE = 2000;

export const SHOWN = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ShownImage = (typeof SHOWN)[number];
export const shownAs = (mediaType: string) =>
  Option.getOrUndefined(Arr.findFirst(SHOWN, (one) => one === mediaType));
export const IMAGE_BYTES = 3.75 * 1024 * 1024;
export const TEXTUAL = /^text\/|json|xml|javascript|yaml|toml|x-sh|^application\/octet-stream$/;

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const capRefusal = (
  held: ReadonlyArray<{ readonly size: number }>,
  adding: { readonly name: string; readonly size: number },
) => {
  if (adding.size > FILE_CAP)
    return `${adding.name} is ${megabytes(adding.size)}, over the 20 MB one file may be.`;
  const total = Arr.reduce(held, adding.size, (sum, one) => sum + one.size);
  return total > MESSAGE_CAP
    ? `With ${adding.name} this message's files come to ${megabytes(total)}, over the 30 MB one message may carry.`
    : null;
};

export const scaledSize = (image: { readonly width: number; readonly height: number }) => {
  const long = Math.max(image.width, image.height);
  if (long <= LONG_EDGE) return null;
  const by = LONG_EDGE / long;
  return { width: Math.round(image.width * by), height: Math.round(image.height * by) };
};

export const imageSize = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number, text: string) =>
    Arr.every(
      Arr.fromIterable(text),
      (c, i) => bytes[at + i] === Option.getOrElse(Str.charCodeAt(c, 0), () => Number.NaN),
    );
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
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
        at += 2 + view.getUint16(at + 2);
      }
  } catch {}
  return null;
};

export const showable = (bytes: Uint8Array) => {
  const size = imageSize(bytes);
  return size !== null && Math.max(size.width, size.height) <= LONG_EDGE;
};

export const pastedImages = (
  items: ReadonlyArray<{ readonly kind: string; readonly type: string }>,
) =>
  Arr.flatMap(items, (item, at) =>
    item.kind === "file" && pipe(item.type, Str.startsWith("image/")) ? [at] : [],
  );

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

export const uriListPaths = (text: string) => {
  const paths: string[] = [];
  const refused: string[] = [];
  for (const line of Arr.map(Str.split(text, /\r?\n/), (one) => Str.trim(one))) {
    if (line === "" || pipe(line, Str.startsWith("#"))) continue;
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

export const clipboardPaths = (text: string) =>
  Arr.flatMap(
    Arr.map(Str.split(text, /\r?\n/), (line) => Str.trim(line)),
    (line) =>
      pipe(line, Str.startsWith("/"))
        ? [line]
        : pipe(line, Str.startsWith("file:"))
          ? uriListPaths(line).paths
          : [],
  );

export const dropKind = (types: ReadonlyArray<string>) =>
  types.includes("text/uri-list") ? "uris" : types.includes("Files") ? "files" : "text";

export const pastedName = (name: string, mediaType: string, at: string) =>
  name !== "" && name !== "image.png"
    ? name
    : `pasted-${pipe(at, Str.slice(0, 19), Str.replaceAll(/[T:]/g, "-"))}.${Str.split(mediaType, "/")[1] ?? "png"}`;

export const ATTACHED = "[Desktop: the human attached these files to this message]";

const LINE = /^- (.+) \(([^,()]+), (\d+) bytes\): (.+)$/;

export const listing = (files: ReadonlyArray<Staged>) =>
  Arr.join(
    [
      ATTACHED,
      ...Arr.map(
        files,
        ({ name, mediaType, size, path }) => `- ${name} (${mediaType}, ${size} bytes): ${path}`,
      ),
    ],
    "\n",
  );

export const fromListing = (text: string) => {
  const [first, ...lines] = Str.split(text, "\n");
  if (first !== ATTACHED) return null;
  return Arr.flatMap(lines, (line) => {
    const [, name, mediaType, size, path] = LINE.exec(line) ?? [];
    if (name === undefined || mediaType === undefined || size === undefined || path === undefined)
      return [];
    return [
      { id: Arr.join(Str.split(path, "/").slice(-2), "/"), name, size: Number(size), mediaType },
    ];
  });
};

export const AttachmentPart = Schema.Struct({
  type: Schema.Literal("document"),
  id: Schema.String,
  source: Schema.Struct({
    type: Schema.Literal("file"),
    value: Schema.String,
    mimeType: Schema.String,
  }),
  metadata: Schema.Struct({ name: Schema.String, size: Schema.Finite }),
});
export type AttachmentPart = typeof AttachmentPart.Type;

export const attachmentPart: (file: Attached) => AttachmentPart = (file) => ({
  type: "document",
  id: file.id,
  source: { type: "file", value: file.id, mimeType: file.mediaType },
  metadata: { name: file.name, size: file.size },
});

const decodePart = Schema.decodeUnknownOption(AttachmentPart);

export const attachedIn = (part: { readonly type: string }) =>
  Option.map(decodePart(part), ({ id, source, metadata }) => ({
    id,
    name: metadata.name,
    size: metadata.size,
    mediaType: source.mimeType,
  }));

export const attachmentsShown = (files: ReadonlyArray<AttachmentFile>) => {
  const sorted = [...files].sort((a, b) => pipe(a.name, Str.localeCompare(b.name)));
  const image = (file: AttachmentFile) => shownAs(file.mediaType) !== undefined;
  return {
    thumbnails: Arr.filter(sorted, image),
    named: Arr.filter(sorted, (file) => !image(file)),
  };
};
