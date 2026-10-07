// A Run's evidence files as the drawer shows them. No Bun-only import: the view bundles this.

import type { EvidenceFile } from "../../../src/board-model";

const MEDIA = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["avif", "image/avif"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mov", "video/quicktime"],
  ["ogv", "video/ogg"],
]);

/** An image's or a video's media type, by its extension; null for anything else. */
export const mediaType = (name: string) =>
  MEDIA.get(name.split(".").at(-1)?.toLowerCase() ?? "") ?? null;

const REPORT = /\.html?$/i;

/** One place in the gallery: a before/after pair, or a shot on its own. */
export interface GalleryItem {
  readonly key: string;
  readonly before?: EvidenceFile;
  readonly after?: EvidenceFile;
  readonly alone?: EvidenceFile;
}

/** `before` or `after` as a word of a name: `home.before.png`, `after-cart.jpg`. */
const SIDE = /(^|[._-])(before|after)(?=[._-]|$)/i;

const byName = (a: EvidenceFile, b: EvidenceFile) => a.name.localeCompare(b.name);

export const sortEvidence = (files: ReadonlyArray<EvidenceFile>) => {
  const pairs = new Map<string, { before?: EvidenceFile; after?: EvidenceFile }>();
  const shots: GalleryItem[] = [];
  const alone = (file: EvidenceFile) => shots.push({ key: file.name, alone: file });
  const kind = (file: EvidenceFile) => mediaType(file.name)?.split("/")[0];
  for (const file of [...files].sort(byName).filter((one) => kind(one) === "image")) {
    const side = SIDE.exec(file.name);
    const key = file.name.replace(SIDE, "").replace(/^[._-]/, "");
    const which = side?.[2]!.toLowerCase() === "before" ? "before" : "after";
    const pair = pairs.get(key) ?? {};
    if (side === null || pair[which] !== undefined) alone(file);
    else pairs.set(key, { ...pair, [which]: file });
  }
  for (const [key, { before, after }] of pairs) {
    if (before !== undefined && after !== undefined) shots.push({ key, before, after });
    else alone((before ?? after)!);
  }
  const rest = files.filter((file) => kind(file) !== "image");
  return {
    gallery: shots.sort((a, b) => a.key.localeCompare(b.key)),
    videos: rest.filter((file) => kind(file) === "video").sort(byName),
    reports: rest.filter(({ name }) => REPORT.test(name)).sort(byName),
    files: rest.filter((file) => kind(file) !== "video" && !REPORT.test(file.name)).sort(byName),
  };
};
