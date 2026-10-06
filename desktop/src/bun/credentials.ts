// What only the human can give, asked once by Desktop: credentials kept in this computer's
// keyring and handed to each Machine on stdin, and logins approved in this computer's browser.

import { Effect, Option, Queue, Schedule, Schema, Stream } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { GITLAB_HOST, SCOPES, TokenSelf } from "../../../src/gitlab-token";
import type { OnboardRun } from "../shared/flock";
import { quoted, type ShellRoute, spawned } from "./machine";
import { ranWith, shOn, tracked } from "./onboarding";

export const GITLAB = `https://${GITLAB_HOST}`;

/** What Desktop keeps in the keyring, by name. */
export type KeyringEntry = "gitlab-token" | "helle-url" | "helle-token";

export interface Keyring {
  readonly lookup: (key: KeyringEntry) => Effect.Effect<string | null, string>;
  readonly store: (key: KeyringEntry, label: string, value: string) => Effect.Effect<void, string>;
}

/** The Secret Service keyring, through libsecret's `secret-tool`. */
export const secretService = (tool = "secret-tool"): Keyring => {
  const present =
    Bun.which(tool) === null
      ? Effect.fail(`${tool} is not installed; install libsecret-tools to keep credentials`)
      : Effect.void;
  const attributes = (key: KeyringEntry) => ["service", "collie-desktop", "key", key];
  return {
    lookup: (key) =>
      present.pipe(
        Effect.andThen(ranWith([tool, "lookup", ...attributes(key)])),
        Effect.map(({ out, code }) => (code === 0 && out !== "" ? out : null)),
      ),
    store: (key, label, value) =>
      present.pipe(
        Effect.andThen(
          ranWith(
            [tool, "store", "--label", label, ...attributes(key)],
            new TextEncoder().encode(value),
          ),
        ),
        Effect.flatMap(({ err, code }) =>
          code === 0 ? Effect.void : Effect.fail(err.trim() || `${tool} store exited ${code}`),
        ),
      ),
  };
};

/** The `collie onboard --secrets-stdin` lines for every secret Desktop holds. */
export const secretsFor = (keyring: Keyring) =>
  Effect.gen(function* () {
    const lines: Array<readonly [string, KeyringEntry]> = [
      ["GITLAB_TOKEN", "gitlab-token"],
      ["HELLE_API_URL", "helle-url"],
      ["HELLE_API_TOKEN", "helle-token"],
    ];
    let text = "";
    for (const [name, key] of lines) {
      const value = yield* keyring.lookup(key);
      if (value !== null) text += `${name}=${value}\n`;
    }
    return text;
  });

/**
 * What GitLab at `base` says of `token`, once it accepts it with the scopes Collie needs:
 * when it expires, or null where it never does.
 */
