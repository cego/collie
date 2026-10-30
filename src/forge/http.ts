// ForgeHttp: a `forges` provider per forge host, its token read from the CLI logged in to
// that host (ADR-draft-a-forge-is-asked-over-http-with-its-clis-login). Only `src/forge/`
// imports `forges`, and only here: lazily, so a start that asks no forge never loads it.

import * as Str from "effect/String";
import * as Cause from "effect/Cause";
import { pipe as pipe_ } from "effect/Function";
import { Clock, Config, Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { FetchLike, ForgeProvider, GitHubProvider } from "forges";
import type { MrForge } from "../board-model";
import { shell, type Runner } from "../mr";

/**
 * How a host's CLI login is read. Each step is a **credential read**, the only commands
 * ForgeHttp runs; an adapter supplies them, since only it runs its CLI.
 */
export interface ForgeLogin {
  readonly forge: MrForge;
  readonly host: string;
  /** One cache entry per key: a stricter read of a host keeps its own. */
  readonly key: string;
  readonly display: string;
  readonly cli: string;
  /** What a host whose CLI holds no token answers, as `ready` says it. */
  readonly notReady: string;
  /** The command that logs the CLI in to the host again. */
  readonly relogin: string;
  /** When the stored token expires, in epoch ms, null where it does not. */
  readonly expiry: (run: Runner, cwd: string) => Effect.Effect<number | null>;
  readonly token: <R>(run: Runner<R>, cwd: string) => Effect.Effect<string | null, never, R>;
  /** Has the CLI refresh an expired token; false where it could not. */
  readonly refresh: (run: Runner, cwd: string) => Effect.Effect<boolean>;
}

/** A host's provider: GitHub's also answers GraphQL. */
export type Provider = ForgeProvider & Partial<Pick<GitHubProvider, "graphql">>;

/** What a forge answered, or why it could not be asked. */
export type Answered<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

export class ForgeHttp extends Context.Service<
  ForgeHttp,
  {
    /**
     * `call` on the login's host with the CLI's token. After a 401 the token is read again
     * once and `call` made once more: a forge that answers 401 applied nothing.
     */
    readonly ask: <A>(
      login: ForgeLogin,
      cwd: string,
      call: (provider: Provider, signal: AbortSignal) => Promise<A>,
    ) => Effect.Effect<Answered<A>>;
  }
>()("collie/ForgeHttp") {}

const library = () => import("forges");

/** Why a call failed, from the library's typed error. */
const reasonOf = (
  forges: Awaited<ReturnType<typeof library>>,
  display: string,
  error: Error,
): string => {
  if (error instanceof forges.RateLimitedError)
    return `${display} answered ${error.status}: rate limited${error.resetAt === undefined ? "" : `, until ${error.resetAt.toISOString()}`}`;
  if (error instanceof forges.ForgeApiError) {
    const said = /"message"\s*:\s*"([^"]*)"/.exec(error.body)?.[1] ?? error.message;
    return `${display} answered ${error.status}: ${said}`;
  }
  if (error instanceof forges.ForgeTimeoutError)
    return `${display} did not answer within ${error.timeout / 1000} s`;
  if (error instanceof forges.ForgeNetworkError)
    return `${display} could not be reached: ${error.message}`;
  return `${display} could not be asked: ${error.message}`;
};

interface Sent<A> {
  readonly sent: Answered<A>;
  readonly refused: boolean;
}

interface Slot {
  provider: Promise<Provider> | null;
  token: string | null;
  expires: number | null;
}

const make = (run: Runner, fetch: FetchLike | undefined, base: string | null) =>
  Effect.sync(() => {
    const slots = new Map<string, Slot>();
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (host: string) => {
      const known = locks.get(host);
      if (known !== undefined) return known;
      const lock = Semaphore.makeUnsafe(1);
      locks.set(host, lock);
      return lock;
    };
    const slotOf = (key: string) => {
      const known = slots.get(key);
      if (known !== undefined) return known;
      const slot: Slot = {
        provider: null,
        token: null,
        expires: null,
      };
      slots.set(key, slot);
      return slot;
    };

    const providerOf = (login: ForgeLogin, slot: Slot) =>
      (slot.provider ??= library().then(({ github, gitlab }) => {
        const auth = { type: "token" as const, token: () => slot.token ?? "" };
        if (login.forge === "github")
          return github({
            auth,
            fetch,
            baseUrl: base === null ? undefined : `${base}/api.github.com`,
          });
        return gitlab({
          auth,
          fetch,
          baseUrl: base === null ? `https://${login.host}` : `${base}/${login.host}`,
        });
      }));

    /** The host's token: the cached one while it has not expired, else the CLI's, refreshed first where it expired. */
    const tokenOf = (login: ForgeLogin, cwd: string, slot: Slot) =>
      lockOf(login.host).withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (slot.token !== null && (slot.expires === null || now < slot.expires))
            return slot.token;
          const cached = slot.token !== null;
          slot.token = null;
          let expires = cached ? slot.expires : yield* login.expiry(run, cwd);
          if (expires !== null && expires <= now) {
            if (!(yield* login.refresh(run, cwd))) return null;
            expires = yield* login.expiry(run, cwd);
            if (expires !== null && expires <= (yield* Clock.currentTimeMillis)) return null;
          }
          const token = yield* login.token(run, cwd);
          if (token === null) return null;
          slot.token = token;
          slot.expires = expires;
          return token;
        }),
      );

    const ask = <A>(
      login: ForgeLogin,
      cwd: string,
      call: (provider: Provider, signal: AbortSignal) => Promise<A>,
    ): Effect.Effect<Answered<A>> =>
      Effect.gen(function* () {
        const slot = slotOf(login.key);
        const send = (token: string) =>
          Effect.tryPromise({
            try: (signal) => providerOf(login, slot).then((provider) => call(provider, signal)),
            catch: (error) => new Cause.UnknownError(error),
          }).pipe(
            Effect.map((value): Sent<A> => ({ sent: { ok: true, value }, refused: false })),
            Effect.catch((failed) =>
              Effect.map(Effect.promise(library), (forges): Sent<A> => {
                const error =
                  failed.cause instanceof Error ? failed.cause : new Error(String(failed.cause));
                const refused = error instanceof forges.ForgeApiError && error.status === 401;
                // Another call may have read a new token since this one sent its own.
                if (refused && slot.token === token) slot.token = null;
                return {
                  sent: { ok: false, reason: reasonOf(forges, login.display, error) },
                  refused,
                };
              }),
            ),
          );
        const notReady = { ok: false, reason: login.notReady } as const;
        const first = yield* tokenOf(login, cwd, slot);
        if (first === null) return notReady;
        const sent = yield* send(first);
        if (!sent.refused) return sent.sent;
        const second = yield* tokenOf(login, cwd, slot);
        if (second === null) return notReady;
        const resent = yield* send(second);
        if (!resent.refused) return resent.sent;
        return {
          ok: false,
          reason: `${login.display} refused ${login.cli}'s login for ${login.host}: run ${login.relogin}`,
        } as const;
      });

    return { ask };
  });

