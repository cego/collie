// A card's merge requests, each with its own Open, and across the Flock each shown once.

import * as Arr from "effect/Array";
import {
  mrId,
  mrReadiness,
  mrWords,
  openMrLabel,
  readMrRef,
  type TaskMr,
  type TaskView,
} from "../../../src/board-model";
import type { FlockCards } from "./flock";

export interface CardMr {
  readonly id: string;
  readonly line: string;
  readonly open: { readonly label: string; readonly url: string } | null;
}

/** A Machine's Task holding a merge request, which a link opens. */
export interface MrLink {
  readonly key: string;
  readonly machine: string;
  readonly installation: string;
}

export interface FlockMr extends CardMr {
  readonly links: ReadonlyArray<MrLink>;
}

/** An older host's single merge request, as the list would have named it. */
const scalarOf = (task: TaskView): ReadonlyArray<TaskMr> => {
  const ref = task.mr === null ? null : readMrRef(task.mr);
  if (ref === null || task.mr === null) return [];
  const words = mrWords(ref);
  return [
    {
      id: mrId(task.mr) ?? task.mr,
      mr: task.mr,
      label: words.label,
      short: words.short,
      url: words.url,
      run: task.run,
      state: task.mrState,
      checks: task.checks ?? null,
      head: null,
      ready: task.ready ?? false,
      disposition: task.disposition,
      waitsOn: [],
    },
  ];
};

export const cardMrs = (task: TaskView): ReadonlyArray<CardMr> => {
  const mrs = task.mrs ?? scalarOf(task);
  const several = mrs.length > 1;
  return Arr.map(mrs, (one) => {
    const ref = readMrRef(one.mr) ?? readMrRef(`mr:${one.id}`);
    const url = one.url ?? (ref === null ? null : mrWords(ref).url);
    return {
      id: one.id,
      line: `${one.short} · ${mrReadiness(one, mrs)}`,
      open:
        ref === null || url === null
          ? null
          : { label: openMrLabel(ref, false, several ? one.short : undefined), url },
    };
  });
};

/**
 * The merge requests each card draws, by card key. One that several Machines' Tasks hold is
 * drawn once, on the first of their cards in board order, with a link to each; a card draws
 * its own only where it has several or another Machine holds one too.
 */
export const flockMrs = (cards: FlockCards): ReadonlyMap<string, ReadonlyArray<FlockMr>> => {
  const shown = new Map<string, { readonly mr: CardMr; readonly links: Array<MrLink> }>();
  const firstOn = new Map<string, Array<string>>();
  const held = new Map<string, number>();
  for (const task of cards.tasks) {
    const { key, machine, installation } = cards.placedOf(task);
    const mrs = cardMrs(task);
    held.set(key, mrs.length);
    for (const mr of mrs) {
      const seen = shown.get(mr.id);
      if (seen === undefined) {
        shown.set(mr.id, { mr, links: [{ key, machine, installation }] });
        firstOn.set(key, [...(firstOn.get(key) ?? []), mr.id]);
      } else if (!Arr.some(seen.links, (link) => link.key === key))
        seen.links.push({ key, machine, installation });
    }
  }
  const drawn = new Map<string, ReadonlyArray<FlockMr>>();
  for (const [key, ids] of firstOn) {
    const rows = Arr.map(ids, (id): FlockMr => {
      // SAFETY: every id in `firstOn` was put in `shown` with it.
      const { mr, links } = shown.get(id)!;
      return { ...mr, links };
    });
    if (held.get(key)! > 1 || Arr.some(rows, ({ links }) => links.length > 1)) drawn.set(key, rows);
  }
  return drawn;
};
