import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import manifest from "../../herdr-plugin.toml";
import { attempt, say } from "../envelope";
import { onboard as onboardMachine, type OnboardEvent, type StepStatus } from "../onboard";
import { context, gitlabHostFlag, root, stdinText, withGitlabHost } from "./shared";

const EventJson = Schema.fromJsonString(Schema.Unknown);

const MARK = {
  done: "✓",
  in_place: "✓",
  skipped: "–",
  needs_human: "…",
  needs_root: "✗",
  failed: "✗",
} satisfies Record<StepStatus, string>;

/** `KEY=value` lines; anything else is ignored. */
const secretLines = (text: string) =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const entry = /^\s*([A-Z_][A-Z0-9_]*)=(.*?)\s*$/.exec(line);
      return entry ? [[entry[1]!, entry[2]!] as const] : [];
    }),
  );

/** One event as a terminal shows it. */
export function eventText(event: OnboardEvent): string {
  if (event.event === "start") return `→ ${event.title}`;
  if (event.event === "human") return `  … ${event.detail}\n    open: ${event.url}`;
  return [
    `  ${MARK[event.status]} ${event.detail}`,
    ...(event.url ? [`    open: ${event.url}`] : []),
    ...(event.command ? [`    run: ${event.command}`] : []),
  ].join("\n");
}

export const onboard = Command.make(
  "onboard",
  {
    to: Flag.String("to").pipe(
      Flag.withDescription("The Collie release to install; this runner's own version if not given"),
      Flag.optional,
    ),
    skip: Flag.Literals("skip", ["helle", "linear"]).pipe(
      Flag.withDescription("A default step this Machine goes without, repeatable"),
      Flag.atLeast(0),
    ),
    secretsStdin: Flag.Boolean("secrets-stdin").pipe(
      Flag.withDescription(
        "Read GITLAB_TOKEN=, HELLE_API_URL= and HELLE_API_TOKEN= lines from stdin",
      ),
      Flag.withDefault(false),
    ),
    gitlabHost: gitlabHostFlag,
  },
  ({ to, skip, secretsStdin, gitlabHost }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          const env = withGitlabHost(resolved.env, gitlabHost);
          if ("ok" in env) return env;
          const secrets = secretsStdin ? secretLines(yield* stdinText) : {};
          return yield* onboardMachine(
            env,
            {
              to: Option.getOrElse(to, () => manifest.version),
              skip,
              secrets,
              terminal: !global.json && !secretsStdin && process.stdin.isTTY,
            },
            (event) =>
              say(global.json ? Schema.encodeSync(EventJson)(event) : eventText(event)).pipe(
                Effect.orDie,
              ),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "Make this Machine a working Collie host: install what is missing, then check it with doctor",
  ),
  Command.withExamples([
    {
      command: "collie onboard",
      description: "Install or repair everything; a re-run does only what is missing",
    },
    {
      command: "collie onboard --secrets-stdin --skip helle < secrets.env",
      description: "Log in to GitLab with the token in secrets.env, and go without Helle",
    },
    {
      command: "collie --json onboard --to 0.27.0",
      description: "The same steps as one JSON line each, then the envelope",
    },
  ]),
);
