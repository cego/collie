// Onboarding a Machine from Desktop: herdr saves it where it is new, asking its questions
// of the human; Desktop's own version of the runner goes there only once its signature
// verifies; and `collie onboard` runs with it, each step told as it comes.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Effect, Option, Result, Schema, Stream } from "effect";
import { CommandLine } from "effect/process";
import { inTerminal } from "../../../src/in-terminal";
import { verifiedRunner as sharedVerifiedRunner } from "../../../src/releases";
import { type OnboardRun, type OnboardStep, SETTLED, type Skippable } from "../shared/flock";
import { type Route, type ShellRoute, spawned } from "./machine";
import { CHILD_CWD, childEnv } from "./login-env";

export const RELEASES = "https://github.com/cego/collie/releases/download";

const OS = new Map([
  ["Linux", "linux"],
  ["Darwin", "darwin"],
]);
const ARCH = new Map([
  ["x86_64", "x64"],
  ["amd64", "x64"],
  ["aarch64", "arm64"],
  ["arm64", "arm64"],
]);

/** The release asset's platform for what `uname -sm` printed, or null where there is none. */
export const platformOf = (uname: string) => {
  const [os, arch = ""] = Str.split(Str.trim(uname), /\s+/);
  const [named, cpu] = [OS.get(os), ARCH.get(arch)];
  return named !== undefined && cpu !== undefined ? `${named}-${cpu}` : null;
};

/** The shared download, refusing with the reason Desktop shows. */
export const verifiedRunner = (...args: Parameters<typeof sharedVerifiedRunner>) =>
  sharedVerifiedRunner(...args).pipe(Effect.mapError((refused) => refused.reason));

/** What a command said and how it exited, `stdin` given to it whole. */
export const ranWith = (command: ReadonlyArray<string>, stdin?: Uint8Array) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawned(() =>
        Bun.spawn([...command], {
          env: childEnv(),
          cwd: CHILD_CWD,
          stdin: stdin ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [out, err, code] = yield* Effect.promise(() =>
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]),
      );
      return { out, err, code };
    }),
  );

export const shOn = (route: ShellRoute, script: string, stdin?: Uint8Array) =>
  route.execute?.(script, stdin) ??
  Effect.flatMap(route.sh(script), (command) => ranWith(command, stdin));

/** SHA-256 of stdin, as Linux and macOS each have it. */
const SHA256 = "{ sha256sum 2>/dev/null || shasum -a 256; }";

const placedAt = (version: string) => `"$HOME/.cache/collie/runners/collie-${version}"`;

/** Puts the runner on the Machine unless it is there already, and checks what arrived. */
const place = (route: ShellRoute, version: string, runner: { bytes: Uint8Array; sha256: string }) =>
  Effect.gen(function* () {
    const file = placedAt(version);
    const there = yield* shOn(route, `${SHA256} < ${file} 2>/dev/null`);
    if (pipe_(there.out, Str.slice(0, 64)) === runner.sha256) return;
    const put = yield* shOn(
      route,
      Arr.join(
        [
          `set -e; mkdir -p "$HOME/.cache/collie/runners"; f=${file}; cat > "$f.new"`,
          `[ "$(${SHA256} < "$f.new" | cut -c1-64)" = ${runner.sha256} ] || { rm -f "$f.new"; echo "the runner changed on its way to ${route.machine.name}" >&2; exit 1; }`,
          `chmod +x "$f.new"; mv "$f.new" "$f"`,
        ],
        "; ",
      ),
      runner.bytes,
    );
    if (put.code !== 0)
      return yield* Effect.fail(
        Str.trim(put.err) || `could not put the runner on ${route.machine.name}`,
      );
  });

const Ended = Schema.Literals([
  "done",
  "in_place",
  "skipped",
  "needs_root",
  "needs_human",
  "failed",
]);

/** A line of `collie --json onboard`: an event, then the envelope. */
const Line = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ event: Schema.Literal("start"), step: Schema.String, title: Schema.String }),
    Schema.Struct({
      event: Schema.Literal("human"),
      step: Schema.String,
      detail: Schema.String,
      url: Schema.String,
      port: Schema.optionalKey(Schema.Finite),
    }),
    Schema.Struct({
      event: Schema.Literal("result"),
      step: Schema.String,
      status: Ended,
      detail: Schema.String,
      command: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({ ok: Schema.Literal(true) }),
    Schema.Struct({
      ok: Schema.Literal(false),
      error: Schema.Struct({ message: Schema.String }),
    }),
  ]),
);
const lineOf = Schema.decodeUnknownOption(Line);

export const NOT_STARTED: OnboardRun = { steps: [], asked: null, ready: null, reason: null, at: 0 };

export const onboardingSkips = (
  before: ReadonlyArray<OnboardStep>,
  skipping: ReadonlyArray<Skippable>,
  restoring?: Skippable,
) =>
  Arr.filter(
    ["helle", "linear"] as const,
    (step) =>
      step !== restoring &&
      (skipping.includes(step) ||
        Arr.some(before, (one) => one.step === step && one.status === "skipped")),
  );

