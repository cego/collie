import * as Arr from "effect/Array";
import type { FlowStrip } from "../../../src/board-model";

type StripGlyph = FlowStrip["glyphs"][number] & { readonly folded?: number };

export const cardFlow = (flow: FlowStrip | undefined) => {
  if (flow === undefined) return null;
  const end = flow.glyphs.length - flow.release;
  const run = flow.glyphs.slice(0, end);
  const done = Arr.filter(run, (one) => one.state === "done").length;
  let folded = false;
  const glyphs: ReadonlyArray<StripGlyph> =
    run.length <= 10
      ? run
      : Arr.flatMap(run, (one) => {
          if (one.state !== "done") return [one];
          if (folded) return [];
          folded = true;
          return [{ title: `${done} done`, state: "done" as const, folded: done }];
        });
  const { current } = flow;
  return {
    run: glyphs,
    release: flow.glyphs.slice(end),
    label:
      current === null
        ? "Done"
        : Arr.join(
            Arr.map(Arr.filter([current.title, current.said], Boolean), (part) =>
              part === null || part === undefined ? "" : globalThis.String(part),
            ),
            " · ",
          ),
    name:
      current === null
        ? `Flow: ${run.length} of ${run.length} Steps done.`
        : `Flow: ${Arr.join(
            Arr.map(Arr.filter([current.title, current.said], Boolean), (part) =>
              part === null || part === undefined ? "" : globalThis.String(part),
            ),
            ", ",
          )}. ${done} of ${run.length} Steps done.`,
  };
};
