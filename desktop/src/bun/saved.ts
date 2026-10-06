// Each Machine's last board, saved on this computer so the next launch can show it until
// the Machine is live again, and each route's latest onboarding.

import { Clock, Effect, FileSystem, Schema, Stream } from "effect";
import {
  applyItem,
  EMPTY_FLOCK,
  type FlockItem,
  type FlockMachine,
  MachineOnboarding,
  MachineSaved,
} from "../shared/flock";

const SavedFile = Schema.fromJsonString(MachineSaved);
const OnboardingFile = Schema.fromJsonString(MachineOnboarding);
const fileOf = (dir: string, key: string) => `${dir}/${encodeURIComponent(key)}.json`;

/** Every file in `dir` that `file` decodes; one that cannot be read is left out. */
const savedIn = <A>(dir: string, file: Schema.Codec<A, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const read = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json")),
      (name) =>
        fs
          .readFileString(`${dir}/${name}`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(file)), Effect.option),
    );
    return read.flatMap((saved) => (saved._tag === "Some" ? [saved.value] : []));
  });

/** Every board saved in `dir`. */
export const savedBoards = (dir: string) => savedIn(dir, SavedFile);

/** The latest onboarding of each route saved in `dir`. */
export const savedOnboardings = (dir: string) => savedIn(dir, OnboardingFile);

/** Keeps an onboarding that ended, as the latest of its route. */
export const saveOnboarding = (dir: string, onboarding: MachineOnboarding) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      fileOf(dir, onboarding.machine.profile),
      Schema.encodeSync(OnboardingFile)(onboarding),
    );
  }).pipe(Effect.ignore);

const dropSaved = (dir: string, key: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(fileOf(dir, key), { force: true })).pipe(
    Effect.ignore,
  );

export const dropOnboarding = dropSaved;

/** Drops every board in `dir` saved through `profile`. */
export const dropBoardsOf = (dir: string, profile: string) =>
  Effect.flatMap(savedBoards(dir), (saved) =>
    Effect.forEach(
      saved.filter(({ machine }) => machine.profile === profile),
      ({ machine }) => dropSaved(dir, machine.installation),
      { discard: true },
    ),
  );

/** Saves each Machine whenever what Desktop knows of it changes, as of when it was live. */
export const saving =
  (dir: string) =>
  <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
      let flock = EMPTY_FLOCK;
      const save = ({ machine, herds, tasks, asOf, development }: FlockMachine) =>
        Effect.gen(function* () {
          const at = asOf ?? (yield* Clock.currentTimeMillis);
          const file = fileOf(dir, machine.installation);
          const saved = {
            _tag: "Saved" as const,
            machine,
            herds,
            tasks: [...tasks.values()],
            development,
            at,
          };
          yield* fs.writeFileString(`${file}.new`, Schema.encodeSync(SavedFile)(saved));
          yield* fs.rename(`${file}.new`, file);
        }).pipe(Effect.ignore);
      return items.pipe(
        Stream.tap((item) =>
          Effect.suspend(() => {
            const before = flock.machines;
            flock = applyItem(flock, item);
            if ("_tag" in item && item._tag === "Saved") return Effect.void;
            // A Machine removed from the flock is not shown at the next launch either.
            const dropped = [...before.keys()].filter((one) => !flock.machines.has(one));
            // ponytail: written on every change; debounce if a busy board makes that show.
            return Effect.forEach(
              [...flock.machines].filter(([installation, now]) => before.get(installation) !== now),
              ([, now]) => save(now),
              { discard: true },
            ).pipe(
              Effect.andThen(
                Effect.forEach(dropped, (installation) => dropSaved(dir, installation), {
                  discard: true,
                }),
              ),
            );
          }),
        ),
      );
    }).pipe(Stream.unwrap);
