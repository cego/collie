import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import manifest from "../../herdr-plugin.toml";
import { attempt, say } from "../envelope";
import { onboard as onboardMachine, type OnboardEvent, type StepStatus } from "../onboard";
import { context, root } from "./shared";

const EventJson = Schema.fromJsonString(Schema.Unknown);

const MARK = {
  done: "✓",
  in_place: "✓",
  skipped: "–",
  needs_human: "…",
  needs_root: "✗",
  failed: "✗",
} satisfies Record<StepStatus, string>;

/** One event as a terminal shows it. */
function eventText(event: OnboardEvent): string {
  if (event.event === "start") return `→ ${event.title}`;
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
  },
  ({ to }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          return yield* onboardMachine(
            resolved.env,
            { to: Option.getOrElse(to, () => manifest.version) },
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
      command: "collie --json onboard --to 0.27.0",
      description: "The same steps as one JSON line each, then the envelope",
    },
  ]),
);
