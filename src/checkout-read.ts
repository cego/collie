import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect } from "effect";
import { whatItSaid } from "./mr";
import type { Ran } from "./mr";

type Git<R> = (args: Array<string>) => Effect.Effect<Ran, never, R>;

export type LiveTip =
  | { readonly _tag: "Present"; readonly sha: string }
  | { readonly _tag: "Gone" }
  | { readonly _tag: "Unreadable"; readonly why: string };

export const liveTip: <R>(git: Git<R>, branch: string) => Effect.Effect<LiveTip, never, R> = (
  git,
  branch,
) =>
  Effect.gen(function* () {
    const read = yield* git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    if (read.code !== 0) {
      return { _tag: "Unreadable", why: whatItSaid(read) } as const;
    }
    const sha = Str.split(Str.trim(read.stdout), "\t")[0] ?? "";
    return sha === "" ? ({ _tag: "Gone" } as const) : ({ _tag: "Present", sha } as const);
  });

export const hiddenEdits: <R>(
  git: Git<R>,
) => Effect.Effect<ReadonlyArray<string> | null, never, R> = (git) =>
  Effect.gen(function* () {
    const listed = yield* git(["ls-files", "-v", "-z"]);
    if (listed.code !== 0) {
      return null;
    }
    const pretend = Arr.filter(
      Arr.filter(Str.split(listed.stdout, "\0"), (one) => one !== ""),
      (one) => pipe(one, Str.startsWith("h ")),
    );
    if (pretend.length === 0) {
      return [];
    }
    const index = yield* git(["ls-files", "-s", "-z"]);
    const saved = new Map(
      Arr.map(
        Arr.filter(Str.split(index.stdout, "\0"), (one) => one !== ""),
        (one) => {
          const [meta, ...path] = Str.split(one, "\t");
          return [Arr.join(path, "\t"), Str.split(meta ?? "", " ")[1] ?? ""] as const;
        },
      ),
    );
    const edited: Array<string> = [];
    for (const entry of pretend) {
      const path = Str.slice(2)(entry);
      const content = yield* git(["hash-object", "--", path]);
      if (content.code === 0 && Str.trim(content.stdout) !== saved.get(path)) {
        edited.push(path);
      }
    }
    return edited;
  });
