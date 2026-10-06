// `collie onboard`: takes a Machine from bare to a working Collie host, one step at a
// time, each streamed as it starts and as it ends. Every step looks before it acts, so
// running it again is how a half-onboarded Machine is repaired. Nothing here runs sudo:
// a step that needs root stops with the command to run.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option, Schedule, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hostname } from "node:os";
import { doctor, glabHosts, onPath, pushCheck } from "./doctor";
import { GITLAB_HOST, tokenPage } from "./gitlab-token";
import type { PluginEnv } from "./env";
import { err, moveToRelease, prepareSteps, type OpResult } from "./operations";
import { HELLE_TOKEN_STEPS, helleUrlOf } from "./helle-url";
import { helleEnvPath, LINEAR_MCP_ADD, LINEAR_MCP_FIX, probeLinearMcp } from "./optional";
import { installation, manifestField, RELEASE_TAG } from "./release";

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
  /** `GITLAB_TOKEN` and `HELLE_API_TOKEN`, from stdin: never an argument. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** stdin is a terminal the human can paste into. */
  readonly terminal?: boolean;
  /** Someone sees the stream, so a login that needs the human may be started. Default true. */
  readonly attended?: boolean;
}

const HERDR_INSTALL = "curl -fsSL https://herdr.dev/install.sh | sh";
const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const COLLIE_REPO = "https://github.com/cego/collie.git";
const PROFILE_MARKER = "# added by collie onboard";
const LINEAR_LOGIN = "claude mcp login linear-server";
const CLAUDE_LOGIN = "claude auth login";
const LOGIN_LIMIT = "10 minutes";
/** Long enough for an installer or a clone; a network that never answers still ends. */
const COMMAND_LIMIT = "15 minutes";
/** Where install.sh looks for an OpenSSL that can check a signature, unless COLLIE_OPENSSL names one. */
const OPENSSL_CANDIDATES = [
  "openssl",
  "openssl3",
  "/opt/homebrew/opt/openssl@3/bin/openssl",
  "/usr/local/opt/openssl@3/bin/openssl",
];
const SETTLED: ReadonlyArray<StepStatus> = ["done", "in_place", "skipped"];
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

/** What gives OpenSSL 3 where the system one is older; apt's releases with 1.1 have no package for it. */
const OPENSSL3_INSTALL = new Map([
  ["dnf", "sudo dnf install -y epel-release && sudo dnf install -y openssl3"],
  ["brew", "brew install openssl"],
]);

