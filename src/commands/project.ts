import * as Arr from "effect/Array";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { hostProjects } from "../lifecycle";
import { actAsked } from "../lifecycle";
import { isArchived, isStarred } from "../project";
import type { ProjectRecord } from "../project";
import { err } from "../operations";
import { answering, cliDoor, mutating, requestIdFlag } from "./shared";
const line = (project: ProjectRecord) =>
  `${project.id}\t${project.name}${isStarred(project) ? "\tstarred" : ""}${
    isArchived(project) ? "\tarchived" : ""
  }`;
const list = Command.make("list", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const projects = yield* hostProjects(env);
      const data = Arr.map(projects, (project) => ({
        ...project,
        starred: isStarred(project),
        archived: isArchived(project),
      }));
      return {
        ok: true,
        data: { projects: data },
        human: Arr.join(Arr.map(data, line), "\n") || "No Projects yet.",
      };
    }),
  ),
).pipe(
  Command.withDescription("Every Project this Machine owns, and whether it is starred or archived"),
);
const nameFlag = Flag.String("name").pipe(Flag.withDescription("What the sidebar calls it"));
const create = Command.make(
  "create",
  { name: nameFlag, requestId: requestIdFlag },
  ({ name, requestId }) =>
    mutating({ operation: "project_create", run: null, args: { name } }, requestId, (env, id) =>
      Effect.gen(function* () {
        const [done] = yield* actAsked(env, {
          door: yield* cliDoor(env),
          actions: [{ kind: "project_create" as const, name }],
          request: id,
        });
        if (done === undefined || done.state !== "applied" || done.project === undefined) {
          return err("operation_failed", done?.note || "The host did not create a Project.");
        }
        return {
          ok: true as const,
          data: { project: done.project },
          human: `Created ${done.note}`,
        };
      }),
    ),
).pipe(Command.withDescription("Create a Project this Machine owns"));
const change = (
  name: string,
  kind: "project_star" | "project_unstar" | "project_archive" | "project_restore",
  said: string,
  title: string,
) =>
  Command.make(
    name,
    {
      project: Flag.String("project").pipe(Flag.withDescription("The Project's id")),
      requestId: requestIdFlag,
    },
    ({ project, requestId }) =>
      mutating({ operation: kind, run: null, args: { project } }, requestId, (env, id) =>
        Effect.gen(function* () {
          const [done] = yield* actAsked(env, {
            door: yield* cliDoor(env),
            actions: [{ kind, project }],
            request: id,
          });
          if (done === undefined || done.state !== "applied") {
            return err("operation_failed", done?.note || `The host did not ${said} it.`);
          }
          return { ok: true as const, data: { project }, human: done.note };
        }),
      ),
  ).pipe(Command.withDescription(`${title} a Project`));
export const project = Command.make("project").pipe(
  Command.withDescription("The Projects this Machine owns"),
  Command.withSubcommands([
    list,
    create,
    change("star", "project_star", "star", "Star"),
    change("unstar", "project_unstar", "unstar", "Unstar"),
    change("archive", "project_archive", "archive", "Archive"),
    change("restore", "project_restore", "restore", "Restore"),
  ]),
);