export const gitlabToken = (base: string, token: string) =>
  HttpClient.execute(
    HttpClientRequest.get(`${base}/api/v4/personal_access_tokens/self`).pipe(
      HttpClientRequest.setHeader("PRIVATE-TOKEN", token),
    ),
  ).pipe(
    Effect.mapError((error) => `could not ask ${base} about the token: ${error.message}`),
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text.pipe(Effect.mapError((error) => error.message))
        : Effect.fail(`${base} did not accept that token (${response.status})`),
    ),
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(TokenSelf)(text).pipe(Effect.mapError((e) => e.message)),
    ),
    Effect.flatMap(({ expires_at, scopes }) =>
      scopes !== undefined && SCOPES.some((scope) => !scopes.includes(scope))
        ? Effect.fail(`the token needs the ${SCOPES.join(" and ")} scopes`)
        : Effect.succeed({ expires: expires_at }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

/** Runs `script` on every Machine with `stdin`, and says how each went. */
const onEvery = (routes: ReadonlyArray<ShellRoute>, script: string, stdin: string) =>
  Effect.forEach(
    routes,
    (route) =>
      shOn(route, script, new TextEncoder().encode(stdin)).pipe(
        Effect.flatMap(({ err, out, code }) =>
          code === 0 ? Effect.succeed(null) : Effect.fail((err + out).trim() || `exited ${code}`),
        ),
        Effect.catch((failed) => Effect.succeed(failed)),
        Effect.map((failed) => ({ name: route.machine.name, failed })),
      ),
    { concurrency: "unbounded" },
  );

/** Logs glab in to `host` with `token` on every Machine. */
export const giveToken = (routes: ReadonlyArray<ShellRoute>, host: string, token: string) =>
  onEvery(routes, `exec glab auth login --hostname ${quoted(host)} --stdin`, `${token}\n`);

/** Writes Helle's credentials file, owner-only, on every Machine, as onboarding does. */
export const giveHelle = (routes: ReadonlyArray<ShellRoute>, url: string, token: string) =>
  onEvery(
    routes,
    'umask 077 && mkdir -p "$HOME/.config/helle" && cat > "$HOME/.config/helle/env.new" && mv "$HOME/.config/helle/env.new" "$HOME/.config/helle/env"',
    `HELLE_API_URL=${url}\nHELLE_API_TOKEN=${token}\n`,
  );

/** Whether a credential can go on a `KEY=value` line, as every Machine is given it. */
export const oneLine = (value: string) => value !== "" && !/[\r\n]/.test(value);

const LOGIN_LIMIT = "10 minutes";
const URL_IN = /https:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/;
const SHIM = '"$HOME/.cache/collie/login-browser"';
const HANDED = '"$HOME/.cache/collie/login-url"';

/** The callback port of a login URL whose `redirect_uri` is on localhost, if it has one. */
const callbackPort = (url: string) =>
  Option.liftThrowable(
    () => new URL(new URL(url).searchParams.get("redirect_uri") ?? "").port,
  )().pipe(
    Option.map(Number),
    Option.filter((port) => port > 0),
  );

/**
 * `claude auth login` on the Machine, approved in this computer's browser: Claude Code hands
 * its callback URL to `$BROWSER`, whose shim writes it down to be forwarded and opened
 * here. The printed paste-code URL and each code in `codes` are the fallback.
 */
export const claudeLoginThrough = Effect.fn("Desktop.claudeLoginThrough")(function* (
  route: ShellRoute,
  open: (url: string) => Effect.Effect<void>,
  codes: Queue.Queue<string>,
  told: (run: OnboardRun) => Effect.Effect<void>,
  start: OnboardRun,
) {
  const run = tracked(told, start);
  const login = { step: "claude-login", title: "Claude Code logged in" } as const;
  yield* run.step({
    ...login,
    status: "running",
    detail: "Approve the login in your browser",
  });
  const shimmed = yield* shOn(
    route,
    `mkdir -p "$HOME/.cache/collie" && rm -f ${HANDED} && printf '#!/bin/sh\\necho "$1" > %s\\n' '${HANDED}' > ${SHIM} && chmod +x ${SHIM}`,
  ).pipe(Effect.result);
  if (shimmed._tag === "Failure" || shimmed.success.code !== 0) {
    yield* run.step({ ...login, status: "failed", detail: "could not start the login there" });
    return { ended: false, run: run.current() };
  }
  const command = yield* route.sh(
    `BROWSER=${SHIM} exec script -qefc 'claude auth login' /dev/null`,
  );
  const child = yield* spawned(() =>
    Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
  );
  const printed = Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line) => URL_IN.exec(line)?.[0]),
    Stream.filter((url) => url !== undefined),
    // Read to the end all the same: a login whose output is not read dies of SIGPIPE.
    Stream.runForEach((url) =>
      run.current().steps.some((step) => step.step === login.step && step.url !== undefined)
        ? Effect.void
        : run.step({
            ...login,
            url,
            detail: "Approve the login in your browser, or open this and paste the code it shows",
          }),
    ),
    Effect.ignore,
  );
  const handed = shOn(route, `cat ${HANDED} 2>/dev/null && rm -f ${HANDED}`).pipe(
    Effect.flatMap(({ out }) =>
      out.trim() === "" ? Effect.fail("not yet") : Effect.succeed(out.trim()),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second") }),
    Effect.flatMap((url) =>
      Option.match(callbackPort(url), {
        onNone: () => Effect.void,
        onSome: (port) => route.forward(port),
      }).pipe(Effect.ignore, Effect.andThen(open(url))),
    ),
  );
  const typed = Queue.take(codes).pipe(
    Effect.flatMap((code) =>
      Effect.sync(() => {
        void child.stdin.write(`${code}\n`);
        void child.stdin.flush();
      }),
    ),
    Effect.forever,
  );
  const code = yield* Effect.raceFirst(
    Effect.promise(() => child.exited),
    Effect.all([printed, handed, typed], { concurrency: "unbounded" }).pipe(
      Effect.andThen(Effect.never),
    ),
  ).pipe(Effect.timeoutOption(LOGIN_LIMIT));
  const ended = Option.isSome(code) && code.value === 0;
  if (!ended)
    yield* run.step({
      ...login,
      status: "failed",
      detail: "the login did not finish",
      command: "claude auth login",
    });
  return { ended, run: run.current() };
}, Effect.scoped);
