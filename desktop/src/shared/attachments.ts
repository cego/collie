// A file the human gave the Flock chat: what the composer decides before it is sent, what
// the model is told of it, and how the conversation shows it again. No Bun-only import:
// the view bundles this.

import { Option, Schema } from "effect";

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

export const FILE_CAP = 20 * 1024 * 1024;
/** Under the API's 32 MB request, with room for the words and the listing. */
export const MESSAGE_CAP = 30 * 1024 * 1024;
/** The longest edge the API takes in a request of more than 20 images. */
export const LONG_EDGE = 2000;

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

/** Which of a paste's items become attachments: its image files. Anything else pastes as it did. */
export const pastedImages = (
  items: ReadonlyArray<{ readonly kind: string; readonly type: string }>,
) =>
  items.flatMap((item, at) => (item.kind === "file" && item.type.startsWith("image/") ? [at] : []));

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