/** Each change to a run, told as it is made; the run as it stands is the last one told. */
export const tracked = (told: (run: OnboardRun) => Effect.Effect<void>, start = NOT_STARTED) => {
  let run = start;
  const change = (to: (now: OnboardRun) => OnboardRun) =>
    Effect.suspend(() => {
      run = to(run);
      return told(run);
    });
  return {
    current: () => run,
    change,
    /** A new step, or what changed about one already told. */
    step: (step: Pick<OnboardStep, "step"> & Partial<OnboardStep>) =>
      change((now) => {
        const at = Option.getOrElse(
          Arr.findFirstIndex(now.steps, ({ step: name }) => name === step.step),
          () => -1,
        );
        const steps =
          at === -1
            ? [...now.steps, { title: step.step, status: "running" as const, ...step }]
            : Arr.map(now.steps, (one, i) => (i === at ? { ...one, ...step } : one));
        return { ...now, steps };
      }),
    end: (ready: boolean, reason: string | null) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        change((now) => ({ ...now, asked: null, ready, reason, at })),
      ),
  };
};

export interface OnboardWith {
  readonly version: string;
  /** Where releases are downloaded from, each under its version. */
  readonly releases: string;
  /** Where the runners downloaded are kept on this computer. */
  readonly runners: string;
  readonly key?: string;
  /** `KEY=value` lines `collie onboard` reads on stdin; none where empty. */
  readonly secrets?: string;
  /** Opens a login a step streams in this computer's browser. */
  readonly open?: (url: string) => Effect.Effect<void>;
  readonly skip?: ReadonlyArray<Skippable>;
  /** The GitLab the Machine is onboarded against. */
  readonly gitlabHost?: string;
}

/**
 * Onboards the Machine a route reaches with Desktop's own version: its runner first, then
 * `collie onboard`'s steps as it streams them. Answers with how the run ended.
 */
export const onboardThrough = Effect.fn("Desktop.onboardThrough")(function* (
  route: ShellRoute,
  {
    version,
    releases,
    runners,
    key,
    secrets = "",
    open = () => Effect.void,
    skip = [],
    gitlabHost,
  }: OnboardWith,
  told: (run: OnboardRun) => Effect.Effect<void>,
  start: OnboardRun = NOT_STARTED,
) {
  const run = tracked(told, start);
  const runner = { step: "runner", title: `Collie ${version}'s runner, signed` } as const;
  yield* run.step({ ...runner, status: "running" });
  const placed = yield* Effect.gen(function* () {
    const uname = yield* shOn(route, "uname -sm");
    const platform = platformOf(uname.out);
    if (platform === null)
      return yield* Effect.fail(
        `Collie has no runner for ${Str.trim(uname.out) || "this Machine"}`,
      );
    const verified = yield* verifiedRunner(releases, version, platform, runners, key);
    yield* place(route, version, verified);
    return verified;
  }).pipe(Effect.result);
  if (placed._tag === "Failure") {
    yield* run.step({ ...runner, status: "failed", detail: placed.failure });
    yield* run.end(false, null);
    return run.current();
  }
  yield* run.step({
    ...runner,
    status: "done",
    detail: `${placed.success.asset}, verified against Collie's release key`,
  });

  const ended = yield* Effect.gen(function* () {
    const command = yield* route.sh(
      Arr.join(
        [
          `exec ${placedAt(version)}`,
          ...Arr.map(
            [
              "--json",
              "onboard",
              "--to",
              version,
              ...(secrets === "" ? [] : ["--secrets-stdin"]),
              ...Arr.flatMap(skip, (step) => ["--skip", step]),
              ...(gitlabHost === undefined ? [] : ["--gitlab-host", gitlabHost]),
            ],
            (word) => Result.getOrThrow(CommandLine.quote(word)),
          ),
        ],
        " ",
      ),
    );
    const child = yield* spawned(() =>
      Bun.spawn([...command], {
        env: childEnv(),
        cwd: CHILD_CWD,
        stdin: secrets === "" ? "ignore" : new TextEncoder().encode(secrets),
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const said = new Response(child.stderr).text();
    // One forward per port: cancelling a second would drop the first.
    const forwarded = new Set<number>();
    yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((text) =>
        Option.match(lineOf(text), {
          onNone: () => Effect.void,
          onSome: (line) => {
            if ("ok" in line) {
              const left = Arr.some(run.current().steps, ({ status }) => !SETTLED.includes(status));
              return run.end(line.ok, line.ok || left ? null : line.error.message);
            }
            if (line.event === "start")
              return run.step({ step: line.step, title: line.title, status: "running" });
            if (line.event === "human")
              return run.step({ step: line.step, detail: line.detail, url: line.url }).pipe(
                // Its redirect comes back to the Machine's port, now this computer's too.
                Effect.andThen(
                  line.port === undefined || forwarded.has(line.port)
                    ? Effect.void
                    : route
                        .forward(line.port)
                        .pipe(Effect.andThen(Effect.sync(() => void forwarded.add(line.port!)))),
                ),
                Effect.ignore,
                Effect.andThen(open(line.url)),
              );
            const { event: _, ...result } = line;
            return run.step(result);
          },
        }),
      ),
      Effect.ignore,
    );
    const code = yield* Effect.promise(() => child.exited);
    return { code, said: Str.trim(yield* Effect.promise(() => said)) };
  }).pipe(Effect.scoped, Effect.result);
  if (run.current().ready === null)
    yield* run.end(
      false,
      ended._tag === "Failure"
        ? ended.failure
        : ended.success.said || `collie onboard exited ${ended.success.code}`,
    );
  return run.current();
});

const Checks = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    ok: Schema.Boolean,
    detail: Schema.String,
    fix: Schema.String,
    warn: Schema.optionalKey(Schema.Boolean),
  }),
);
const DoctorSaid = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ data: Schema.Struct({ checks: Checks }) }),
    Schema.Struct({ error: Schema.Struct({ details: Schema.Struct({ checks: Checks }) }) }),
  ]),
);

