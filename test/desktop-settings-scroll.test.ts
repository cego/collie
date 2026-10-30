// Settings is drawn over the board as `absolute inset-0`. Anything absolutely positioned
// inside it (the `sr-only` inputs of its choices) is laid out against the nearest
// positioned ancestor; if that is not the scroll region, it escapes it and the window
// grows a second scrollbar.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  type ElementNode,
  NodeTypes,
  parse,
  type TemplateChildNode,
} from "../desktop/node_modules/@vue/compiler-dom";
import { runEffect } from "./support/effect";

const SCROLLS = /^overflow(-y)?-(auto|scroll)$/;
const POSITIONED = new Set(["relative", "absolute", "fixed", "sticky"]);

const classesOf = (element: ElementNode) =>
  Arr.flatMap(element.props, (prop) =>
    prop.type === NodeTypes.ATTRIBUTE && prop.name === "class" && prop.value
      ? Str.split(prop.value.content, /\s+/)
      : [],
  );

const elementsOf = (nodes: ReadonlyArray<TemplateChildNode>): Array<ElementNode> =>
  Arr.flatMap(nodes, (node) =>
    node.type === NodeTypes.ELEMENT ? [node, ...elementsOf(node.children)] : [],
  );

test("Settings scrolls in one region that contains everything it scrolls", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        new URL("../desktop/view/app/components/SettingsPage.vue", import.meta.url).pathname,
      );
      const template = Arr.findFirst(
        parse(source).children,
        (node): node is ElementNode => node.type === NodeTypes.ELEMENT && node.tag === "template",
      );
      const scrollers = Arr.filter(
        elementsOf(Option.match(template, { onNone: () => [], onSome: (t) => t.children })),
        (element) => Arr.some(classesOf(element), (name) => SCROLLS.test(name)),
      );

      expect(scrollers).toHaveLength(1);
      expect(Arr.some(classesOf(scrollers[0]!), (name) => POSITIONED.has(name))).toBe(true);
    }),
  ));
