import * as Arr from "effect/Array";
import { Effect } from "effect";
import type { Context } from "effect";
import { recordAudit, readAudit } from "./audit";
import { Started, mrId, mrRefOf } from "./board-model";
import { savedModules } from "./discovery";
import { runDir } from "./engine";
import type { HostServices, RegistryApi } from "./engine";
import type { PluginEnv } from "./env";
import type { PlatformServices } from "./platform";
import { followClaim, followingOn } from "./follow-through";
import { FORGES } from "./forge/forge";
import { shell } from "./mr";
import { append as appendNews, newsPath, read as readNews } from "./news";
import { repositoryCheckout } from "./projects";
import { machineHerd } from "./steering";
import { freshTaskLabel } from "./tasknames";

export const FOLLOW_SETTING = "review.follow_through";

export interface Requested {
  readonly claimed: (suffix: string) => Effect.Effect<boolean>;
  readonly start: (
    project: string,
    id: string,
    target: string,
    title: string,
  ) => Effect.Effect<void, never, PlatformServices>;
}

export const requestedOver: (
  claimed: Requested["claimed"],
  registry: RegistryApi,
  env: PluginEnv,
  hosted: Context.Context<HostServices>,
) => Requested = (claimed, registry, env, hosted) => ({
  claimed,
  start: (project, id, target, title) =>
    Effect.gen(function* () {
      const request = `review-requested:${mrId(target) ?? target}`;
      const generation = yield* registry.resolve({ project, id });
      const admitted = yield* registry.start({
        generation,
        request,
        project,
        input: { target },
        text: {},
        task: null,
        taskLabel: yield* freshTaskLabel(
          { ...env, cwd: project },
          { workflow: id, inputs: { target }, goal: undefined, title },
          false,
        ),
      });
      const trail = runDir(env.stateDir, admitted.runId);
      if (!Arr.some(yield* readAudit(trail), (line) => line.request === request)) {
        yield* recordAudit(trail, {
          operation: "start",
          request,
          origin: "host",
          result: Started,
          value: admitted,
        });
      }
    }).pipe(
      Effect.provideContext(hosted),
      Effect.catchCause((cause) =>
        Effect.logWarning(`could not start a review of ${target}`, cause),
      ),
    ),
});

const sayOnce = (env: PluginEnv, key: string, text: string) =>
  Effect.gen(function* () {
    const file = yield* newsPath(env.stateDir, yield* machineHerd(env));
    const said = Arr.some(yield* readNews(file), (line) => line.key === key);
    if (!said) {
      yield* appendNews(file, { key, run: "", text });
    }
  }).pipe(Effect.ignore({ log: "Warn" }));

export const startRequested = Effect.fn("ReviewRequests.start")(function* (opts: {
  readonly env: PluginEnv;
  readonly gitlabHost: string;
  readonly logins: Map<string, string>;
  readonly requested: Requested;
}) {
  const { env, gitlabHost: host, logins } = opts;
  if (!(yield* followingOn(env.userDir, FOLLOW_SETTING))) {
    return;
  }
  const gitlab = FORGES.gitlab;
  const login = logins.get(host) ?? (yield* gitlab.login(env.cwd, shell, host));
  if (login === null) {
    return;
  }
  logins.set(host, login);
  const listed = yield* gitlab.reviewRequests(host, login, env.cwd, shell);
  if (!listed.ok) {
    if (listed.status === 401 || listed.status === 403) {
      logins.delete(host);
    }
    return;
  }
  if (listed.value.length === 0) {
    logins.delete(host);
  }
  for (const { url, title, author } of listed.value) {
    const mr = mrId(url);
    const ref = mrRefOf(url);
    if (author === login || mr === null || ref?.project == null) {
      continue;
    }
    if (yield* opts.requested.claimed(followClaim(mr, login))) {
      continue;
    }
    const checkout = yield* repositoryCheckout(env, `https://${ref.project}`);
    if (checkout === null || !("path" in checkout)) {
      yield* sayOnce(
        env,
        `review-requested-unplaced:${mr}`,
        `${url} asks you to review it, and no checkout under the Projects root has ${ref.project} as its remote: clone it there and it starts on the next round.`,
      );
      continue;
    }
    const following = Arr.filter(
      (yield* savedModules({ ...env, cwd: checkout.path })).entries,
      (entry) => entry.follows === FOLLOW_SETTING,
    );
    if (following.length === 1) {
      yield* opts.requested.start(checkout.path, following[0]!.id, url, title);
    } else if (following.length > 1) {
      yield* sayOnce(
        env,
        `review-requested-ambiguous:${mr}`,
        `${url} asks you to review it, and ${Arr.join(
          Arr.map(following, (entry) => entry.id),
          ", ",
        )} all follow ${FOLLOW_SETTING} in ${checkout.path}: start the one you want by hand.`,
      );
    }
  }
});
