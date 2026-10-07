// What the Flock chat's composer decides about a file before it is sent: whether it fits,
// how far an image is scaled, and which pasted data becomes an attachment.

import { expect, test } from "bun:test";
import {
  capRefusal,
  clipboardPaths,
  dropKind,
  uriListPaths,
  fromListing,
  imageSize,
  listing,
  pastedImages,
  pastedName,
  scaledSize,
} from "../desktop/src/shared/attachments";

const MB = 1024 * 1024;

test("a file over 20 MB, or a message over 30 MB, is refused naming the file or the total and the cap", () => {
  expect(capRefusal([], { name: "shot.png", size: 3 * MB })).toBeNull();
  expect(capRefusal([], { name: "dump.bin", size: 21 * MB })).toBe(
    "dump.bin is 21.0 MB, over the 20 MB one file may be.",
  );
  expect(
    capRefusal([{ size: 15 * MB }, { size: 10 * MB }], { name: "third.pdf", size: 6 * MB }),
  ).toBe(
    "With third.pdf this message's files come to 31.0 MB, over the 30 MB one message may carry.",
  );
  expect(capRefusal([{ size: 15 * MB }], { name: "second.pdf", size: 15 * MB })).toBeNull();
});

test("an image is scaled to 2000 px on its long edge, and never up", () => {
  expect(scaledSize({ width: 4000, height: 3000 })).toEqual({ width: 2000, height: 1500 });
  expect(scaledSize({ width: 1080, height: 4320 })).toEqual({ width: 500, height: 2000 });
  expect(scaledSize({ width: 2000, height: 1200 })).toBeNull();
  expect(scaledSize({ width: 640, height: 480 })).toBeNull();
});

test("an image's size is read from its header, and null where the header says nothing", () => {
  const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const le16 = (n: number) => [n & 255, n >>> 8];
  const le24 = (n: number) => [n & 255, (n >>> 8) & 255, n >>> 16];
  const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
  const png = [
    0x89,
    ...ascii("PNG\r\n\x1a\n"),
    0,
    0,
    0,
    13,
    ...ascii("IHDR"),
    ...be32(2560),
    ...be32(1600),
  ];
  const gif = [...ascii("GIF89a"), ...le16(640), ...le16(480)];
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x0b, 0xb8, 0x0f, 0xa0];
  const vp8x = [
    ...ascii("RIFF"),
    0,
    0,
    0,
    0,
    ...ascii("WEBPVP8X"),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...le24(2999),
    ...le24(1999),
  ];
  const of = (bytes: number[]) => imageSize(new Uint8Array(bytes));
  expect(of(png)).toEqual({ width: 2560, height: 1600 });
  expect(of(gif)).toEqual({ width: 640, height: 480 });
  expect(of(jpeg)).toEqual({ width: 4000, height: 3000 });
  expect(of(vp8x)).toEqual({ width: 3000, height: 2000 });
  expect(of(ascii("PNG!"))).toBeNull();
});

test("a pasted image file becomes an attachment, and pasted text stays text", () => {
  expect(
    pastedImages([
      { kind: "string", type: "text/plain" },
      { kind: "file", type: "image/png" },
      { kind: "string", type: "text/html" },
    ]),
  ).toEqual([1]);
  expect(pastedImages([{ kind: "string", type: "text/plain" }])).toEqual([]);
  expect(pastedImages([{ kind: "file", type: "application/pdf" }])).toEqual([]);
});

test("a pasted image with no name of its own is named by when it was pasted", () => {
  expect(pastedName("image.png", "image/png", "2026-10-07T10:15:02.123Z")).toBe(
    "pasted-2026-10-07-10-15-02.png",
  );
  expect(pastedName("", "image/jpeg", "2026-10-07T10:15:02.123Z")).toBe(
    "pasted-2026-10-07-10-15-02.jpeg",
  );
  expect(pastedName("diagram.png", "image/png", "2026-10-07T10:15:02.123Z")).toBe("diagram.png");
});

test("Desktop's listing of a message's files reads back as the files it lists", () => {
  const sha = "a".repeat(64);
  const files = [
    {
      id: `${sha}/my shot (1).png`,
      name: "my shot (1).png",
      size: 2048,
      mediaType: "image/png",
      path: `/state/collie-desktop/attachments/${sha}/my shot (1).png`,
    },
  ];
  const text = listing(files);
  expect(text).toContain(`- my shot (1).png (image/png, 2048 bytes): ${files[0]!.path}`);
  expect(fromListing(text)).toEqual([
    { id: `${sha}/my shot (1).png`, name: "my shot (1).png", size: 2048, mediaType: "image/png" },
  ]);
  expect(fromListing("what is this?")).toBeNull();
});

test("copied files arrive as a uri-list of file:// URIs, read as paths, and anything else is refused", () => {
  expect(
    uriListPaths(
      "# copied\r\nfile:///home/mk/Pictures/my%20shot.png\r\nfile://localhost/tmp/log.txt\r\nhttps://example.com/x.png\r\nfile://other-host/etc/passwd\r\nfile:///tmp/50%off.png\r\n",
    ),
  ).toEqual({
    paths: ["/home/mk/Pictures/my shot.png", "/tmp/log.txt"],
    refused: [
      "https://example.com/x.png is not a file on this computer",
      "file://other-host/etc/passwd is not a file on this computer",
      "file:///tmp/50%off.png is not a file on this computer",
    ],
  });
});

test("a drop of files is told from a drop of text", () => {
  expect(dropKind(["text/uri-list", "text/plain"])).toBe("uris");
  expect(dropKind(["Files"])).toBe("files");
  expect(dropKind(["text/plain"])).toBe("text");
});

test("files the system clipboard names as text are read as paths, and nothing else is", () => {
  expect(clipboardPaths("file:///tmp/a%20b.png\n/home/mk/c.txt\nhello")).toEqual([
    "/tmp/a b.png",
    "/home/mk/c.txt",
  ]);
});
