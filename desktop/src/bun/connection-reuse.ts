import { Cause, Effect } from "effect";
import type { ConnectionLogin } from "../../../src/connection-model";
import { GITHUB_WEB_LOGIN, type Keyring } from "./credentials";
import { type MachineConnections, workflowConnections } from "../shared/connections";
import type { Door, ShellRoute } from "./machine";
import { redact } from "../../../src/redact";

export const connectionsOn = (
  machine: { readonly profile: string; readonly name: string },
  door: Pick<Door, "connections" | "definitions">,
): Effect.Effect<MachineConnections> =>
  Effect.gen(function* () {
    const connections = yield* door.connections();
    const workflows = yield* door
      .definitions()
      .pipe(
        Effect.map((read) => [
          ...workflowConnections(read.workflows),
          ...(read.connectionUses ?? []),
        ]),
      );
    return { ...machine, connections, workflows, problem: null };
  }).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.die("The Machine did not answer"),
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed({
            ...machine,
            connections: [],
            workflows: [],
            problem: redact(Cause.pretty(cause)),
          }),
    ),
  );

export const githubLogin = (
  route: ShellRoute,
  open: (command: ReadonlyArray<string>) => Effect.Effect<boolean>,
) =>
  Effect.flatMap(route.sh(GITHUB_WEB_LOGIN), (command) =>
    open(command).pipe(
      Effect.flatMap((opened) =>
        opened
          ? Effect.succeed(`Finish GitHub's login for ${route.machine.name} in the terminal`)
          : Effect.fail(
              "No terminal could be opened; run gh auth login --hostname github.com --web on this Machine",
            ),
      ),
    ),
  );

export const reuseGitlab = <R, E, RHost>(
  read: Effect.Effect<ConnectionLogin, E, R>,
  host: (login: ConnectionLogin) => Effect.Effect<void, string, RHost>,
  keyring: Keyring,
  give: (
    token: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly failed: string | null }>>,
) =>
  Effect.gen(function* () {
    const login = yield* read;
    yield* host(login);
    yield* keyring.store("gitlab-token", `Collie's GitLab token for ${login.host}`, login.token);
    return yield* give(login.token);
  });
