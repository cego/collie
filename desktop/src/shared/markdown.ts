// A Comark plugin for agent-written markdown. No Bun-only import: the view bundles this.

import type { ComarkPlugin, Node } from "comark";

const FILE_LINE = /(?<![\w/:.@-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z]\w*):(\d+)(?![\w:])/g;
const WHOLE_FILE_LINE = new RegExp(`^${FILE_LINE.source}$`);
/** Inside these a `file:line` is something else's text. */
const LEFT_ALONE = new Set(["pre", "a", "code", "file-ref"]);

const referencesIn = (text: string): Array<Node> => {
  const nodes: Array<Node> = [];
  let from = 0;
  for (const found of text.matchAll(FILE_LINE)) {
    if (found.index > from) nodes.push(text.slice(from, found.index));
    nodes.push(["file-ref", { file: found[1], line: found[2] }, found[0]]);
    from = found.index + found[0].length;
  }
  if (from < text.length) nodes.push(text.slice(from));
  return nodes;
};

const confine = (node: Node): Array<Node> => {
  if (!Array.isArray(node)) return referencesIn(node);
  const [tag, attributes, ...children] = node;
  if (tag === null) return [node];
  // A style could lay an overlay across the whole window, and a popover is drawn above it.
  for (const name of Object.keys(attributes))
    if (name === "style" || /^:?popover/i.test(name)) delete attributes[name];
  const [only] = children;
  const whole =
    tag === "code" && children.length === 1 && !Array.isArray(only)
      ? WHOLE_FILE_LINE.exec(only ?? "")
      : null;
  if (whole !== null) return [["file-ref", { file: whole[1], line: whole[2] }, whole[0]]];
  if (LEFT_ALONE.has(tag)) return [node];
  return [[tag, attributes, ...children.flatMap(confine)]];
};

/** Strips every style and popover, and turns each `file:line` outside code and links into a `file-ref`. */
export const confined = (): ComarkPlugin => ({
  name: "confined",
  post: ({ tree }) => {
    tree.nodes = tree.nodes.flatMap(confine);
  },
});
