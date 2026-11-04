// Defer Babel's per-file startup cost until a file loads JSX or Solid.

import { plugin, type OnLoadCallback, type PluginBuilder } from "bun";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

interface Handler {
  readonly filter: RegExp;
  readonly load: OnLoadCallback;
}

let handlers: Promise<ReadonlyArray<Handler>> | undefined;
const solid = () =>
  (handlers ??= import("@opentui/solid/bun-plugin").then(({ default: real }) => {
    const found: Handler[] = [];
    const recorder = {
      onLoad: ({ filter }: { filter: RegExp }, load: OnLoadCallback) => {
        found.push({ filter, load });
        return recorder;
      },
    };
    // SAFETY: this plugin's setup only calls onLoad.
    void real.setup(recorder as PluginBuilder);
    return found;
  }));

const LOADS = [
  /[/\\]node_modules[/\\]solid-js[/\\](store[/\\])?dist[/\\]server\.js(?:[?#].*)?$/,
  /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/,
];

plugin({
  name: "solid-on-demand",
  setup: (build) => {
    for (const filter of LOADS)
      build.onLoad({ filter }, (args) =>
        solid().then((found) => {
          const handler = Arr.findFirst(found, (one) => one.filter.test(args.path));
          if (Option.isNone(handler)) throw new Error(`no Solid transform loads ${args.path}`);
          return handler.value.load(args);
        }),
      );
  },
});
