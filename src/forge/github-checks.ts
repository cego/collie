import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { gitlabHostOf } from "../config";
import { FETCH_LIMIT, answered, failed, onPath, passed, type Check } from "../doctor-check";
import type { PluginEnv } from "../env";
import { forgeHere, type Runner } from "../mr";
import { checkoutsUnder, projectsRoot } from "../projects";

const HOST = "github.com";

export const githubChecks = Effect.fn("Doctor.githubChecks")(function* (
  env: PluginEnv,
  search: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const gitlabHost = yield* gitlabHostOf(env);
  let used = 0;
  for (const checkout of yield* checkoutsUnder((yield* projectsRoot(env)).path)) {
    const here = yield* forgeHere(checkout, run, gitlabHost);
    if (here.ok && here.forge.name === "github") used += 1;
  }
  if (used === 0) return [];
  const by = `used by ${used} checkout${used === 1 ? "" : "s"}`;
  if ((yield* onPath(search, "gh")) === null)
    return [
      {
        name: "gh",
        ...failed(
          `not installed; Runs on GitHub repositories cannot open or review pull requests (${by})`,
          "install gh — https://cli.github.com",
        ),
      },
    ] satisfies Check[];
  const auth = yield* answered(run("gh", ["auth", "status", "--hostname", HOST], env.pluginRoot));
  return [
    {
      name: "gh",
      ...(auth.code === 0
        ? passed(`logged in to ${HOST}, ${by}`)
        : auth.code === 124
          ? failed(
              `installed, but did not answer within ${FETCH_LIMIT}`,
              `gh auth status --hostname ${HOST}`,
            )
          : failed(
              `installed, but not logged in to ${HOST} (${by})`,
              `gh auth login --hostname ${HOST}`,
            )),
    },
  ] satisfies Check[];
});
