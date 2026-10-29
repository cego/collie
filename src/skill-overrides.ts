import { Effect, FileSystem, Option, Path, Schema } from "effect";
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
const decodeOverrides = Schema.decodeUnknownOption(Overrides);

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
      if (Option.isSome(gitfile) && gitfile.value.startsWith("gitdir: ")) {
        const gitdir = path.resolve(dir, gitfile.value.slice(8).trim());
        const common = yield* read(`${gitdir}/commondir`);
        if (Option.isSome(common)) {
          const main = `${path.dirname(path.resolve(gitdir, common.value.trim()))}/.claude`;
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
  for (const file of settingsDirs.flatMap((dir) => [
    `${dir}/settings.json`,
    `${dir}/settings.local.json`,
  ])) {
    const text = yield* read(file);
    if (Option.isNone(text)) continue;
    const settings = decodeOverrides(text.value);
    if (Option.isSome(settings))
      for (const name of Object.keys(settings.value.skillOverrides ?? {})) decided.add(name);
  }
  const candidates: string[] = [];
  for (const dir of [`${claudeDir}/skills`, ...projects.map((dir) => `${dir}/skills`)]) {
    const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries.toSorted((a, b) => a.localeCompare(b))) {
      const text = yield* read(`${dir}/${entry}/SKILL.md`);
      if (Option.isNone(text)) continue;
      const skill = describedNames(entry, text.value);
      if (
        !skill.described ||
        skill.names.some((name) => kept.includes(name) || decided.has(name))
      ) {
        for (const name of skill.names) decided.add(name);
      } else candidates.push(...skill.names);
    }
  }
  const quiet: Record<string, "name-only"> = {};
  for (const name of candidates) if (!decided.has(name)) quiet[name] = "name-only";
  return quiet;
});

function describedNames(folder: string, markdown: string) {
  let data;
  try {
    data = parseDocument(markdown).data;
  } catch {
    return { names: [folder], described: false };
  }
  const own = isString(data.name) ? data.name : folder;
  return {
    names: own === folder ? [folder] : [folder, own],
    described: data["disable-model-invocation"] !== true && data["user-invocable"] !== false,
  };
}