/** Doctor's optional checks for what onboarding sets up by default, by onboarding's step. */
const DEFAULT_STEPS = new Map([
  ["helle", "helle"],
  ["linear mcp", "linear"],
]);

/**
 * How `collie doctor` finds the Machine, as an onboarding lists what is left: each failed
 * check, and each default step doctor finds not working though it counts it ok. None where
 * doctor did not answer.
 */
export const doctorOn = (route: Pick<Route, "collie">, gitlabHost?: string) =>
  route
    .collie([
      "--json",
      "doctor",
      ...(gitlabHost === undefined ? [] : ["--gitlab-host", gitlabHost]),
    ])
    .pipe(
      Effect.flatMap(({ out }) => Schema.decodeEffect(DoctorSaid)(Str.trim(out))),
      Effect.map((said) => ("data" in said ? said.data : said.error.details).checks),
      Effect.flatMap((checks) =>
        Effect.map(Clock.currentTimeMillis, (at): OnboardRun => {
          const steps = Arr.flatMap(checks, ({ name, ok, detail, fix, warn }): OnboardStep[] => {
            const byDefault = DEFAULT_STEPS.get(name);
            if (byDefault !== undefined && (!ok || warn === true || fix !== ""))
              return [
                { step: byDefault, title: name, status: "needs_human", detail, command: fix },
              ];
            if (ok) return [];
            return [
              {
                step: pipe_(name, Str.replaceAll(" ", "-")),
                title: name,
                status: "failed",
                detail,
                command: fix,
              },
            ];
          });
          return { steps, asked: null, ready: steps.length === 0, reason: null, at };
        }),
      ),
      Effect.option,
    );

const QUESTION = /\[(y\/N|Y\/n)\]\s*$/;

/**
 * A yes-or-no question `text` ends in, as a terminal shows it with its default capitalised,
 * and the lines just before it, such as a warning of what yes would stop.
 */
const questionIn = (text: string) => {
  const asked = QUESTION.exec(text);
  if (asked === null) return null;
  const lines = Str.split(pipe_(text, Str.slice(0, asked.index)), "\n");
  const blank = Option.getOrElse(
    Arr.findLastIndex(lines, (line, at) => at < lines.length - 1 && Str.trim(line) === ""),
    () => -1,
  );
  return {
    text: Str.trim(Arr.join(lines.slice(blank + 1), "\n")),
    yes: asked[1] === "Y/n",
  };
};
// oxlint-disable-next-line no-control-regex
const TERMINAL_CODES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\r/g;

/**
 * `herdr machine add` in a terminal Desktop drives, so herdr asks as it would a human:
 * each yes-or-no question is put to `ask` with herdr's own default, and its answer typed.
 * Fails with what herdr said last where it saved nothing.
 */
export const addToHerdr = Effect.fn("Desktop.addToHerdr")(function* (
  herdr: string,
  target: string,
  label: string,
  session: string,
  ask: (text: string, yes: boolean) => Effect.Effect<boolean>,
) {
  const herdrAdd = yield* inTerminal(
    [herdr, "machine", "add", "--label", label, "--remote-session", session, target],
    { env: childEnv(), cwd: CHILD_CWD },
    spawned,
  );
  let said = "";
  let answered = 0;
  yield* herdrAdd.output.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        said += pipe_(chunk, Str.replace(TERMINAL_CODES, ""));
        // Less the terminal's echo of the last answer.
        const asked = questionIn(pipe_(said, Str.slice(answered), Str.replace(/^\s*[yn]\n/, "")));
        if (asked === null) return;
        answered = said.length;
        const yes = yield* ask(asked.text, asked.yes);
        yield* herdrAdd.type(yes ? "y\n" : "n\n");
      }),
    ),
    Effect.ignore,
  );
  const code = yield* herdrAdd.exitCode;
  if (code !== 0) {
    const last = Arr.join(Str.split(Str.trim(said), "\n").slice(-3), "\n");
    return yield* Effect.fail(last || `herdr machine add exited ${code}`);
  }
}, Effect.scoped);
