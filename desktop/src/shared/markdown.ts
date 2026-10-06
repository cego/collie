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

const scripted = (value: unknown): boolean =>
  typeof value === "string"
    ? /javascript:/i.test(value.replace(/[\s\0-\x1f]/g, ""))
    : typeof value === "object" && value !== null && Object.values(value).some(scripted);

/**
 * Whether a value could run script once rendered. A component's own URL prop, such as a
 * card's `to`, is not checked by the security plugin; a binding is decoded as JSON, or else
 * read from the frontmatter, which an agent writes too.
 */
const unsafe = (name: string, value: unknown) => {
  if (!name.startsWith(":") || typeof value !== "string") return scripted(value);
  try {
    return scripted(JSON.parse(value));
  } catch {
    return true;
  }
};

const confine =
  (referenced: boolean) =>
  (node: Node): Array<Node> => {
    if (!Array.isArray(node)) return referenced ? referencesIn(node) : [node];
    const [tag, attributes, ...children] = node;
    if (tag === null) return [node];
    // A style could lay an overlay across the whole window; a popover, or a dialog a command
    // opens, is drawn above it.
    for (const [name, value] of Object.entries(attributes))
      if (/^:?(style|popover\w*|command\w*|closedby)$/i.test(name) || unsafe(name, value))
        delete attributes[name];
    const [only] = children;
    const whole =
      referenced && tag === "code" && children.length === 1 && !Array.isArray(only)
        ? WHOLE_FILE_LINE.exec(only ?? "")
        : null;
    if (whole !== null) return [["file-ref", { file: whole[1], line: whole[2] }, whole[0]]];
    return [[tag, attributes, ...children.flatMap(confine(referenced && !LEFT_ALONE.has(tag)))]];
  };

/** Strips every style, popover, command and script URL, and turns each `file:line` outside code and links into a `file-ref`. */
export const confined = (): ComarkPlugin => ({
  name: "confined",
  post: ({ tree }) => {
    tree.nodes = tree.nodes.flatMap(confine(true));
  },
});
