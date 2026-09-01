// Forking: take a baseline definition into a later Layer so it can be edited
// without touching the team baseline. Two shapes, and the first is the default:
// a stub that `extends:` the parent and names only what you came to change, or a
// full copy that stops tracking the parent altogether.

import { Effect, FileSystem, Path, type PlatformError } from "effect";
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
  /** Filename/frontmatter name for a fork that is not shadowing its parent. */
  name?: string;
  /** A whole copy instead of an `extends:` stub: it stops following the parent. */
  full?: boolean;
  /** The step a workflow stub names, so there is something to edit in it. */
  step?: string;
  /** The parent's body, so a stub can carry the section it is overriding. */
  section?: string;
}

export interface ForkSource {
  path: string;
  kind: DefinitionKind;
  steps: ReadonlyArray<string>;
  body: string;
}

/** The operation both front doors use: validate the selected part, then write once. */
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

/** Never overwrites: an existing fork is the one you already edited. */
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
    Effect.catch((cause: PlatformError.PlatformError) =>
      cause.reason._tag === "AlreadyExists" ? Effect.succeed(true) : Effect.fail(cause),
    ),
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

/**
 * A full copy records the parent it was taken from — over any hash it inherited, which
 * would otherwise be its grandparent's — and answers to its own name, since the parent's
 * frontmatter name would make the copy shadow it instead of being found as the fork.
 */
function copied(text: string, hash: string, source: string, target: string): string {
  const stamped = setFrontmatterKey(text, "forked_from_hash", hash);
  return source === target ? stamped : setFrontmatterKey(stamped, "name", target);
}

/**
 * The smallest file that changes one thing. Everything not named here is still the
 * parent's, so the stub is what the fork is actually for, and nothing else.
 */
function stub(name: string, parent: string, kind: DefinitionKind, opts: ForkOptions): string {
  const head = ["---", `name: ${yamlScalar(name)}`, `extends: ${yamlScalar(parent)}`];
  const body: string[] = [];
  if (kind === "workflows" && opts.step) {
    head.push(
      "steps:",
      `  - id: ${yamlScalar(opts.step)}`,
      `    # Only the keys you change; the rest stay the original's.`,
    );
    body.push(`## ${opts.step}`, "", opts.section?.trim() || "Your version of this step's prompt.");
  } else {
    head.push("# Add the keys you are changing; the rest stay the original's.");
    body.push(
      "Add a `## <section>` for each part of the original you are replacing; every",
      "section you leave out is still the original's.",
    );
  }
  head.push("---");
  return `${[head.join("\n"), body.join("\n")].filter((p) => p.trim()).join("\n\n")}\n`;
}
