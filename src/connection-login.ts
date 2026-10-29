import { Effect } from "effect";
import type { PluginEnv } from "./env";
import { readConfig } from "./config";
import { isHostName } from "./gitlab-token";
import { shell, type Runner } from "./mr";
import type { ChildProcessSpawner } from "effect/process";
import { isString } from "./schema";

export const readConnectionLogin = <R = never>(
  env: PluginEnv,
  id: "gitlab" | "github",
  run: Runner<R | ChildProcessSpawner.ChildProcessSpawner> = shell,
) =>
  Effect.gen(function* () {
    let host = "github.com";
    if (id === "gitlab") {
      const config = yield* readConfig(env.userDir);
      const configured = env.raw.GITLAB_HOST ?? config.gitlab_host;
      const found =
        isString(configured) && isHostName(configured)
          ? configured
          : (yield* run("glab", ["config", "get", "host", "--global"], env.cwd)).stdout.trim();
      host = isHostName(found) ? found : "gitlab.com";
    }
    const fromEnvironment =
      id === "gitlab"
        ? env.raw.GITLAB_TOKEN || env.raw.GITLAB_ACCESS_TOKEN || env.raw.OAUTH_TOKEN
        : undefined;
    const stored =
      fromEnvironment === undefined
        ? yield* run(
            id === "gitlab" ? "glab" : "gh",
            id === "gitlab"
              ? ["config", "get", "token", "--host", host]
              : ["auth", "token", "--hostname", host],
            env.cwd,
          )
        : null;
    const token = fromEnvironment ?? (stored?.code === 0 ? stored.stdout.trim() : "");
    if (token === "" || /[\r\n]/.test(token))
      return yield* Effect.fail(`No reusable ${id} login for ${host}; sign in on this Machine`);
    return { host, token };
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail("The login's Machine did not answer"),
    }),
  );