const needsRoot = Effect.fn("Onboard.needsRoot")(function* (
  search: string,
  tools: ReadonlyArray<string>,
  packages: ReadonlyArray<string> = tools,
) {
  return {
    status: "needs_root",
    detail: `${tools.join(" and ")} must be installed as root; run the command, then onboard again`,
    command: yield* rootCommand(search, packages),
  } satisfies Outcome;
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
      Effect.timeoutOption(COMMAND_LIMIT),
      Effect.map(
        Option.getOrElse(() => ({ code: 124, stdout: `timed out after ${COMMAND_LIMIT}` })),
      ),
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
    const ready = outcomes.every((outcome) => SETTLED.includes(outcome.status));
    const data = { root, version: to, development, ready, steps: outcomes.map((o) => ({ ...o })) };
    if (ready) {
      return { ok: true as const, data, human: "Onboarded: collie doctor is ready." };
    }
    const left = outcomes.filter((o) => !SETTLED.includes(o.status));
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
    "Checking for git, curl and openssl",
    Effect.gen(function* () {
      const missing: string[] = [];
      for (const tool of ["git", "curl", "openssl"]) {
        if ((yield* onPath(search, tool)) === null) missing.push(tool);
      }
      if (missing.length > 0) return yield* needsRoot(search, missing);
      const openssl = env.raw["COLLIE_OPENSSL"];
      for (const candidate of openssl ? [openssl] : OPENSSL_CANDIDATES) {
        if (
          /^OpenSSL ([3-9]|[1-9]\d)/.test((yield* exec(candidate, ["version"], env.home)).stdout)
        ) {
          return inPlace("git, curl and openssl are installed");
        }
      }
      let command: string | undefined;
      for (const [manager] of PACKAGE_MANAGERS) {
        if ((yield* onPath(search, manager)) !== null) {
          command = OPENSSL3_INSTALL.get(manager);
          break;
        }
      }
      return {
        status: "needs_root",
        detail:
          "openssl is older than 3.0 or is LibreSSL, so it cannot check a runner's Ed25519 signature; install OpenSSL 3 (or bun, to build from source), then onboard again",
        ...(command && { command }),
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
        const cloned = yield* exec("git", ["clone", "--quiet", repo, root], env.home);
        if (cloned.code !== 0) {
          return failed(`could not clone ${repo}: ${lastWords(cloned.stdout)}`);
        }
        // On its branch rather than detached, so a plain `collie upgrade` can still pull.
        const atTag = yield* exec("git", ["reset", "--quiet", "--hard", `refs/tags/${to}`], root);
        return atTag.code === 0
          ? done(`cloned ${repo} at ${to}`)
          : failed(`${repo} has no release ${to}: ${lastWords(atTag.stdout)}`);
      }
      if (!(yield* fs.exists(`${root}/.git`))) {
        return failed(`${root} is there and is not a checkout of Collie`);
      }
      const current = yield* installation(root, yield* manifestField(root, "version"), exec);
      if (!current.release) {
        development = true;
        return {
          status: "skipped",
          detail: `development build ${current.build} (${current.reason}): checks and logins only, nothing installed or moved`,
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
  const attended = options.attended ?? true;
  const host = env.raw["GITLAB_HOST"] ?? GITLAB_HOST;

  yield* step(
    "claude-login",
    "Claude Code logged in",
    Effect.gen(function* () {
      if ((yield* onPath(search, "claude")) === null) {
        return failed("Claude Code is not installed", CLAUDE_INSTALL);
      }
      const loggedIn = exec("claude", ["auth", "status", "--json"], env.home).pipe(
        Effect.map((answer) => /"loggedIn":\s*true/.test(answer.stdout)),
      );
      if (yield* loggedIn) return inPlace("logged in");
      if (!(attended && options.terminal)) {
        return {
          status: "needs_human",
          detail: "log in to Claude Code on this Machine",
          command: CLAUDE_LOGIN,
        } satisfies Outcome;
      }
      yield* Effect.scoped(
        Effect.flatMap(
          spawner.spawn(
            ChildProcess.make("claude", ["auth", "login"], {
              cwd: env.home,
              env: childEnv,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }),
          ),
          (handle) => handle.exitCode,
        ),
      ).pipe(Effect.timeoutOption(LOGIN_LIMIT), Effect.ignore);
      return (yield* loggedIn)
        ? done("logged in")
        : failed("the login did not finish", CLAUDE_LOGIN);
    }),
  );

  yield* step(
    "gitlab",
    `Logged in to ${host}`,
    Effect.gen(function* () {
      if ((yield* onPath(search, "glab")) === null) return yield* needsRoot(search, ["glab"]);
      const status = yield* exec("glab", ["auth", "status", "--hostname", host], root);
      const token = secrets["GITLAB_TOKEN"];
      if (status.code === 0) {
        // A token given is the Flock's, so one glab holds from before is replaced by it.
        const held =
          token === undefined
            ? null
            : yield* exec("glab", ["config", "get", "token", "--host", host], root);
        if (held === null || held.stdout.trim() === token)
          return inPlace(`glab is logged in to ${host}`);
      }
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
      if (ssh && !known.https) {
        // Trusts GitLab's host key on first use, as doctor's own fix does; a changed key is still refused.
        yield* exec(
          "ssh",
          [
            "-oBatchMode=yes",
            "-oConnectTimeout=5",
            "-oStrictHostKeyChecking=accept-new",
            "-T",
            `git@${host}`,
          ],
          env.home,
        );
      }
      const before = yield* pushCheck(known, here, ssh, exec);
      if (before.ok) return inPlace(before.detail);
      if (status.code !== 0) {
        return failed(`${before.detail}, and glab is not logged in to register a key`);
      }
      if ((yield* onPath(search, "ssh-keygen")) === null) {
        return yield* needsRoot(search, ["ssh-keygen"], ["openssh-client"]);
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
      const registered = /already been taken|already exists/i.test(added.stdout);
      if (added.code !== 0 && !registered) {
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
      const token = secrets["HELLE_API_TOKEN"];
      const there = yield* fs.exists(file);
      if (token === undefined) {
        return there
          ? inPlace(`credentials at ${file}`)
          : ({
              status: "needs_human",
              detail: `${HELLE_TOKEN_STEPS}; then give HELLE_API_TOKEN=… on stdin, or skip helle`,
              command: "collie onboard --secrets-stdin",
            } satisfies Outcome);
      }
      // Other Helle clients read the URL from this file.
      const text = `HELLE_API_URL=${helleUrlOf(here.raw)}\nHELLE_API_TOKEN=${token}\n`;
      const current = there ? yield* fs.readFileString(file) : "";
      yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      // Before the write: a file from before may be readable by others, and `mode` only applies to a new one.
      if (there) yield* fs.chmod(file, 0o600);
      if (current !== text) yield* fs.writeFileString(file, text, { mode: 0o600 });
      return current === text ? inPlace(`credentials at ${file}`) : done(`wrote ${file}`);
    }),
  );

  /** `claude mcp login` under a terminal of its own, streaming its URL as it is printed. */
  const linearLogin = Effect.gen(function* () {
    // A URL is told once it is printed, and again when one with a callback port comes.
    let told: string | null = null;
    const tell = (url: string) => {
      const port = /localhost:(\d+)/.exec(decodeURIComponent(url))?.[1];
      if (url === told || (told !== null && port === undefined)) return Effect.void;
      told = url;
      return emit({
        event: "human",
        step: "linear",
        detail: "open this to let Claude Code reach Linear",
        url,
        ...(port && { port: Number(port) }),
      });
    };
    // Claude Code may print only a paste-code URL and hand the one with its callback port
    // to $BROWSER, which this shim writes down instead.
    const shims = yield* fs.makeTempDirectoryScoped({ prefix: "collie-login-" });
    const handed = `${shims}/url`;
    yield* fs.writeFileString(`${shims}/browser`, `#!/bin/sh\necho "$1" > '${handed}'\n`);
    yield* fs.chmod(`${shims}/browser`, 0o755);
    const handle = yield* spawner.spawn(
      ChildProcess.make("script", ["-qefc", LINEAR_LOGIN, "/dev/null"], {
        cwd: env.home,
        env: { ...childEnv, BROWSER: `${shims}/browser` },
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
        return url === undefined ? Effect.void : tell(url);
      }),
    );
    const browsed = fs.readFileString(handed).pipe(
      Effect.map((text) => URL_IN.exec(text)?.[0]),
      Effect.flatMap((url) => (url === undefined ? Effect.fail("not yet") : tell(url))),
      Effect.retry({ schedule: Schedule.spaced("300 millis") }),
    );
    yield* Effect.raceFirst(
      Effect.all([said, handle.exitCode], { concurrency: "unbounded" }),
      Effect.andThen(browsed, Effect.never),
    );
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
        const added = yield* exec("claude", LINEAR_MCP_ADD, env.home);
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
      if (!attended) {
        return {
          status: "needs_human",
          detail: "added; log in to Linear",
          command: LINEAR_LOGIN,
        } satisfies Outcome;
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
