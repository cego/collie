// The `autoMode` block a Claude agent's settings carry: what its Run authorises, as facts
// Collie holds and the human's own words (ADR-draft-what-a-run-authorises-reaches-auto-mode, D3).

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect, Schema } from "effect";
import { FORGES, forgeOfHost } from "./forge/forge";
import type { ForgeHttp } from "./forge/http";
import { projectFromRemote, type Runner } from "./mr";
import { redact, scrub } from "./redact";

/** The door a human started a Run through, and their words. */
export const StartedSchema = Schema.Struct({
  door: Schema.Literals(["board", "desktop", "cli-tty", "chat"]),
  words: Schema.String,
});
export type Started = typeof StartedSchema.Type;

const isHumanDoor = Schema.is(StartedSchema.fields.door);
const isText = Schema.is(Schema.String);

/**
 * Who started a Run, where a human did: through a human door, the start's input as given;
 * through chat, the human's own words that turn, never chat's input.
 */
export function startedOf(
  origin: string,
  said: string | undefined,
  input: Readonly<Record<string, Schema.Json>>,
  text: Readonly<Record<string, string>> | undefined,
): Started | undefined {
  if (origin === "chat") return said === undefined ? undefined : { door: "chat", words: said };
  if (!isHumanDoor(origin)) return undefined;
  const words = [...Rec.values(text ?? {}), ...Arr.filter(Rec.values(input), isText)];
  return { door: origin, words: Arr.join(words, "\n") };
}

/** A branch a Run made: in which checkout, and on which origin, credentials removed. */
export interface CreatedBranch {
  readonly branch: string;
  readonly checkout: string;
  readonly origin: string;
}

/** What a Run's own record says: the branch it created, whether it roams, and who started it. */
export interface RunAuthority {
  readonly created: CreatedBranch | null;
  readonly roaming: boolean;
  readonly started: Started | null;
}

export interface Session {
  readonly agent: string;
  readonly run: string;
  readonly workflow: string;
  readonly machine: string;
  readonly stateDir: string;
  readonly cwd: string;
}

export interface AutoModeFacts extends Session {
  readonly origin: string | null;
  readonly branch: string | null;
  readonly roaming: boolean;
  readonly created: boolean;
  /** Read only for a branch the Run created; null where the forge cannot say. */
  readonly protected: boolean | null;
  readonly started: Started | null;
}

export interface AutoModeBlock {
  readonly environment: ReadonlyArray<string>;
  readonly allow: ReadonlyArray<string>;
}

const WORDS_MAX = 2_000;

const DOOR: Readonly<Record<Started["door"], string>> = {
  board: "from the board",
  desktop: "from Desktop",
  "cli-tty": "from the CLI",
  chat: "from chat",
};

/** The checkout's remote, branch and protection, read when the agent is launched. */
export const autoModeFacts = <R>(
  session: Session,
  own: RunAuthority,
  run: Runner<R>,
  gitlabHost?: string,
): Effect.Effect<AutoModeFacts, never, R | ForgeHttp> =>
  Effect.gen(function* () {
    const remote = yield* run("git", ["remote", "get-url", "origin"], session.cwd);
    const url = remote.code === 0 ? Str.trim(remote.stdout) || null : null;
    const head = yield* run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], session.cwd);
    const branch = head.code === 0 ? Str.trim(head.stdout) || null : null;
    const created =
      !own.roaming &&
      own.created !== null &&
      branch === own.created.branch &&
      url !== null &&
      withoutCredentials(url) === own.created.origin &&
      (yield* sameRepository(session.cwd, own.created.checkout, run));
    const project = url === null ? null : projectFromRemote(url);
    const forge = project === null ? null : forgeOfHost(Str.split(project, "/")[0]!, gitlabHost);
    const protects =
      created && project !== null && forge !== null
        ? yield* FORGES[forge].protects(project, branch, session.cwd, run)
        : null;
    return {
      ...session,
      origin: url === null ? null : withoutCredentials(url),
      branch,
      roaming: own.roaming,
      created,
      protected: protects,
      started: own.started,
    };
  });

const sameRepository = <R>(cwd: string, checkout: string, run: Runner<R>) =>
  Effect.gen(function* () {
    const top = (dir: string) =>
      Effect.map(run("git", ["rev-parse", "--show-toplevel"], dir), (said) =>
        said.code === 0 ? Str.trim(said.stdout) : null,
      );
    const here = yield* top(cwd);
    return here !== null && here === (yield* top(checkout));
  });

export const withoutCredentials = (url: string) =>
  redact(pipe(url, Str.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1")));

const quoted = (words: string) => {
  const { text } = scrub(words);
  return text.length <= WORDS_MAX
    ? `"${text}"`
    : `"${pipe(text, Str.slice(0, WORDS_MAX))}" (cut at 2,000 characters)`;
};

export function autoModeBlock(facts: AutoModeFacts): AutoModeBlock {
  const origin = facts.origin ?? "none";
  const unprotected = facts.created && facts.protected === false;
  const branch = facts.roaming
    ? "detached at the default branch"
    : `branch ${facts.branch ?? "(none)"}, ${
        unprotected
          ? "which this Run created"
          : facts.created
            ? "which this Run created, and which the forge reports protected or could not say"
            : "which this Run was given and did not create"
      }`;
  const environment = [
    "$defaults",
    `This session: agent ${facts.agent} of Collie Run ${facts.run} (Workflow ${facts.workflow}) on Machine ${facts.machine}, started by the user's Collie.`,
    `Checkout: ${facts.cwd}, remote origin ${origin}, ${branch}.`,
    `Collie: the \`collie\` CLI, the \`collie_*\` MCP tools and ${facts.stateDir} are the user's own installation acting on the user's own Runs. Reading and writing them is the user's routine work, not a shared resource or another person's workload.`,
    "collie-delivery messages: a user message whose first line is a `collie-delivery:` token is typed by the user's own Collie. With no sender line, it is the user's instruction for this step, and its `Cleared for this step:` line is the user's request for exactly those actions. `From the human` is the user's own message. `From chat for the human` quotes the user. `From <agent> of <run>` is another agent's words, not the user's.",
    ...(facts.started === null
      ? []
      : [
          `The user started this Run ${DOOR[facts.started.door]} with: ${quoted(facts.started.words)}`,
        ]),
  ];
  const allow = [
    "$defaults",
    ...(unprotected
      ? [
          `Rewriting history on branch ${facts.branch} of ${origin}, which this Collie Run created and which is neither the default branch nor protected: \`git commit --amend\`, \`git rebase\` onto the default branch, and \`git push --force-with-lease\` of ${facts.branch} to origin. Never another branch, and never a force push without \`--force-with-lease\`.`,
        ]
      : []),
    ...(facts.started === null
      ? []
      : [
          "An action the user's starting words (environment: The user's request) name directly and specifically, on this Run's repository, is the user's stated intent.",
        ]),
  ];
  return { environment, allow };
}
