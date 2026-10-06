// Onboarding a Machine from Desktop: herdr saves it where it is new, asking its questions
// of the human; Desktop's own version of the runner goes there only once its signature
// verifies; and `collie onboard` runs with it, each step told as it comes.

import { createHash } from "node:crypto";
import { Clock, Effect, FileSystem, Option, Schema, Stream } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { RELEASE_PUBLIC_KEY, SIGNATURE_SUFFIX, verifyRelease } from "../../../src/signing";
import { type OnboardRun, type OnboardStep, SETTLED } from "../shared/flock";
import { quoted, type Route, type ShellRoute, spawned } from "./machine";

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
  const [os = "", arch = ""] = uname.trim().split(/\s+/);
  const [named, cpu] = [OS.get(os), ARCH.get(arch)];
  return named !== undefined && cpu !== undefined ? `${named}-${cpu}` : null;
};

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.map(response.arrayBuffer, (body) => new Uint8Array(body))
        : Effect.succeed(null),
    ),
    Effect.mapError((error) => `could not download ${url}: ${error.message}`),
    Effect.provide(FetchHttpClient.layer),
  );

/**
 * The runner of `version` for `platform`, downloaded into `dir` once and verified against
 * the release key every time it is used, so a kept copy changed since is refused too.
 */
