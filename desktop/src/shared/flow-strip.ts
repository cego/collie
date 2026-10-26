import type { FlowStrip } from "../../../src/board-model";

type StripGlyph = FlowStrip["glyphs"][number] & { readonly folded?: number };

export const cardFlow = (flow: FlowStrip | undefined) => {
  if (flow === undefined) return null;
  const end = flow.glyphs.length - flow.release;
  const run = flow.glyphs.slice(0, end);
  const done = run.filter((one) => one.state === "done").length;
  let folded = false;
  const glyphs: ReadonlyArray<StripGlyph> =
    run.length <= 10
      ? run
      : run.flatMap((one) => {
          if (one.state !== "done") return [one];
          if (folded) return [];
          folded = true;
          return [{ title: `${done} done`, state: "done" as const, folded: done }];
        });
  const { current } = flow;
  return {
    run: glyphs,
    release: flow.glyphs.slice(end),
    label: current === null ? "Done" : [current.title, current.said].filter(Boolean).join(" · "),
    name:
      current === null
        ? `Flow: ${run.length} of ${run.length} Steps done.`
        : `Flow: ${[current.title, current.said].filter(Boolean).join(", ")}. ${done} of ${run.length} Steps done.`,
  };
};