/** One request to the login's host, as `<cli> api` sent it: its parsed body, or why not. */
export const request = (
  login: ForgeLogin,
  cwd: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: Record<string, string>,
) =>
  Effect.flatMap(ForgeHttp, (http) =>
    http.ask(login, cwd, (provider, signal) =>
      provider.request<unknown>(method, path, { signal, body }).then((answer) => answer.data),
    ),
  );

/** Reads `body` as `schema`, or says what was asked was answered in another shape. */
const decodedAs =
  <S extends Schema.Decoder<unknown>>(schema: S, login: ForgeLogin, what: string) =>
  (answer: Answered<unknown>): Answered<S["Type"]> => {
    if (!answer.ok) return answer;
    const read = Schema.decodeUnknownOption(schema)(answer.value);
    return Option.isSome(read)
      ? { ok: true, value: read.value }
      : { ok: false, reason: `${login.display} answered ${what} in a shape Collie does not read` };
  };

/** A GraphQL query's `data`, read as `schema`, or why not. */
export const graphqlAs = <S extends Schema.Decoder<unknown>>(
  schema: S,
  login: ForgeLogin,
  cwd: string,
  query: string,
  variables: Record<string, string | number | null>,
): Effect.Effect<Answered<S["Type"]>, never, ForgeHttp> =>
  Effect.flatMap(ForgeHttp, (http) =>
    http.ask(login, cwd, (provider, signal) =>
      provider.graphql === undefined
        ? Promise.reject(new Error(`${login.display} answers no GraphQL`))
        : provider.graphql<unknown>(query, variables, { signal }),
    ),
  ).pipe(Effect.map(decodedAs(schema, login, "a GraphQL query")));

/** A GET of `path`, its body read as `schema`, or why not. */
export const requestAs = <S extends Schema.Decoder<unknown>>(
  schema: S,
  login: ForgeLogin,
  cwd: string,
  path: string,
): Effect.Effect<Answered<S["Type"]>, never, ForgeHttp> =>
  Effect.map(request(login, cwd, "GET", path), decodedAs(schema, login, path));

/** Every page of a list at `path`, its items read as `schema`, or why not. */
export const pagesAs = <S extends Schema.Decoder<unknown>>(
  item: S,
  login: ForgeLogin,
  cwd: string,
  path: string,
): Effect.Effect<Answered<Array<S["Type"]>>, never, ForgeHttp> =>
  Effect.gen(function* () {
    const items: Array<S["Type"]> = [];
    const pages = Schema.Array(item);
    const separator = pipe_(path, Str.includes("?")) ? "&" : "?";
    for (let page = 1; ; page++) {
      const listed = yield* requestAs(
        pages,
        login,
        cwd,
        `${path}${separator}per_page=${PAGE}&page=${page}`,
      );
      if (!listed.ok) return listed;
      items.push(...listed.value);
      if (listed.value.length < PAGE) return { ok: true, value: items };
    }
  });

const PAGE = 100;

/**
 * ForgeHttp as Collie runs it: credential reads through the CLIs on PATH, and requests to
 * each forge host, or to `COLLIE_FORGE_API` where a test serves the fake forge there.
 */
export const forgeHttpLayer = Layer.effect(ForgeHttp)(
  Effect.gen(function* () {
    const spawner = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    const base = yield* Config.String("COLLIE_FORGE_API").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const run: Runner = (cmd, args, cwd) =>
      shell(cmd, args, cwd).pipe(Effect.provideContext(spawner));
    return yield* make(run, undefined, base === "" ? null : base);
  }),
);

/** ForgeHttp over a fake: its credential reads through `run`, its requests through `fetch`. */
export const forgeHttpTest = (run: Runner, fetch: FetchLike) =>
  Layer.effect(ForgeHttp)(make(run, fetch, null));
