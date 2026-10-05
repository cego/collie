// A Run's evidence files as the drawer shows them. No Bun-only import: the view bundles this.

import type { EvidenceFile } from "../../../src/board-model";

export const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
export const VIDEO = /\.(mp4|webm|mov|ogv)$/i;
export const REPORT = /\.html?$/i;
export const LOG = /\.(txt|log|out|json|jsonl|md|xml|csv|ya?ml|tap)$/i;

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
  const halves = new Map<string, { before?: EvidenceFile; after?: EvidenceFile }>();
  const shots: GalleryItem[] = [];
  for (const file of files.filter(({ name }) => IMAGE.test(name))) {
    const side = SIDE.exec(file.name);
    if (side === null) {
      shots.push({ key: file.name, alone: file });
      continue;
    }
    const key = file.name.replace(SIDE, "").replace(/^[._-]/, "");
    const pair = halves.get(key) ?? {};
    halves.set(key, { ...pair, [side[2]!.toLowerCase()]: file });
  }
  for (const [key, { before, after }] of halves) {
    if (before !== undefined && after !== undefined) shots.push({ key, before, after });
    else {
      const alone = (before ?? after)!;
      shots.push({ key: alone.name, alone });
    }
  }
  const rest = files.filter(({ name }) => !IMAGE.test(name));
  return {
    gallery: shots.sort((a, b) => a.key.localeCompare(b.key)),
    videos: rest.filter(({ name }) => VIDEO.test(name)).sort(byName),
    reports: rest.filter(({ name }) => REPORT.test(name)).sort(byName),
    logs: rest.filter(({ name }) => LOG.test(name)).sort(byName),
    others: rest
      .filter(({ name }) => !VIDEO.test(name) && !REPORT.test(name) && !LOG.test(name))
      .sort(byName),
  };
};
