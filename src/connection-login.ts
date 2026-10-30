import { Effect } from "effect";
import type { PluginEnv } from "./env";
import { shell, type Runner } from "./mr";
import type { ChildProcessSpawner } from "effect/process";
import { glabLoginOn } from "./forge/gitlab-checks";
import { ghLogin } from "./forge/github";

export const readConnectionLogin = <R = never>(
  env: PluginEnv,
  id: "gitlab" | "github",
  run: Runner<R | ChildProcessSpawner.ChildProcessSpawner> = shell,
) =>
  Effect.gen(function* () {
    const login = id === "gitlab" ? yield* glabLoginOn(env) : ghLogin;
    const fromEnvironment =
      id === "gitlab"
        ? env.raw.GITLAB_TOKEN || env.raw.GITLAB_ACCESS_TOKEN || env.raw.OAUTH_TOKEN
        : undefined;
    const token = fromEnvironment ?? (yield* login.token(run, env.cwd)) ?? "";
    if (token === "" || /[\r\n]/.test(token))
      return yield* Effect.fail(
        `No reusable ${id} login for ${login.host}; sign in on this Machine`,
      );
    return { host: login.host, token };
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail("The login's Machine did not answer"),
    }),
  );
