// `collie onboard`: takes a Machine from bare to a working Collie host, one step at a
// time, each streamed as it starts and as it ends. Every step looks before it acts, so
// running it again is how a half-onboarded Machine is repaired. Nothing here runs sudo:
// a step that needs root stops with the command to run.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hostname } from "node:os";
import { doctor, glabHosts, onPath, pushCheck, tokenPage } from "./doctor";
import type { PluginEnv } from "./env";
import { err, moveToRelease, prepareSteps, type OpResult } from "./operations";
import { helleEnvPath, LINEAR_MCP_FIX, probeLinearMcp } from "./optional";
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
  /** Mid-step: where the human has to go, and the local port its redirect comes back to. */
  | {
      readonly event: "human";
      readonly step: string;
      readonly detail: string;
      readonly url: string;
      readonly port?: number;
    }
  | ({ readonly event: "result"; readonly step: string } & Outcome);

/** The steps a Machine may go without and still be onboarded. */
export type Skippable = "helle" | "linear";

export interface OnboardOptions {
  readonly to: string;
  readonly skip?: ReadonlyArray<Skippable>;
  /** `GITLAB_TOKEN`, `HELLE_API_URL` and `HELLE_API_TOKEN`, from stdin: never an argument. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** stdin is a terminal the human can paste into. */
  readonly terminal?: boolean;
}

