// The web links a Run produced, as cards. No Bun-only import: the view bundles this.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import {
  type MrDetails,
  type MrPanel,
  type MrRef,
  mrWords,
  parseMrUrl,
  readMrRef,
} from "../../../src/board-model";

const capital = (text: string) => `${Str.toUpperCase(text[0]!)}${pipe(text, Str.slice(1))}`;

/** What a Run's record calls its merge request's tab: `Merge request`, or `Pull request` on GitHub. */
export const mrTab = (mr: string | null) => {
  const ref = mr === null ? null : readMrRef(mr);
  return capital(ref === null ? "merge request" : mrWords(ref).noun);
};

/** A merge request panel's title (`!42` or `#30`) and what its checks are called there. */
export const mrHeading = (mr: MrRef) => {
  const words = mrWords(mr);
  return { title: `${words.sign}${mr.iid}`, checks: capital(words.checks) };
};

/** Where a merge request's checks are read: GitLab's pipelines, GitHub's checks tab. */
const checksUrl = (mr: MrDetails) =>
  `${mr.url}/${mrWords(mr).checks === "checks" ? "checks" : "pipelines"}`;

export interface LinkCard {
  readonly kind: "artifact" | "mr" | "pipeline" | "link";
  readonly url: string;
  readonly title: string;
  readonly status?: string;
}

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"'`)\]\\]+/g;
const ARTIFACT = /^https:\/\/claude\.ai\/(?:[^/]+\/)*artifacts?\//;
const PIPELINE = /\/-\/pipelines\/(\d+)(?:[/?#]|$)/;

const where = (url: string) => pipe(url, Str.replace(/^https?:\/\//, ""), Str.replace(/\/$/, ""));

/** A URL without its scheme or trailing slash, elided in the middle past 60. */
export const shortUrl = (url: string) => {
  const shown = where(url);
  return shown.length > 60
    ? `${pipe(shown, Str.slice(0, 40))}…${pipe(shown, Str.slice(-15))}`
    : shown;
};

const cardOf = (url: string, given: string | undefined, mr: MrDetails | null): LinkCard => {
  if (url === mr?.url) return { kind: "mr", url, title: mr.title, status: mr.state };
  if (mr !== null && url === checksUrl(mr)) {
    const heading = mrHeading(mr);
    return {
      kind: "pipeline",
      url,
      title: `${heading.checks} of ${heading.title}`,
      status: mr.pipeline,
    };
  }
  if (ARTIFACT.test(url)) return { kind: "artifact", url, title: given ?? "Claude artifact" };
  const pipeline = PIPELINE.exec(url);
  if (pipeline) return { kind: "pipeline", url, title: given ?? `Pipeline #${pipeline[1]}` };
  const other = parseMrUrl(url);
  if (other) return { kind: "mr", url, title: given ?? mrHeading(other).title };
  return { kind: "link", url, title: given ?? where(url) };
};

/**
 * Each link once, in the order first named, titled by the first markdown text it was given;
 * then the merge request and its pipelines, where the Run has them.
 */
export const webLinks = ({
  texts,
  mr,
}: {
  readonly texts: ReadonlyArray<string>;
  readonly mr: MrPanel | null;
}): ReadonlyArray<LinkCard> => {
  const details = mr?._tag === "Details" ? mr : null;
  const own =
    details === null ? [] : [details.url, details.pipeline === "" ? "" : checksUrl(details)];
  const titles = new Map<string, string | undefined>();
  for (const text of [...texts, ...own])
    for (const [bare, given, marked] of pipe(text, Str.matchAll(LINK))) {
      const url = marked ?? pipe(bare, Str.replace(/[.,;:!?]+$/, ""));
      if (titles.get(url) === undefined) titles.set(url, given);
    }
  return Arr.map([...titles], ([url, given]) => cardOf(url, given, details));
};
