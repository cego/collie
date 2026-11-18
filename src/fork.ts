import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Path } from "effect";
import { bodySections, contentHash } from "./definitions";
import { unsafePathComponent } from "./naming";
import { setFrontmatterKey, yamlScalar } from "./yaml";

export type DefinitionKind = "workflows" | "personas";

export interface ForkResult {
  ok: boolean;
  path: string;
  message: string;
}

export interface ForkOptions {
  name?: string;
  full?: boolean;
  step?: string;
  section?: string;
}

export interface ForkSource {
  path: string;
  kind: DefinitionKind;
  steps: ReadonlyArray<string>;
  body: string;
}

export const forkResolvedDefinition = Effect.fn("Fork.forkResolvedDefinition")(function* (
  source: ForkSource,
  targetDir: string,
  opts: Omit<ForkOptions, "section"> = {},
) {
  if (opts.step && !source.steps.includes(opts.step)) {
    return {
      ok: false as const,
      code: "invalid_input" as const,
      path: "",
      message: `definition has no Step "${opts.step}"`,
    };
  }
  return yield* forkDefinition(source.path, source.kind, targetDir, {
    ...opts,
    section: opts.step ? bodySections(source.body).sections.get(opts.step) : undefined,
  });
});

export const forkDefinition = Effect.fn("Fork.forkDefinition")(function* (
  source: string,
  kind: DefinitionKind,
  targetDir: string,
  opts: ForkOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const dir = pathSvc.join(targetDir, kind);
  const sourceName = pathSvc.basename(source, ".md");
  const name = opts.name ?? sourceName;
  const path = pathSvc.join(dir, `${name}.md`);

  const unsafe = unsafePathComponent(name);
  if (unsafe)
    return {
      ok: false as const,
      code: "invalid_input" as const,
      path,
      message: `target name "${name}" ${unsafe}`,
    };

  if (path === source) {
    return {
      ok: false as const,
      code: "target_exists" as const,
      path,
      message: `${pathSvc.basename(source)} is already in that layer`,
    };
  }
  yield* fs.makeDirectory(dir, { recursive: true });
  const sourceText = opts.full ? yield* fs.readFileString(source) : null;
  const text =
    sourceText === null
      ? stub(name, sourceName, kind, opts)
      : copied(sourceText, yield* contentHash(sourceText), sourceName, name);

  const exists = yield* fs.writeFileString(path, text, { flag: "wx" }).pipe(
    Effect.as(false),
    Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(true)),
  );
  if (exists)
    return {
      ok: false as const,
      code: "target_exists" as const,
      path,
      message: `${path} already exists — edit it instead`,
    };

  return opts.full
    ? {
        ok: true as const,
        path,
        message: `copied to ${path} (a full copy: it no longer follows the original)`,
      }
    : {
        ok: true as const,
        path,
        message: `wrote ${path} — it extends the original and changes only what you add`,
      };
});

function copied(text: string, hash: string, source: string, target: string) {
  const stamped = setFrontmatterKey(text, "forked_from_hash", hash);
  return source === target ? stamped : setFrontmatterKey(stamped, "name", target);
}

function stub(name: string, parent: string, kind: DefinitionKind, opts: ForkOptions) {
  const head = ["---", `name: ${yamlScalar(name)}`, `extends: ${yamlScalar(parent)}`];
  const body: string[] = [];
  if (kind === "workflows" && opts.step) {
    head.push(
      "steps:",
      `  - id: ${yamlScalar(opts.step)}`,
      `    # Only the keys you change; the rest stay the original's.`,
    );
    body.push(
      `## ${opts.step}`,
      "",
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(opts.section), (present) => Str.trim(present)),
      ) || "Your version of this step's prompt.",
    );
  } else {
    head.push("# Add the keys you are changing; the rest stay the original's.");
    body.push(
      "Add a `## <section>` for each part of the original you are replacing; every",
      "section you leave out is still the original's.",
    );
  }
  head.push("---");
  return `${Arr.join(
    Arr.filter([Arr.join(head, "\n"), Arr.join(body, "\n")], (p) => Boolean(Str.trim(p))),
    "\n\n",
  )}\n`;
}