const HERDR_INSTALL = "curl -fsSL https://herdr.dev/install.sh | sh";
const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const COLLIE_REPO = "https://github.com/cego/collie.git";
const PROFILE_MARKER = "# added by collie onboard";
const GITLAB_HOST = "gitlab.cego.dk";
const LINEAR_LOGIN = "claude mcp login linear-server";
const LOGIN_LIMIT = "10 minutes";
/** A URL's own characters (RFC 3986), so the terminal escapes around it are not part of it. */
const URL_IN = /https:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/;

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

  const childEnv = { ...env.raw, PATH: search };
  /** Runs a command with this Machine's PATH, answering with its exit and all it said. */
  const piped = (
    cmd: string,
    args: ReadonlyArray<string>,
    cwd: string,
    input: string | null = null,
    extra: Record<string, string> = {},
  ) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(cmd, [...args], {
          cwd,
          env: { ...childEnv, ...extra },
          stdin: input === null ? "ignore" : Stream.make(new TextEncoder().encode(input)),
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
  const exec = (cmd: string, args: ReadonlyArray<string>, cwd: string) => piped(cmd, args, cwd);
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

  const here: PluginEnv = {
    ...env,
    pluginRoot: root,
    userDir: env.raw["COLLIE_USER_DIR"] ?? `${root}/user`,
    raw: childEnv,
  };
  const secrets = options.secrets ?? {};
  const host = env.raw["GITLAB_HOST"] ?? GITLAB_HOST;

  yield* step(
    "gitlab",
    `Logged in to ${host}`,
    Effect.gen(function* () {
      if ((yield* onPath(search, "glab")) === null) {
        return {
          status: "needs_root",
          detail: "glab must be installed as root; run the command, then onboard again",
          command: yield* rootCommand(search, ["glab"]),
        } satisfies Outcome;
      }
      const status = yield* exec("glab", ["auth", "status", "--hostname", host], root);
      if (status.code === 0) return inPlace(`glab is logged in to ${host}`);
      const token = secrets["GITLAB_TOKEN"];
      if (token === undefined) {
        return {
          status: "needs_human",
          detail: `make a token with the api and write_repository scopes, then give it on stdin as GITLAB_TOKEN=…`,
          url: tokenPage(host),
          command: "collie onboard --secrets-stdin",
        } satisfies Outcome;
      }
      const login = yield* piped(
        "glab",
        ["auth", "login", "--hostname", host, "--stdin"],
        root,
        `${token}\n`,
      );
      return login.code === 0
        ? done(`glab is logged in to ${host}`)
        : failed(`glab would not log in to ${host}: ${lastWords(login.stdout)}`);
    }),
  );

  yield* step(
    "push",
    `git push to ${host} on this Machine's own credentials`,
    Effect.gen(function* () {
      const ssh = (yield* onPath(search, "ssh")) !== null;
      const status = yield* exec("glab", ["auth", "status", "--hostname", host], root);
      const known = glabHosts(status.stdout).find((one) => one.host === host) ?? {
        host,
        https: false,
      };
      const before = yield* pushCheck(known, here, ssh, exec);
      if (before.ok) return inPlace(before.detail);
      if (status.code !== 0) {
        return failed(`${before.detail}, and glab is not logged in to register a key`);
      }
      if ((yield* onPath(search, "ssh-keygen")) === null) {
        return {
          status: "needs_root",
          detail: "ssh-keygen must be installed as root; run the command, then onboard again",
          command: yield* rootCommand(search, ["openssh-client"]),
        } satisfies Outcome;
      }
      const key = `${env.home}/.ssh/id_ed25519`;
      const name = hostname();
      if (!(yield* fs.exists(key))) {
        yield* fs.makeDirectory(`${env.home}/.ssh`, { recursive: true, mode: 0o700 });
        const made = yield* exec(
          "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", `collie@${name}`, "-f", key],
          env.home,
        );
        if (made.code !== 0) return failed(`could not make ${key}: ${lastWords(made.stdout)}`);
      }
      const added = yield* piped(
        "glab",
        ["ssh-key", "add", `${key}.pub`, "--title", `collie ${name}`],
        root,
        null,
        { GITLAB_HOST: host },
      );
      if (added.code !== 0) {
        return failed(`glab would not register ${key}.pub: ${lastWords(added.stdout)}`);
      }
      const after = yield* pushCheck(known, here, ssh, exec);
      return after.ok
        ? done(`registered ${key}.pub with ${host}`)
        : failed(after.detail, after.fix || undefined);
    }),
  );

  const skipped = (name: Skippable) =>
    (options.skip ?? []).includes(name)
      ? ({ status: "skipped", detail: "skipped for this Machine" } satisfies Outcome)
      : null;

  yield* step(
    "helle",
    "Helle's credentials",
    Effect.gen(function* () {
      const skip = skipped("helle");
      if (skip) return skip;
      const file = helleEnvPath(here);
      const url = secrets["HELLE_API_URL"];
      const token = secrets["HELLE_API_TOKEN"];
      const there = yield* fs.exists(file);
      if (url === undefined || token === undefined) {
        return there
          ? inPlace(`credentials at ${file}`)
          : ({
              status: "needs_human",
              detail: "give HELLE_API_URL=… and HELLE_API_TOKEN=… on stdin, or skip helle",
              command: "collie onboard --secrets-stdin",
            } satisfies Outcome);
      }
      const text = `HELLE_API_URL=${url}\nHELLE_API_TOKEN=${token}\n`;
      const current = there ? yield* fs.readFileString(file) : "";
      yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      if (current !== text) yield* fs.writeFileString(file, text, { mode: 0o600 });
      // A file written before this one may have been readable by others.
      yield* fs.chmod(file, 0o600);
      return current === text ? inPlace(`credentials at ${file}`) : done(`wrote ${file}`);
    }),
  );

  /** `claude mcp login` under a terminal of its own, streaming its URL as it is printed. */
  const linearLogin = Effect.gen(function* () {
    let shown = false;
    const handle = yield* spawner.spawn(
      ChildProcess.make("script", ["-qefc", LINEAR_LOGIN, "/dev/null"], {
        cwd: env.home,
        env: childEnv,
        // It waits on stdin for a pasted redirect, and gives up when stdin ends.
        stdin: options.terminal ? "inherit" : { stream: Stream.never, endOnDone: false },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const said = Stream.merge(handle.stdout, handle.stderr).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const url = URL_IN.exec(line)?.[0];
        if (url === undefined || shown) return Effect.void;
        shown = true;
        const port = /localhost:(\d+)/.exec(decodeURIComponent(url))?.[1];
        return emit({
          event: "human",
          step: "linear",
          detail: "open this to let Claude Code reach Linear",
          url,
          ...(port && { port: Number(port) }),
        });
      }),
    );
    yield* Effect.all([said, handle.exitCode], { concurrency: "unbounded" });
  }).pipe(Effect.scoped, Effect.timeoutOption(LOGIN_LIMIT), Effect.ignore);

  yield* step(
    "linear",
    "The Linear MCP in Claude Code",
    Effect.gen(function* () {
      const skip = skipped("linear");
      if (skip) return skip;
      if ((yield* onPath(search, "claude")) === null) {
        return failed("Claude Code is not installed, so it has no MCP servers", CLAUDE_INSTALL);
      }
      let changed = false;
      if ((yield* probeLinearMcp(here)).state !== "ok") {
        const [cmd, ...args] = LINEAR_MCP_FIX.split(" ");
        const added = yield* exec(cmd!, args, env.home);
        if (added.code !== 0) {
          return failed(`could not add the Linear MCP: ${lastWords(added.stdout)}`, LINEAR_MCP_FIX);
        }
        changed = true;
      }
      const connected = exec("claude", ["mcp", "get", "linear-server"], env.home).pipe(
        Effect.map((answer) => answer.stdout.includes("Connected")),
      );
      if (yield* connected) {
        return changed ? done("added, and connected") : inPlace("connected");
      }
      if ((yield* onPath(search, "script")) === null) {
        return failed("no `script` to give the login a terminal", LINEAR_LOGIN);
      }
      yield* linearLogin;
      return (yield* connected)
        ? done("logged in to Linear")
        : failed("the Linear login did not finish", LINEAR_LOGIN);
    }),
  );

  yield* step(
    "doctor",
    "collie doctor",
    Effect.gen(function* () {
      const report = yield* check(here);
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
