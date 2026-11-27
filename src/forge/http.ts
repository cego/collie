import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as Cause from "effect/Cause";
import { pipe as pipe_ } from "effect/Function";
import { Clock, Config, Context, Effect, Layer, Option, Order, Schema, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { FetchLike, ForgeProvider, GitHubProvider } from "forges";
import type { MrForge } from "../board-model";
import { shell } from "../mr";
import type { Runner } from "../mr";
import { epochMs } from "../time";
import type { Readiness } from "./forge";

export interface ForgeLogin {
  readonly forge: MrForge;
  readonly host: string;
  // WARNING: A stricter read of a host keeps its own entry, so the cache key is not the host alone.
  readonly key: string;
  readonly display: string;
  readonly cli: string;
  readonly notReady: string;
  readonly relogin: string;
  readonly expiry: (run: Runner, cwd: string) => Effect.Effect<number | null>;
  readonly token: <R>(run: Runner<R>, cwd: string) => Effect.Effect<string | null, never, R>;
  readonly refresh: (run: Runner, cwd: string) => Effect.Effect<boolean>;
}

export type Provider = ForgeProvider & Partial<Pick<GitHubProvider, "graphql">>;

export type Answered<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly status?: number;
      readonly transient?: boolean;
    };

export interface Asked {
  attempts: number;
  limited: number;
}

export class Asking extends Context.Service<Asking, Asked>()("collie/ForgeHttp/Asking") {}

export class ForgeHttp extends Context.Service<
  ForgeHttp,
  {
    // WARNING: After a 401 the token is read again once and the call made once more: a forge that answers 401 applied nothing.
    readonly ask: <A>(
      login: ForgeLogin,
      cwd: string,
      call: (provider: Provider, signal: AbortSignal) => Promise<A>,
    ) => Effect.Effect<Answered<A>>;
    readonly attempts: Effect.Effect<number>;
  }
>()("collie/ForgeHttp") {}

const library = () => import("forges");

const reasonOf = (forges: Awaited<ReturnType<typeof library>>, display: string, error: Error) => {
  if (error instanceof forges.RateLimitedError) {
    return `${display} answered ${error.status}: rate limited${error.resetAt === undefined ? "" : `, until ${error.resetAt.toISOString()}`}`;
  }
  if (error instanceof forges.ForgeApiError) {
    const said = /"message"\s*:\s*"([^"]*)"/.exec(error.body)?.[1] ?? error.message;
    return `${display} answered ${error.status}: ${said}`;
  }
  if (error instanceof forges.ForgeTimeoutError) {
    return `${display} did not answer within ${error.timeout / 1000} s`;
  }
  if (error instanceof forges.ForgeNetworkError) {
    return `${display} could not be reached: ${error.message}`;
  }
  return `${display} could not be asked: ${error.message}`;
};

