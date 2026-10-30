import { Effect, FileSystem, Option, Path, Schema } from "effect";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { parseDocument } from "./yaml";
import { isString } from "./schema";

/** The Claude Code that first honours `skillOverrides`. */
export const SKILL_OVERRIDES_VERSION = "2.1.129";
export const MAIN_CHECKOUT_SKILLS_VERSION = "2.1.277";

interface Where {
  /** Claude's own config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  readonly claudeDir: string;
  readonly cwd: string;
  readonly mainCheckoutSkills?: boolean;
}

const Overrides = Schema.fromJsonString(
  Schema.Struct({
    skillOverrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
);
const decodeOverrides = Schema.decodeOption(Overrides);

/** Shorten unnamed skills while preserving operator choices and invocation restrictions. */
export const quietSkills = Effect.fn("SkillOverrides.quiet")(function* (
  where: Where,
  kept: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const claudeDir = path.resolve(where.cwd, where.claudeDir);
  const read = (file: string) => fs.readFileString(file).pipe(Effect.option);
  const projects: string[] = [];
  const settingsDirs = [claudeDir];
  let inRepository = false;
  for (let dir = path.resolve(where.cwd); ; dir = path.dirname(dir)) {
    projects.push(`${dir}/.claude`);
    if (yield* fs.exists(`${dir}/.git`)) {
      inRepository = true;
      const gitfile = yield* read(`${dir}/.git`);
      if (Option.isSome(gitfile) && pipe(gitfile.value, Str.startsWith("gitdir: "))) {
        const gitdir = path.resolve(dir, pipe(gitfile.value, Str.slice(8), Str.trim));
        const common = yield* read(`${gitdir}/commondir`);
        if (Option.isSome(common)) {
          const main = `${path.dirname(path.resolve(gitdir, Str.trim(common.value)))}/.claude`;
          settingsDirs.push(main);
          if (where.mainCheckoutSkills !== false && !(yield* fs.exists(`${dir}/.claude/skills`)))
            projects.push(main);
        }
      }
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  if (!inRepository) projects.splice(1);
  settingsDirs.push(...projects);
  const decided = new Set<string>();
  for (const file of Arr.flatMap(settingsDirs, (dir) => [
    `${dir}/settings.json`,
    `${dir}/settings.local.json`,
  ])) {
    const text = yield* read(file);
    if (Option.isNone(text)) continue;
    const settings = decodeOverrides(text.value);
    if (Option.isSome(settings))
      for (const name of Rec.keys(settings.value.skillOverrides ?? {})) decided.add(name);
  }
  const candidates: string[] = [];
  for (const base of [claudeDir, ...projects]) {
    for (const kind of ["skills", "commands"]) {
      const isCommand = kind === "commands";
      const dir = `${base}/${kind}`;
      const entries = yield* fs
        .readDirectory(dir, { recursive: isCommand })
        .pipe(Effect.orElseSucceed(() => []));
      for (const entry of Arr.sort(entries, (a: string, b: string) =>
        pipe(a, Str.localeCompare(b)),
      )) {
        if (isCommand && !pipe(entry, Str.endsWith(".md"))) continue;
        const text = yield* read(isCommand ? `${dir}/${entry}` : `${dir}/${entry}/SKILL.md`);
        if (Option.isNone(text)) continue;
        const name = isCommand
          ? pipe(entry, Str.slice(0, -3), Str.replaceAll(path.sep, ":"))
          : entry;
        const skill = describedNames(name, text.value, !isCommand);
        if (
          !skill.described ||
          Arr.some(skill.names, (name) => Arr.contains(kept, name) || decided.has(name))
        ) {
          for (const name of skill.names) decided.add(name);
        } else candidates.push(...skill.names);
      }
    }
  }
  const quiet: Record<string, "name-only"> = {};
  for (const name of candidates) if (!decided.has(name)) quiet[name] = "name-only";
  return quiet;
});

function describedNames(folder: string, markdown: string, useFrontmatterName = true) {
  let data;
  try {
    data = parseDocument(markdown).data;
  } catch {
    return { names: [folder], described: false };
  }
  const own = useFrontmatterName && isString(data.name) ? data.name : folder;
  return {
    names: own === folder ? [folder] : [folder, own],
    described: data["disable-model-invocation"] !== true && data["user-invocable"] !== false,
  };
}