export const verifiedRunner = Effect.fn("Desktop.verifiedRunner")(function* (
  releases: string,
  version: string,
  platform: string,
  dir: string,
  key: string = RELEASE_PUBLIC_KEY,
) {
  const fs = yield* FileSystem.FileSystem;
  const asset = `collie-${platform}`;
  const file = `${dir}/${version}/${asset}`;
  const kept = yield* Effect.all([
    fs.readFile(file),
    fs.readFileString(`${file}${SIGNATURE_SUFFIX}`),
  ]).pipe(Effect.option);
  let bytes: Uint8Array;
  let signature: string | null;
  if (Option.isSome(kept)) [bytes, signature] = kept.value;
  else {
    const url = `${releases}/${version}/${asset}`;
    const got = yield* fetched(url);
    if (got === null) return yield* Effect.fail(`Collie ${version} has no ${asset}`);
    const signed = yield* fetched(`${url}${SIGNATURE_SUFFIX}`);
    bytes = got;
    signature = signed === null ? null : new TextDecoder().decode(signed);
  }
  const verified = verifyRelease(bytes, signature, key);
  if (!verified.ok) {
    if (Option.isSome(kept)) yield* fs.remove(file, { force: true }).pipe(Effect.ignore);
    return yield* Effect.fail(`${asset} ${version}: ${verified.reason}`);
  }
  if (Option.isNone(kept)) {
    yield* Effect.all([
      fs.makeDirectory(`${dir}/${version}`, { recursive: true }),
      fs.writeFile(file, bytes),
      fs.writeFileString(`${file}${SIGNATURE_SUFFIX}`, signature ?? ""),
    ]).pipe(Effect.mapError((error) => `could not keep ${asset}: ${error.message}`));
  }
  return { asset, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
});

/** What a command said and how it exited, `stdin` given to it whole. */
export const ranWith = (command: ReadonlyArray<string>, stdin?: Uint8Array) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawned(() =>
        Bun.spawn([...command], { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" }),
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
  Effect.flatMap(route.sh(script), (command) => ranWith(command, stdin));

/** SHA-256 of stdin, as Linux and macOS each have it. */
const SHA256 = "{ sha256sum 2>/dev/null || shasum -a 256; }";

const placedAt = (version: string) => `"$HOME/.cache/collie/runners/collie-${version}"`;

/** Puts the runner on the Machine unless it is there already, and checks what arrived. */
const place = (route: ShellRoute, version: string, runner: { bytes: Uint8Array; sha256: string }) =>
  Effect.gen(function* () {
    const file = placedAt(version);
    const there = yield* shOn(route, `${SHA256} < ${file} 2>/dev/null`);
    if (there.out.slice(0, 64) === runner.sha256) return;
    const put = yield* shOn(
      route,
      [
        `set -e; mkdir -p "$HOME/.cache/collie/runners"; f=${file}; cat > "$f.new"`,
        `[ "$(${SHA256} < "$f.new" | cut -c1-64)" = ${runner.sha256} ] || { rm -f "$f.new"; echo "the runner changed on its way to ${route.machine.name}" >&2; exit 1; }`,
        `chmod +x "$f.new"; mv "$f.new" "$f"`,
      ].join("; "),
      runner.bytes,
    );
    if (put.code !== 0)
      return yield* Effect.fail(
        put.err.trim() || `could not put the runner on ${route.machine.name}`,
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
      port: Schema.optionalKey(Schema.Number),
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
        const at = now.steps.findIndex(({ step: name }) => name === step.step);
        const steps =
          at === -1
            ? [...now.steps, { title: step.step, status: "running" as const, ...step }]
            : now.steps.map((one, i) => (i === at ? { ...one, ...step } : one));
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
}

/**
 * Onboards the Machine a route reaches with Desktop's own version: its runner first, then
 * `collie onboard`'s steps as it streams them. Answers with how the run ended.
 */
export const onboardThrough = Effect.fn("Desktop.onboardThrough")(function* (
  route: ShellRoute,
  { version, releases, runners, key, secrets = "", open = () => Effect.void }: OnboardWith,
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
      return yield* Effect.fail(`Collie has no runner for ${uname.out.trim() || "this Machine"}`);
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
      `exec ${placedAt(version)} --json onboard --to ${quoted(version)}${secrets === "" ? "" : " --secrets-stdin"}`,
    );
    const child = yield* spawned(() =>
      Bun.spawn([...command], {
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
              const left = run.current().steps.some(({ status }) => !SETTLED.includes(status));
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
    return { code, said: (yield* Effect.promise(() => said)).trim() };
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
export const doctorOn = (route: Pick<Route, "collie">) =>
  route.collie(["--json", "doctor"]).pipe(
    Effect.flatMap(({ out }) => Schema.decodeUnknownEffect(DoctorSaid)(out.trim())),
    Effect.map((said) => ("data" in said ? said.data : said.error.details).checks),
    Effect.flatMap((checks) =>
      Effect.map(Clock.currentTimeMillis, (at): OnboardRun => {
        const steps = checks.flatMap(({ name, ok, detail, fix, warn }): OnboardStep[] => {
          const byDefault = DEFAULT_STEPS.get(name);
          if (byDefault !== undefined && (!ok || warn === true || fix !== ""))
            return [{ step: byDefault, title: name, status: "needs_human", detail, command: fix }];
          if (ok) return [];
          return [
            {
              step: name.replaceAll(" ", "-"),
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
  const lines = text.slice(0, asked.index).split("\n");
  const blank = lines.findLastIndex((line, at) => at < lines.length - 1 && line.trim() === "");
  return {
    text: lines
      .slice(blank + 1)
      .join("\n")
      .trim(),
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
  const command = [herdr, "machine", "add", "--label", label, "--remote-session", session, target]
    .map(quoted)
    .join(" ");
  const child = yield* spawned(() =>
    Bun.spawn(["script", "-qefc", command, "/dev/null"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  let said = "";
  let answered = 0;
  yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        said += chunk.replace(TERMINAL_CODES, "");
        // Less the terminal's echo of the last answer.
        const asked = questionIn(said.slice(answered).replace(/^\s*[yn]\n/, ""));
        if (asked === null) return;
        answered = said.length;
        const yes = yield* ask(asked.text, asked.yes);
        void child.stdin.write(yes ? "y\n" : "n\n");
        void child.stdin.flush();
      }),
    ),
    Effect.ignore,
  );
  const code = yield* Effect.promise(() => child.exited);
  if (code !== 0) {
    const last = said.trim().split("\n").slice(-3).join("\n");
    return yield* Effect.fail(last || `herdr machine add exited ${code}`);
  }
}, Effect.scoped);
