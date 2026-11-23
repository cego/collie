import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { parseMarkdown } from "comark";
import type { Node } from "comark";
import { SAFE_PLUGINS } from "./markdown";

export const planProgress = (tickets: ReadonlyArray<{ readonly done: boolean }>) =>
  tickets.length === 0
    ? null
    : `${Arr.filter(tickets, ({ done }) => done).length} of ${tickets.length} tickets done`;

export interface SpecHeading {
  readonly level: number;
  readonly text: string;
  readonly position: number;
}

const HEADING = /^h([1-6])$/;

const textOf: (node: Node) => string = (node) => {
  if (!Arr.isArray(node)) return node;
  const [tag, , ...children] = node;
  return tag === null ? "" : Arr.join(Arr.map(children, textOf), "");
};

export const specHeadings = (spec: string) =>
  parseMarkdown(Str.trim(spec), { plugins: SAFE_PLUGINS }).then(({ nodes }) => {
    const found: Array<{ level: number; text: string }> = [];
    const visit = (node: Node) => {
      if (!Arr.isArray(node) || node[0] === null) return;
      const [tag, , ...children] = node;
      const level = HEADING.exec(tag)?.[1];
      if (level !== undefined)
        found.push({
          level: Number(level),
          text: Str.trim(pipe(textOf(node), Str.replaceAll(/\s+/g, " "))),
        });
      else Arr.forEach(children, visit);
    };
    Arr.forEach(nodes, visit);
    return Arr.map(found, (heading, position) => ({ ...heading, position }));
  });