export const rateLimitedUntil = (reason: string) => {
  const until = /: rate limited, until (\S+Z)/.exec(reason)?.[1];
  return until === undefined ? null : epochMs(until);
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

// WARNING: the forge client's own reading of a refusal, restated here: a body names limits its headers cannot.
const SECONDARY_LIMIT_RE = /secondary rate limit|abuse detection|submitted too quickly/i;
const PLAIN_LIMIT_RE = /^[^{<]{0,80}\brate limit exceeded\b/i;

const budgetOf = (response: Response) => {
  const number = (...names: ReadonlyArray<string>) => {
    for (const name of names) {
      const header = response.headers.get(name);
      const value = header === null ? undefined : Str.trim(Str.split(header, /[,;]/)[0]);
      if (value !== undefined && value !== "" && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
    return undefined;
  };
  const limit = number("x-ratelimit-limit", "ratelimit-limit");
  const remaining = number("x-ratelimit-remaining", "ratelimit-remaining");
  const reset = number("x-ratelimit-reset", "ratelimit-reset");
  if (limit === undefined && remaining === undefined && reset === undefined) {
    return structuredBudget(response);
  }
  return { limit, remaining };
};

const fieldMembers = (response: Response, name: string) => {
  const members = new Map<string, Record<string, number>>();
  const header = response.headers.get(name);
  if (header === null) {
    return members;
  }
  for (const member of Str.split(header, ",")) {
    const [key, ...params] = Str.split(member, ";");
    members.set(
      Str.replace(/^"(.*)"$/, "$1")(Str.trim(key)),
      Rec.fromEntries(
        Arr.map(params, (param) => {
          const [field, value] = Str.split(param, "=");
          return [Str.trim(field), Number(value)] as const;
        }),
      ),
    );
  }
  return members;
};

// WARNING: the forge client's reading of the IETF budget fields, restated here: its own reader is private.
const structuredBudget = (response: Response) => {
  const fewest = Arr.head(
    Arr.sortWith(
      Arr.filter(Array.from(fieldMembers(response, "ratelimit")), ([, params]) =>
        Number.isFinite(params.r),
      ),
      ([, params]) => params.r ?? 0,
      Order.Number,
    ),
  );
  if (Option.isNone(fewest)) {
    return null;
  }
  const [name, state] = fewest.value;
  const limit = fieldMembers(response, "ratelimit-policy").get(name)?.q;
  return { limit, remaining: state.r };
};

const ErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.Json),
  errors: Schema.optionalKey(Schema.Json),
});
const ErrorEntry = Schema.Struct({ message: Schema.String });
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));
const decodeErrorEntry = Schema.decodeUnknownOption(ErrorEntry);

// WARNING: the forge client reads a string `message` or an `errors[].message`, never a bare entry.
const messagesIn = (one: Schema.Json | undefined) =>
  Schema.is(Schema.Array(Schema.Json))(one)
    ? Arr.map(one, (entry) =>
        Option.map(decodeErrorEntry(entry), (said) => said.message).pipe(Option.getOrUndefined),
      )
    : [];

const namesSecondaryLimit = (body: string) => {
  const parsed = Option.getOrNull(decodeErrorBody(body));
  if (parsed === null) {
    return false;
  }
  return Arr.some(
    [parsed.message, ...messagesIn(parsed.errors)],
    (said) => Schema.is(Schema.String)(said) && SECONDARY_LIMIT_RE.test(said),
  );
};

const refusedByLimit: (response: Response) => Promise<boolean> = (response) => {
  if (response.status === 429) {
    return Promise.resolve(true);
  }
  if (response.status !== 403 && response.status !== 422) {
    return Promise.resolve(false);
  }
  // WARNING: read from a clone: the forge client still needs the body to classify the refusal itself.
  return response
    .clone()
    .text()
    .catch(() => "")
    .then((body) => {
      if (namesSecondaryLimit(body)) {
        return true;
      }
      if (response.status !== 403) {
        return false;
      }
      const budget = budgetOf(response);
      if (budget?.limit === 0) {
        return false;
      }
      return (
        response.headers.has("retry-after") ||
        budget?.remaining === 0 ||
        (budget === null && PLAIN_LIMIT_RE.test(Str.trim(body)))
      );
    });
};

