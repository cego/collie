// The web links a Run produced, as cards. No Bun-only import: the view bundles this.

import { type MrDetails, type MrPanel, parseMrUrl } from "../../../src/board-model";

export interface LinkCard {
  readonly kind: "artifact" | "mr" | "pipeline" | "link";
  readonly url: string;
  readonly title: string;
  readonly status?: string;
}

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"'`)\]\\]+/g;
const ARTIFACT = /^https:\/\/claude\.ai\/(?:[^/]+\/)*artifacts?\//;
const PIPELINE = /\/-\/pipelines\/(\d+)(?:[/?#]|$)/;

const where = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

const cardOf = (url: string, given: string | undefined, mr: MrDetails | null): LinkCard => {
  if (url === mr?.url) return { kind: "mr", url, title: mr.title, status: mr.state };
  if (url === `${mr?.url}/pipelines`)
    return { kind: "pipeline", url, title: `Pipeline of !${mr?.iid}`, status: mr?.pipeline };
  if (ARTIFACT.test(url)) return { kind: "artifact", url, title: given ?? "Claude artifact" };
  const pipeline = PIPELINE.exec(url);
  if (pipeline) return { kind: "pipeline", url, title: given ?? `Pipeline #${pipeline[1]}` };
  const other = parseMrUrl(url);
  if (other) return { kind: "mr", url, title: given ?? `!${other.iid}` };
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
    details === null
      ? []
      : [details.url, details.pipeline === "" ? "" : `${details.url}/pipelines`];
  const titles = new Map<string, string | undefined>();
  for (const text of [...texts, ...own])
    for (const [bare, given, marked] of text.matchAll(LINK)) {
      const url = marked ?? bare.replace(/[.,;:!?]+$/, "");
      if (titles.get(url) === undefined) titles.set(url, given);
    }
  return [...titles].map(([url, given]) => cardOf(url, given, details));
};
