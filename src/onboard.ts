// `collie onboard`: takes a Machine from bare to a working Collie host, one step at a
// time, each streamed as it starts and as it ends. Every step looks before it acts, so
// running it again is how a half-onboarded Machine is repaired. Nothing here runs sudo:
// a step that needs root stops with the command to run.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { doctor, onPath } from "./doctor";
import type { PluginEnv } from "./env";
import { err, moveToRelease, prepareSteps, type OpResult } from "./operations";
import { installation, RELEASE_TAG } from "./release";

export type StepStatus = "done" | "in_place" | "skipped" | "needs_root" | "needs_human" | "failed";

export interface Outcome {
  readonly status: StepStatus;
  readonly detail: string;
  /** What to run by hand: the root command, or the one that retries this step. */
  readonly command?: string;
  /** Where the human has to go for this step. */
  readonly url?: string;
}

export type OnboardEvent =
  | { readonly event: "start"; readonly step: string; readonly title: string }
  | ({ readonly event: "result"; readonly step: string } & Outcome);

export interface OnboardOptions {
  readonly to: string;
}

const HERDR_INSTALL = "curl -fsSL https://herdr.dev/install.sh | sh";
const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const COLLIE_REPO = "https://github.com/cego/collie.git";
const PROFILE_MARKER = "# added by collie onboard";

const done = (detail: string): Outcome => ({ status: "done", detail });
const inPlace = (detail: string): Outcome => ({ status: "in_place", detail });
const failed = (detail: string, command?: string): Outcome => ({
  status: "failed",
  detail,
  ...(command && { command }),
});

const PACKAGE_MANAGERS: ReadonlyArray<readonly [string, string]> = [
  ["apt-get", "sudo apt-get install -y"],
  ["dnf", "sudo dnf install -y"],
  ["pacman", "sudo pacman -S --needed --noconfirm"],
  ["zypper", "sudo zypper install -y"],
  ["apk", "sudo apk add"],
  ["brew", "brew install"],
];

/** The one command that installs `packages` with this Machine's package manager. */
const rootCommand = Effect.fn("Onboard.rootCommand")(function* (
  search: string,
  packages: ReadonlyArray<string>,
) {
  for (const [manager, install] of PACKAGE_MANAGERS) {
    if ((yield* onPath(search, manager)) !== null) return `${install} ${packages.join(" ")}`;
  }
  return `install ${packages.join(" ")} with your package manager`;
});

/** The shell profile an interactive shell of this user's reads. */
const profileOf = (env: PluginEnv) => {
  const shell = env.raw["SHELL"] ?? "";
  if (shell.endsWith("/zsh")) return `${env.home}/.zshrc`;
  if (shell.endsWith("/bash")) return `${env.home}/.bashrc`;
  return `${env.home}/.profile`;
};

const decodeChecks = Schema.decodeUnknownOption(
  Schema.Struct({
    checks: Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean })),
  }),
);

const versionOf = Effect.fn("Onboard.versionOf")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(`${root}/herdr-plugin.toml`)
    .pipe(Effect.catch(() => Effect.succeed("")));
  return /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? "";
});

