import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
  Result,
  flow,
} from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { nowIso } from "./time";
export const PROJECTS = "collie/projects";
// WARNING: a Task's membership is qualified, because two installations' Project ids may collide.
export const ProjectRef = Schema.Struct({
  installation: Schema.String,
  id: Schema.String,
});
export type ProjectRef = typeof ProjectRef.Type;
export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created_at: Schema.String,
  starred_at: Schema.optionalKey(Schema.String),
  archived_at: Schema.optionalKey(Schema.String),
});
export type ProjectRecord = Schema.Schema.Type<typeof ProjectSchema>;
const ProjectJson = Schema.fromJsonString(ProjectSchema);
const encodeProject = flow(Schema.encodeResult(ProjectJson), Result.getOrThrow);
export const decodeProjectOption = Schema.decodeOption(ProjectJson);
export interface ProjectsApi {
  readonly get: (id: string) => Effect.Effect<ProjectRecord | null>;
  readonly list: Effect.Effect<ReadonlyArray<ProjectRecord>>;
  readonly put: (project: ProjectRecord) => Effect.Effect<ProjectRecord>;
  // WARNING: held from reading a Project to writing it back, so a star and an archive cannot lose each other.
  readonly locked: <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
export class Projects extends Context.Service<Projects, ProjectsApi>()("collie/Projects") {}
const decoded = (rows: ReadonlyArray<{ readonly record: string }>) =>
  Arr.flatMap(rows, (row) => Option.toArray(decodeProjectOption(row.record)));
export const projectsLayer = Layer.effect(Projects)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (id: string) => {
      const lock = locks.get(id) ?? Semaphore.makeUnsafe(1);
      locks.set(id, lock);
      return lock;
    };
    return {
      get: (id) =>
        sql<{ readonly record: string }>`SELECT record FROM collie_projects WHERE id = ${id}`.pipe(
          Effect.map((rows) => decoded(rows)[0] ?? null),
          Effect.orDie,
        ),
      list: sql<{ readonly record: string }>`
        SELECT record FROM collie_projects ORDER BY created_at DESC
      `.pipe(Effect.map(decoded), Effect.orDie),
      put: (project) =>
        sql`
          INSERT INTO collie_projects (id, record) VALUES (${project.id}, ${encodeProject(project)})
          ON CONFLICT (id) DO UPDATE SET record = excluded.record
        `.pipe(Effect.andThen(reactivity.invalidate([PROJECTS])), Effect.as(project), Effect.orDie),
      locked: (id, effect) => Effect.suspend(() => lockOf(id).withPermits(1)(effect)),
    } satisfies ProjectsApi;
  }),
);
export const readProject = (id: string) => Projects.use((projects) => projects.get(id));
export const listProjects = Projects.use((projects) => projects.list);
export const writeProject = (project: ProjectRecord) =>
  Projects.use((projects) => projects.put(project));
export const withProjectLock = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
  Projects.use((projects) => projects.locked(id, effect));
export const isStarred = (project: ProjectRecord) => project.starred_at !== undefined;
export const isArchived = (project: ProjectRecord) => project.archived_at !== undefined;
export const newProject = Effect.fn("project.newProject")(function* (opts: {
  readonly name: string;
}) {
  return {
    id: `project-${pipe_(yield* (yield* SecureRandom.SecureRandom).uuidV4(), Str.slice(0, 8))}`,
    name: opts.name,
    created_at: yield* nowIso,
  } satisfies ProjectRecord;
});
export const hostInstallation = Effect.fn("project.hostInstallation")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const known = Str.trim(
    yield* fs.readFileString(`${stateDir}/installation`).pipe(Effect.orElseSucceed(() => "")),
  );
  return known === "" ? null : known;
});
