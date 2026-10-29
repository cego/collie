import { Cause, Effect, type FileSystem, type Path, type PlatformError } from "effect";
import type { Connection, ConnectionId, ConnectionReading } from "./connection-model";
import type { PluginEnv } from "./env";
import {
  helleEnvPath,
  LINEAR_MCP_FIX,
  probeGitlab,
  probeGithub,
  probeHelle,
  probeLinearMcp,
} from "./connection-probes";
import { shell, type Runner } from "./mr";
import type { ChildProcessSpawner } from "effect/process";
import { redact } from "./redact";
import { probeSlack, SLACK_FIX } from "./slack-credentials";
import { slackApi } from "./slack";
import { glabLoginTo } from "./forge/gitlab";
import { ghLogin } from "./forge/github";

export const CONNECTION_TIMEOUT_MS = 6_000;

export interface ConnectionProbe<R = never, E = never> {
  readonly id: ConnectionId;
  readonly fix: string;
  readonly read: Effect.Effect<ConnectionReading, E, R>;
}

export const readConnections = <R, E>(probes: ReadonlyArray<ConnectionProbe<R, E>>) =>
  Effect.forEach(
    probes,
    ({ id, fix, read }) =>
      read.pipe(
        Effect.timeoutOrElse({
          duration: CONNECTION_TIMEOUT_MS,
          orElse: () => Effect.fail(`${id} did not answer within ${CONNECTION_TIMEOUT_MS / 1000}s`),
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.succeed<ConnectionReading>({
                state: "broken",
                detail: redact(Cause.pretty(cause)),
                fix,
              }),
        ),
        Effect.map((reading): Connection => ({ id, reading })),
      ),
    { concurrency: "unbounded" },
  );

export const connectionProbes = (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
  slack = slackApi,
) =>
  [
    { id: "gitlab", read: probeGitlab(env, run), fix: glabLoginTo("gitlab.com").relogin },
    { id: "github", read: probeGithub(env, run), fix: `${ghLogin.relogin} --web` },
    { id: "helle", read: probeHelle(env), fix: `check HELLE_API_TOKEN in ${helleEnvPath(env)}` },
    { id: "linear", read: probeLinearMcp(env), fix: LINEAR_MCP_FIX },
    { id: "slack", read: probeSlack(env, slack), fix: SLACK_FIX },
  ] satisfies ReadonlyArray<
    ConnectionProbe<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner,
      Error | PlatformError.PlatformError
    >
  >;

export const connectionsOnMachine = (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
) => readConnections(connectionProbes(env, run));

export const connectionOnMachine = (env: PluginEnv, id: ConnectionId, slack = slackApi) =>
  readConnections(connectionProbes(env, shell, slack).filter((probe) => probe.id === id)).pipe(
    Effect.map(
      (read) =>
        read[0]?.reading ?? {
          state: "absent" as const,
          detail: `${id} has no probe on this host`,
          fix: "upgrade Collie on this Machine",
        },
    ),
  );
