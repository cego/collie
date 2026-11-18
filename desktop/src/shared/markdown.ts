// A Comark plugin for agent-written markdown. No Bun-only import: the view bundles this.

import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";

import type { ComarkPlugin, ElementNodeAttributes, Node } from "comark";
import security from "comark/plugins/security";
import { shortUrl } from "./links";

const FILE_LINE = /(?<![\w/:.@-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z]\w*):(\d+)(?![\w:])/g;
const WHOLE_FILE_LINE = new RegExp(`^${FILE_LINE.source}$`);
const WEB_URL = /^https?:\/\/\S+$/i;
/** Inside these a `file:line` is something else's text. */
const LEFT_ALONE = new Set(["pre", "a", "code", "file-ref"]);

const referencesIn = (text: string) => {
  const nodes: Array<Node> = [];
  let from = 0;
  for (const found of pipe(text, Str.matchAll(FILE_LINE))) {
    if ((found.index ?? 0) > from) nodes.push(pipe(text, Str.slice(from, found.index)));
    nodes.push(["file-ref", { file: found[1], line: found[2] }, found[0]]);
    from = (found.index ?? 0) + found[0].length;
  }
  if (from < text.length) nodes.push(pipe(text, Str.slice(from)));
  return nodes;
};

/**
 * Whether an attribute could run script once rendered. A component's own URL prop, such as
 * a card's `to`, is not checked by the security plugin; a binding is decoded as JSON, or
 * else read from the frontmatter, which an agent writes too.
 */
const scripted = (attributes: ElementNodeAttributes, name: string) => {
  let rendered = String(JSON.stringify(attributes[name]));
  if (pipe(name, Str.startsWith(":")))
    try {
      rendered = JSON.stringify(JSON.parse(String(attributes[name])));
    } catch {
      return true;
    }
  // A URL's scheme survives whitespace and control characters, which JSON writes escaped.
  return /javascript:/i.test(pipe(rendered, Str.replace(/\\(?:[bfnrt]|u00[01][\da-f])|\s/gi, "")));
};

const decoded = (href: string) => {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
};

const confine = (referenced: boolean) => (node: Node) => {
  if (!Arr.isArray<typeof node>(node)) {
    const returned: Array<Node> = referenced ? referencesIn(node) : [node];
    return returned;
  }
  const [tag, attributes, ...children] = node;
  if (tag === null) {
    const returned: Array<Node> = [node];
    return returned;
  }
  // A style could lay an overlay across the whole window; a popover, or a dialog a command
  // opens, is drawn above it.
  for (const name of Struct.keys(attributes))
    if (/^:?(style|popover\w*|command\w*|closedby)$/i.test(name) || scripted(attributes, name))
      delete attributes[name];
  const [only] = children;
  const text = children.length === 1 && !Arr.isArray<typeof only>(only) ? (only ?? "") : null;
  const whole = referenced && tag === "code" && text !== null ? WHOLE_FILE_LINE.exec(text) : null;
  if (whole !== null) {
    const returned: Array<Node> = [["file-ref", { file: whole[1], line: whole[2] }, whole[0]]];
    return returned;
  }
  const href = String(attributes.href);
  if (tag === "a" && text !== null && WEB_URL.test(href) && [href, decoded(href)].includes(text)) {
    const returned: Array<Node> = [["a", { ...attributes, title: href }, shortUrl(text)]];
    return returned;
  }
  if (referenced && tag === "code" && text !== null && WEB_URL.test(text)) {
    const returned: Array<Node> = [
      ["a", { href: text, title: text }, ["code", {}, shortUrl(text)]],
    ];
    return returned;
  }
  const returned: Array<Node> = [
    [tag, attributes, ...Arr.flatMap(children, confine(referenced && !LEFT_ALONE.has(tag)))],
  ];
  return returned;
};

/**
 * Strips every style, popover, command and script URL; turns each `file:line` outside code
 * and links into a `file-ref`; shortens a link that is its own URL; links inline-code URLs.
 */
export const confined: () => ComarkPlugin = () => ({
  name: "confined",
  post: ({ tree }) => {
    tree.nodes = Arr.flatMap(tree.nodes, confine(true));
  },
});

/** What every view of agent-written markdown parses it with, before its own drawing plugins. */
export const SAFE_PLUGINS = [
  security({
    blockedTags: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "base",
      "link",
      "meta",
      // Modal, so it would make the whole window inert.
      "dialog",
    ],
    // Nothing is fetched from the network: an image a Run kept is evidence, read from its host.
    allowedImagePrefixes: ["data:image/"],
  }),
  confined(),
];
