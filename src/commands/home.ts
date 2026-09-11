// What Collie thinks its Home is, and the two things a human can tell it about that.
//
// `show` is the whole of the ownership question in one place: what was recorded, what
// herdr has now, and which proof — if any — makes the first still true of the second.
// When there is none, `reconcile` is how a person settles it, because Collie will not.

import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { Herdr } from "../herdr";
import { err } from "../operations";
import {
  HOME_TOKEN,
  TOKEN_TTL_MS,
  archived,
  closable,
  decide,
  homePath,
  missingRuntime,
  readHome,
  UNREADABLE,
  writeHome,
} from "../home";
import { herdOf } from "../steering";
import { nowIso } from "../time";
import { mutation } from "../envelope";
import { answering, requestIdFlag } from "./shared";

const show = Command.make("show", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const herdr = new Herdr(env);
      const key = yield* herdOf(env.socketPath);
      const record = yield* readHome(yield* homePath(env.stateDir, key));
      const workspaces = yield* herdr.workspaceList().pipe(Effect.catch(() => Effect.succeed([])));
      const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
      const decision = decide(record, workspaces, panes, key);
      const schema = yield* herdr.apiSchema().pipe(Effect.catch(() => Effect.succeed("")));
      const missing = schema === "" ? ["herdr could not be asked"] : missingRuntime(schema);

      return {
        ok: true,
        data: { herd: key, record, decision, missing },
        human: [
          `herd\t${key}`,
          record === null
            ? "record\tnone"
            : record === UNREADABLE
              ? "record\tunreadable"
              : `record\t${record.workspaceId}\t${record.state}`,
          `ownership\t${decision.kind}${decision.kind === "ownership_unknown" ? `\t${decision.why}` : ""}`,
          ...(decision.kind === "ownership_unknown"
            ? decision.candidates.map((id) => `candidate\t${id}`)
            : []),
          missing.length === 0
            ? "herdr\thas everything the Home needs"
            : `herdr\tmissing ${missing.join(", ")}`,
        ].join("\n"),
      };
    }),
  ),
).pipe(Command.withDescription("What Collie thinks this Herd's Home is, and what proves it"));

/**
 * The human settling an ownership question Collie refused to settle for them. `--adopt`
 * says "that one is mine": the token is written, which makes the proof true rather than
 * assumed. `--forget` archives the record, so the next ensure starts clean.
 */
const reconcile = Command.make(
  "reconcile",
  {
    adopt: Flag.string("adopt").pipe(
      Flag.withDescription("The workspace that is this Herd's Home, as `home show` lists it"),
      Flag.optional,
    ),
    forget: Flag.boolean("forget").pipe(
      Flag.withDescription("Archive the record; the next launch decides again from nothing"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({ adopt, forget, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        const chosen = adopt._tag === "Some" ? adopt.value : null;
        if (chosen === null && !forget)
          return err("invalid_input", "Pass --adopt <workspace-id> or --forget.");
        return yield* mutation(env, "home-reconcile", requestId, () =>
          Effect.gen(function* () {
            const key = yield* herdOf(env.socketPath);
            const file = yield* homePath(env.stateDir, key);
            const record = yield* readHome(file);
            const at = yield* nowIso();
            if (chosen === null) {
              if (record === null)
                return err("invalid_state", "There is no Home record to forget.");
              // An unreadable record has nothing to archive: forgetting it is the escape
              // hatch from a corrupt file, and keeping half of one would not be keeping it.
              const previous =
                record === UNREADABLE ? [] : [...record.previous, archived(record, at)];
              yield* writeHome(file, {
                workspaceId: "",
                paneId: null,
                tabId: null,
                terminalId: null,
                createdAt: at,
                token: key,
                state: "creating",
                previous,
              });
              const forgot = record === UNREADABLE ? "an unreadable record" : record.workspaceId;
              return {
                ok: true as const,
                data: { forgot },
                human: `Forgot ${forgot}; the next launch decides again.`,
              };
            }
            // Writing the token is what makes the proof true rather than assumed: the
            // human said this workspace is the Home, so it now says so itself.
            yield* new Herdr(env)
              .workspaceReportMetadata(chosen, { [HOME_TOKEN]: key }, TOKEN_TTL_MS)
              .pipe(Effect.catch(() => Effect.void));
            yield* writeHome(file, {
              workspaceId: chosen,
              tabId: null,
              paneId: null,
              terminalId: null,
              createdAt: at,
              token: key,
              state: "creating",
              previous:
                record === null || record === UNREADABLE
                  ? []
                  : [...record.previous, archived(record, at)],
            });
            return {
              ok: true as const,
              data: { adopted: chosen },
              human: `Adopted ${chosen} as this Herd's Home.`,
            };
          }),
        );
      }),
    ),
).pipe(Command.withDescription("Settle which workspace is this Herd's Home"));

/**
 * Close the per-workspace Collie panes a previous release left behind — and only those:
 * a legacy pane sharing a tab with something else is listed, never closed. Taking
 * somebody's window away is not cleanup.
 */
const cleanup = Command.make(
  "cleanup",
  {
    confirm: Flag.boolean("confirm").pipe(
      Flag.withDescription("Actually close them; without it this only lists what it would"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({ confirm, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        const herdr = new Herdr(env);
        const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
        const { close, listed } = closable(panes);
        const human = [
          ...close.map((id) => `${confirm ? "closed" : "would close"}\t${id}`),
          ...listed.map((id) => `left\t${id}\tshares its tab with something else`),
        ].join("\n");
        if (!confirm)
          return {
            ok: true as const,
            data: { close, listed },
            human: human || "Nothing to clean up.",
          };
        return yield* mutation(env, "home-cleanup", requestId, () =>
          Effect.gen(function* () {
            for (const paneId of close)
              yield* herdr.paneClose(paneId).pipe(Effect.catch(() => Effect.void));
            return { ok: true as const, data: { closed: close, listed }, human };
          }),
        );
      }),
    ),
).pipe(Command.withDescription("Close the per-workspace Collie panes an older release left"));

export const home = Command.make("home").pipe(
  Command.withDescription("The Herd's Home: which workspace it is, and what proves it"),
  Command.withSubcommands([show, reconcile, cleanup]),
);
