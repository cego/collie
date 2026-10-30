// A Run's evidence files as the record shows them. No Bun-only import: the view bundles this.

import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import type { EvidenceFile, RunDetail } from "../../../src/board-model";
import type { LinkCard } from "./links";

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
  MEDIA.get(
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(Str.split(name, ".").at(-1)), (present) =>
        Str.toLowerCase(present),
      ),
    ) ?? "",
  ) ?? null;

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

const byName = (a: EvidenceFile, b: EvidenceFile) => pipe(a.name, Str.localeCompare(b.name));

export const sortEvidence = (files: ReadonlyArray<EvidenceFile>) => {
  const pairs = new Map<string, { before?: EvidenceFile; after?: EvidenceFile }>();
  const shots: GalleryItem[] = [];
  const alone = (file: EvidenceFile) => shots.push({ key: file.name, alone: file });
  const kind = (file: EvidenceFile) =>
    Option.getOrUndefined(
      Option.map(
        Option.fromNullishOr(mediaType(file.name)),
        (present_) => Str.split(present_, "/")[0],
      ),
    );
  for (const file of Arr.filter([...files].sort(byName), (one) => kind(one) === "image")) {
    const side = SIDE.exec(file.name);
    const key = pipe(file.name, Str.replace(SIDE, ""), Str.replace(/^[._-]/, ""));
    const which =
      Str.toLowerCase(
        Option.getOrUndefined(Option.map(Option.fromNullishOr(side), (present__) => present__[2]))!,
      ) === "before"
        ? "before"
        : "after";
    const pair = pairs.get(key) ?? {};
    if (side === null || pair[which] !== undefined) alone(file);
    else pairs.set(key, { ...pair, [which]: file });
  }
  for (const [key, { before, after }] of pairs) {
    if (before !== undefined && after !== undefined) shots.push({ key, before, after });
    else alone((before ?? after)!);
  }
  const rest = Arr.filter(files, (file) => kind(file) !== "image");
  return {
    gallery: shots.sort((a, b) => pipe(a.key, Str.localeCompare(b.key))),
    videos: Arr.filter(rest, (file) => kind(file) === "video").sort(byName),
    reports: Arr.filter(rest, ({ name }) => REPORT.test(name)).sort(byName),
    files: Arr.filter(rest, (file) => kind(file) !== "video" && !REPORT.test(file.name)).sort(
      byName,
    ),
  };
};

/** Whether the Evidence tab has anything above its Metrics, which do not count. */
export const hasEvidence = ({
  verifications,
  evidence,
  handoffFiles,
  links,
}: Pick<RunDetail, "verifications" | "evidence" | "handoffFiles"> & {
  readonly links: ReadonlyArray<LinkCard>;
}) => Arr.some([verifications, evidence, handoffFiles ?? [], links], (kind) => kind.length > 0);