const make = (run: Runner, fetch: FetchLike | undefined, base: string | null) =>
  Effect.sync(() => {
    let attempts = 0;
    const slots = new Map<string, Slot>();
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (host: string) => {
      const known = locks.get(host);
      if (known !== undefined) {
        return known;
      }
      const lock = Semaphore.makeUnsafe(1);
      locks.set(host, lock);
      return lock;
    };
    const slotOf = (key: string) => {
      const known = slots.get(key);
      if (known !== undefined) {
        return known;
      }
      const slot: Slot = {
        provider: null,
        token: null,
        expires: null,
      };
      slots.set(key, slot);
      return slot;
    };

    const built = (login: ForgeLogin, slot: Slot, transport: FetchLike | undefined) =>
      library().then(({ github, gitlab }) => {
        const auth = { type: "token" as const, token: () => slot.token ?? "" };
        if (login.forge === "github") {
          return github({
            auth,
            fetch: transport,
            baseUrl: base === null ? undefined : `${base}/api.github.com`,
          });
        }
        return gitlab({
          auth,
          fetch: transport,
          baseUrl: base === null ? `https://${login.host}` : `${base}/${login.host}`,
        });
      });

    const providerOf = (login: ForgeLogin, slot: Slot) =>
      (slot.provider ??= built(login, slot, fetch));

    // WARNING: the library retries a 429 by itself, so only the transport sees every request a call made.
    const counted = (spend: Asked) => {
      const carried: FetchLike = (input, init) => (fetch ?? globalThis.fetch)(input, init);
      const transport: FetchLike = (input, init) => {
        spend.attempts += 1;
        return carried(input, init).then((response) =>
          refusedByLimit(response).then((refused) => {
            if (refused) {
              spend.limited += 1;
            }
            return response;
          }),
        );
      };
      return transport;
    };

    const tokenOf = (login: ForgeLogin, cwd: string, slot: Slot) =>
      lockOf(login.host).withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (slot.token !== null && (slot.expires === null || now < slot.expires)) {
            return slot.token;
          }
          const cached = slot.token !== null;
          slot.token = null;
          let expires = cached ? slot.expires : yield* login.expiry(run, cwd);
          if (expires !== null && expires <= now) {
            if (!(yield* login.refresh(run, cwd))) {
              return null;
            }
            expires = yield* login.expiry(run, cwd);
            if (expires !== null && expires <= (yield* Clock.currentTimeMillis)) {
              return null;
            }
          }
          const token = yield* login.token(run, cwd);
          if (token === null) {
            return null;
          }
          slot.token = token;
          slot.expires = expires;
          return token;
        }),
      );

    const ask = <A>(
      login: ForgeLogin,
      cwd: string,
      call: (provider: Provider, signal: AbortSignal) => Promise<A>,
    ) =>
      Effect.gen(function* () {
        const slot = slotOf(login.key);
        const spend = Option.getOrUndefined(yield* Effect.serviceOption(Asking));
        const once = (token: string) =>
          Effect.tryPromise({
            try: (signal) =>
              (spend === undefined
                ? providerOf(login, slot)
                : built(login, slot, counted(spend))
              ).then((provider) => call(provider, signal)),
            catch: (error) => new Cause.UnknownError(error),
          }).pipe(
            Effect.map((value) => {
              const returned: Sent<A> = { sent: { ok: true, value }, refused: false };
              return returned;
            }),
            Effect.catch((failed) =>
              Effect.map(Effect.promise(library), (forges) => {
                const error =
                  failed.cause instanceof Error ? failed.cause : new Error(String(failed.cause));
                const refused = error instanceof forges.ForgeApiError && error.status === 401;
                // WARNING: Another call may have read a new token since this one sent its own.
                if (refused && slot.token === token) {
                  slot.token = null;
                }
                const reason = reasonOf(forges, login.display, error);
                const transient =
                  error instanceof forges.RateLimitedError ||
                  error instanceof forges.ForgeNetworkError ||
                  error instanceof forges.ForgeTimeoutError ||
                  (error instanceof forges.ForgeApiError &&
                    error.status >= 500 &&
                    error.status < 600);
                const returned: Sent<A> = {
                  sent:
                    error instanceof forges.ForgeApiError
                      ? { ok: false, reason, status: error.status, transient }
                      : { ok: false, reason, transient },
                  refused,
                };
                return returned;
              }),
            ),
          );
        const send = (token: string) =>
          Effect.gen(function* () {
            attempts += 1;
            return yield* once(token);
          });
        const notReady = { ok: false, reason: login.notReady } as const;
        const first = yield* tokenOf(login, cwd, slot);
        if (first === null) {
          return notReady;
        }
        const sent = yield* send(first);
        if (!sent.refused) {
          return sent.sent;
        }
        const second = yield* tokenOf(login, cwd, slot);
        if (second === null) {
          return notReady;
        }
        const resent = yield* send(second);
        if (!resent.refused) {
          return resent.sent;
        }
        return {
          ok: false,
          reason: `${login.display} refused ${login.cli}'s login for ${login.host}: run ${login.relogin}`,
          status: 401,
        } as const;
      });

    return { ask, attempts: Effect.sync(() => attempts) };
  });

