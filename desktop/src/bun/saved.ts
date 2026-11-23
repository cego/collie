import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Effect, FileSystem, Schema, Semaphore, Stream } from "effect";
import {
  applyItem,
  EMPTY_FLOCK,
  MachineOnboarding,
  MachineSaved,
  MachineOwnRead,
} from "../shared/flock";
import type { FlockItem, FlockMachine } from "../shared/flock";

const SavedFile = Schema.fromJsonString(MachineSaved);
const OnboardingFile = Schema.fromJsonString(MachineOnboarding);
const OwnFile = Schema.fromJsonString(MachineOwnRead);
const fileOf = (dir: string, key: string) => `${dir}/${encodeURIComponent(key)}.json`;
const SAVE_EVERY = "1 second";
// WARNING: one board save or removal at a time, so a removal never runs under a save in flight.
const boardFiles = Semaphore.makeUnsafe(1);

const savedIn = <A>(dir: string, file: Schema.Codec<A, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const read = yield* Effect.forEach(
      Arr.filter(names, (name) => pipe_(name, Str.endsWith(".json"))),
      (name) =>
        fs
          .readFileString(`${dir}/${name}`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(file)), Effect.option),
    );
    return Arr.flatMap(read, (saved) => (saved._tag === "Some" ? [saved.value] : []));
  });

export const savedBoards = (dir: string) => savedIn(dir, SavedFile);

export const savedOwn = (dir: string) => savedIn(dir, OwnFile);

export const saveOwn = (dir: string, read: MachineOwnRead) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    const file = fileOf(dir, read.machine.profile);
    yield* fs.writeFileString(
      `${file}.new`,
      yield* Schema.encodeEffect(OwnFile)(read).pipe(Effect.orDie),
    );
    yield* fs.rename(`${file}.new`, file);
  }).pipe(Effect.ignore);

export const savedOnboardings = (dir: string) => savedIn(dir, OnboardingFile);

export const saveOnboarding = (dir: string, onboarding: MachineOnboarding) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      fileOf(dir, onboarding.machine.profile),
      yield* Schema.encodeEffect(OnboardingFile)(onboarding).pipe(Effect.orDie),
    );
  }).pipe(Effect.ignore);

const dropSaved = (dir: string, key: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(fileOf(dir, key), { force: true })).pipe(
    Effect.ignore,
  );

export const dropOnboarding = dropSaved;
export const dropOwn = dropSaved;

export const dropBoardsOf = (dir: string, profile: string) =>
  Effect.flatMap(savedBoards(dir), (saved) =>
    Effect.forEach(
      Arr.filter(saved, ({ machine }) => machine.profile === profile),
      ({ machine }) => dropSaved(dir, machine.installation),
      { discard: true },
    ),
  ).pipe(boardFiles.withPermits(1));

export const saving =
  (dir: string) =>
  <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
      let flock = EMPTY_FLOCK;
      const save = ({ machine, herds, tasks, asOf, build, development }: FlockMachine) =>
        Effect.gen(function* () {
          if (!flock.machines.has(machine.installation)) {
            return;
          }
          const at = asOf ?? (yield* Clock.currentTimeMillis);
          const file = fileOf(dir, machine.installation);
          const saved = {
            _tag: "Saved" as const,
            machine,
            herds,
            tasks: [...tasks.values()],
            build,
            development,
            at,
          };
          yield* fs.writeFileString(
            `${file}.new`,
            yield* Schema.encodeEffect(SavedFile)(saved).pipe(Effect.orDie),
          );
          yield* fs.rename(`${file}.new`, file);
        }).pipe(Effect.ignore, boardFiles.withPermits(1));
      const due = new Map<string, FlockMachine>();
      const flush = Effect.suspend(() => {
        const machines = [...due.values()];
        due.clear();
        return Effect.forEach(machines, save, { discard: true });
      });
      yield* flush.pipe(Effect.delay(SAVE_EVERY), Effect.forever, Effect.forkScoped);
      yield* Effect.addFinalizer(() => flush);
      return items.pipe(
        Stream.tap((item) =>
          Effect.suspend(() => {
            const before = flock.machines;
            flock = applyItem(flock, item);
            if ("_tag" in item && item._tag === "Saved") {
              return Effect.void;
            }
            for (const [installation, now] of flock.machines) {
              if (before.get(installation) !== now) {
                due.set(installation, now);
              }
            }
            const dropped = Arr.filter([...before.keys()], (one) => !flock.machines.has(one));
            return Effect.forEach(
              dropped,
              (installation) => (
                due.delete(installation),
                dropSaved(dir, installation).pipe(boardFiles.withPermits(1))
              ),
              { discard: true },
            );
          }),
        ),
      );
    }).pipe(Stream.unwrap);
