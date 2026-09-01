// Forking: take a baseline definition into a later Layer so it can be edited
// without touching the team baseline. Two shapes, and the first is the default:
// a stub that `extends:` the parent and names only what you came to change, or a
// full copy that stops tracking the parent altogether.

import { Effect, FileSystem, Path, type PlatformError } from "effect";
import { contentHash } from "./definitions";
import { unsafePathComponent } from "./naming";

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
      : renamed(stamped(sourceText, yield* contentHash(sourceText)), sourceName, name);

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

/** `forked_from_hash` goes in the frontmatter, which is the first block of the file. */
function stamped(text: string, hash: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return `---\nforked_from_hash: ${hash}\n---\n\n${text}`;
  lines.splice(1, 0, `forked_from_hash: ${hash}`);
  return lines.join("\n");
}

function renamed(text: string, source: string, target: string): string {
  return source === target
    ? text
    : text.replace(new RegExp(`(^name:\\s*)${source}$`, "m"), `$1${target}`);
}

/**
 * The smallest file that changes one thing. Everything not named here is still the
 * parent's, so the stub is what the fork is actually for, and nothing else.
 */
function stub(name: string, parent: string, kind: DefinitionKind, opts: ForkOptions): string {
  const head = ["---", `name: ${name}`, `extends: ${parent}`];
  const body: string[] = [];
  if (kind === "workflows" && opts.step) {
    head.push(
      "steps:",
      `  - id: ${opts.step}`,
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