export const loginReadiness: <R>(
  login: ForgeLogin,
  cwd: string,
  run: Runner<R>,
) => Effect.Effect<Readiness, never, R | ForgeHttp> = <R>(
  login: ForgeLogin,
  cwd: string,
  run: Runner<R>,
) =>
  Effect.gen(function* () {
    const http = yield* ForgeHttp;
    const me = yield* http.ask(login, cwd, (provider, signal) => provider.users.me({ signal }));
    if (me.ok) {
      return { ok: true, reason: "" };
    }
    const refused = me.status === 401 || (me.status === 403 && /bad credentials/i.test(me.reason));
    return refused || (yield* login.token(run, cwd)) === null
      ? { ok: false, reason: login.notReady, cause: "login-missing" }
      : {
          ok: false,
          reason: `${login.cli} could not verify its login to ${login.host}: ${me.reason}`,
          cause: "forge-unavailable",
        };
  });

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

export const requestText = (login: ForgeLogin, cwd: string, path: string) =>
  Effect.flatMap(ForgeHttp, (http) =>
    http.ask(login, cwd, (provider, signal) =>
      provider
        .request("GET", path, { signal, raw: true })
        .then((answer) => new Response(answer.body).text()),
    ),
  );

const decodedAs =
  <S extends Schema.Decoder<unknown>>(schema: S, login: ForgeLogin, what: string) =>
  (answer: Answered<unknown>) => {
    if (!answer.ok) {
      const returned: Answered<S["Type"]> = answer;
      return returned;
    }
    const read = Schema.decodeUnknownOption(schema)(answer.value);
    const returned: Answered<S["Type"]> = Option.isSome(read)
      ? { ok: true, value: read.value }
      : {
          ok: false,
          reason: `${login.display} answered ${what} in a shape Collie does not read`,
        };
    return returned;
  };

export const graphqlAs = <S extends Schema.Decoder<unknown>>(
  schema: S,
  login: ForgeLogin,
  cwd: string,
  query: string,
  variables: Record<string, string | number | null>,
) =>
  Effect.flatMap(ForgeHttp, (http) =>
    http.ask(login, cwd, (provider, signal) =>
      provider.graphql === undefined
        ? Promise.reject(new Error(`${login.display} answers no GraphQL`))
        : provider.graphql<unknown>(query, variables, { signal }),
    ),
  ).pipe(Effect.map(decodedAs(schema, login, "a GraphQL query")));

export const requestAs = <S extends Schema.Decoder<unknown>>(
  schema: S,
  login: ForgeLogin,
  cwd: string,
  path: string,
) => Effect.map(request(login, cwd, "GET", path), decodedAs(schema, login, path));

export const pagesAs: <S extends Schema.Decoder<unknown>>(
  item: S,
  login: ForgeLogin,
  cwd: string,
  path: string,
) => Effect.Effect<Answered<Array<S["Type"]>>, never, ForgeHttp> = <
  S extends Schema.Decoder<unknown>,
>(
  item: S,
  login: ForgeLogin,
  cwd: string,
  path: string,
) =>
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
      if (!listed.ok) {
        return listed;
      }
      items.push(...listed.value);
      if (listed.value.length < PAGE) {
        return { ok: true, value: items };
      }
    }
  });

const PAGE = 100;

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

export const forgeHttpTest = (run: Runner, fetch: FetchLike) =>
  Layer.effect(ForgeHttp)(make(run, fetch, null));