export const onboard = Effect.fn("Onboard.onboard")(function* (
  env: PluginEnv,
  options: OnboardOptions,
  emit: (event: OnboardEvent) => Effect.Effect<void, never, BunServices>,
  check: (env: PluginEnv) => Effect.Effect<OpResult, Error | PlatformError, BunServices> = doctor,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { to } = options;
  if (!RELEASE_TAG.test(to)) {
    return err("invalid_input", `"${to}" is not a Collie version, such as 0.27.0.`, { to });
  }
  const localBin = `${env.home}/.local/bin`;
  const binDir = env.raw["COLLIE_BIN_DIR"] ?? localBin;
  const inherited = (env.raw["PATH"] ?? "").split(":").filter((dir) => dir !== "");
  // Where the installers put herdr, Claude Code and `collie`, ahead of the PATH this
  // process was started with, which a fresh SSH session's may not include yet.
  const search = [...new Set([binDir, localBin, ...inherited])].join(":");
  const root =
    env.raw["COLLIE_DIR"] ??
    ((yield* fs.exists(`${env.pluginRoot}/herdr-plugin.toml`))
      ? env.pluginRoot
      : `${env.home}/.collie`);

  /** Runs a command with this Machine's PATH, answering with its exit and all it said. */
  const exec = (cmd: string, args: ReadonlyArray<string>, cwd: string) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(cmd, [...args], {
          cwd,
          env: { ...env.raw, PATH: search },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const text = (stream: typeof handle.stdout) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (all, chunk) => all + chunk,
          ),
        );
      const [stdout, stderr, code] = yield* Effect.all(
        [text(handle.stdout), text(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), stdout: stdout + stderr };
    }).pipe(
      Effect.scoped,
      Effect.catch(() => Effect.succeed({ code: 127, stdout: "" })),
    );
  const lastWords = (output: string) => output.trim().split("\n").slice(-3).join(" ");

  const outcomes: Array<{ step: string } & Outcome> = [];
  const step = Effect.fn("Onboard.step")(function* <E, R>(
    name: string,
    title: string,
    body: Effect.Effect<Outcome, E, R>,
  ) {
    yield* emit({ event: "start", step: name, title });
    const outcome = yield* body;
    outcomes.push({ step: name, ...outcome });
    yield* emit({ event: "result", step: name, ...outcome });
    return outcome;
  });

  const finish = (development: boolean) => {
    const ready = outcomes.every((outcome) =>
      ["done", "in_place", "skipped"].includes(outcome.status),
    );
    const data = { root, version: to, development, ready, steps: outcomes.map((o) => ({ ...o })) };
    if (ready) {
      return { ok: true as const, data, human: "Onboarded: collie doctor is ready." };
    }
    const left = outcomes.filter((o) => !["done", "in_place", "skipped"].includes(o.status));
    return err(
      "operation_failed",
      [
        "Not onboarded yet:",
        ...left.map((o) => `  ${o.step}: ${o.detail}${o.command ? `\n    run: ${o.command}` : ""}`),
      ].join("\n"),
      data,
    );
  };

  const system = yield* step(
    "system",
    "Checking for git and curl",
    Effect.gen(function* () {
      const missing: string[] = [];
      for (const tool of ["git", "curl"]) {
        if ((yield* onPath(search, tool)) === null) missing.push(tool);
      }
      if (missing.length === 0) return inPlace("git and curl are installed");
      return {
        status: "needs_root",
        detail: `${missing.join(" and ")} must be installed as root; run the command, then onboard again`,
        command: yield* rootCommand(search, missing),
      } satisfies Outcome;
    }),
  );
  if (system.status !== "in_place") return finish(false);

  let development = false;
  const collie = yield* step(
    "collie",
    `Collie ${to} in ${root}`,
    Effect.gen(function* () {
      if (!(yield* fs.exists(root))) {
        const repo = env.raw["COLLIE_REPO"] ?? COLLIE_REPO;
        const cloned = yield* exec(
          "git",
          ["clone", "--quiet", "--branch", to, repo, root],
          env.home,
        );
        return cloned.code === 0
          ? done(`cloned ${repo} at ${to}`)
          : failed(`could not clone ${repo} at ${to}: ${lastWords(cloned.stdout)}`);
      }
      if (!(yield* fs.exists(`${root}/.git`))) {
        return failed(`${root} is there and is not a checkout of Collie`);
      }
      const current = yield* installation(root, yield* versionOf(root), exec);
      if (!current.release) {
        development = true;
        return {
          status: "skipped",
          detail: `development build ${current.build} (${current.reason}): checks only, nothing installed or moved`,
        } satisfies Outcome;
      }
      const tags = yield* exec("git", ["tag", "--points-at", "HEAD"], root);
      if (tags.stdout.split("\n").some((tag) => tag.trim() === to)) return inPlace(`at ${to}`);
      const refused = yield* moveToRelease(root, to, exec);
      return refused ? failed(refused.error.message) : done(`moved to ${to}`);
    }),
  );
  if (collie.status === "failed") return finish(false);

  if (!development) {
    const installer = (name: string, title: string, command: string, shell: string) =>
      step(
        name,
        title,
        Effect.gen(function* () {
          const at = yield* onPath(search, name);
          if (at !== null) return inPlace(`${at}/${name}`);
          const ran = yield* exec(shell, ["-c", command], env.home);
          const now = yield* onPath(search, name);
          return ran.code === 0 && now !== null
            ? done(`installed ${now}/${name}`)
            : failed(`the installer did not leave a ${name}: ${lastWords(ran.stdout)}`, command);
        }),
      );
    yield* installer("herdr", "herdr", HERDR_INSTALL, "sh");
    yield* installer("claude", "Claude Code", CLAUDE_INSTALL, "bash");

    yield* step(
      "path",
      `${binDir} on PATH`,
      Effect.gen(function* () {
        const absent = [...new Set([binDir, localBin])].filter((dir) => !inherited.includes(dir));
        if (absent.length === 0) return inPlace(`${binDir} is on PATH`);
        const profile = profileOf(env);
        const text = yield* fs.readFileString(profile).pipe(Effect.catch(() => Effect.succeed("")));
        if (text.includes(PROFILE_MARKER)) return inPlace(`${profile} adds it; a new shell has it`);
        const lines = absent.map((dir) => `export PATH="${dir}:$PATH"`).join("\n");
        yield* fs.writeFileString(profile, `${text}\n${PROFILE_MARKER}\n${lines}\n`);
        return done(`added to ${profile}; a new shell has it`);
      }),
    );

    yield* step(
      "plugin",
      "The plugin, the runner and the skills",
      Effect.gen(function* () {
        const prepared = yield* exec("sh", ["prepare.sh"], root);
        const steps = prepareSteps(prepared.stdout);
        const said = steps
          .map((one) => `${one.step}: ${one.state}${one.detail ? ` — ${one.detail}` : ""}`)
          .join("; ");
        if (prepared.code !== 0) {
          return failed(
            `prepare.sh failed: ${said || lastWords(prepared.stdout)}`,
            `sh ${root}/prepare.sh`,
          );
        }
        return steps.some((one) => one.state === "done") ? done(said) : inPlace(said);
      }),
    );
  }

  yield* step(
    "doctor",
    "collie doctor",
    Effect.gen(function* () {
      const userDir = env.raw["COLLIE_USER_DIR"] ?? `${root}/user`;
      const report = yield* check({
        ...env,
        pluginRoot: root,
        userDir,
        raw: { ...env.raw, PATH: search },
      });
      if (report.ok) return done("ready");
      const failing = Option.match(decodeChecks(report.error.details), {
        onNone: () => [],
        onSome: ({ checks }) => checks.filter((one) => !one.ok).map((one) => one.name),
      });
      return failed(
        failing.length > 0 ? `not ready: ${failing.join(", ")}` : report.error.message,
        "collie doctor",
      );
    }),
  );

  return finish(development);
});
