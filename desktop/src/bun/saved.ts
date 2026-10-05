// Each Machine's last board, saved on this computer so the next launch can show it until
// the Machine is live again.

import { Clock, Effect, FileSystem, Schema, Stream } from "effect";
import {
  applyItem,
  EMPTY_FLOCK,
  type FlockItem,
  type FlockMachine,
  MachineSaved,
} from "../shared/flock";

const SavedFile = Schema.fromJsonString(MachineSaved);
const fileOf = (dir: string, installation: string) =>
  `${dir}/${encodeURIComponent(installation)}.json`;

/** Every board saved in `dir`; one that cannot be read is left out. */
export const savedBoards = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const read = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json")),
      (name) =>
        fs
          .readFileString(`${dir}/${name}`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SavedFile)), Effect.option),
    );
    return read.flatMap((saved) => (saved._tag === "Some" ? [saved.value] : []));
  });

/** Saves each Machine whenever what Desktop knows of it changes, as of when it was live. */
export const saving =
  (dir: string) =>
  <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
      let flock = EMPTY_FLOCK;
      const save = ({ machine, herds, tasks, asOf }: FlockMachine) =>
        Effect.gen(function* () {
          const at = asOf ?? (yield* Clock.currentTimeMillis);
          const file = fileOf(dir, machine.installation);
          const saved = { _tag: "Saved" as const, machine, herds, tasks: [...tasks.values()], at };
          yield* fs.writeFileString(`${file}.new`, Schema.encodeSync(SavedFile)(saved));
          yield* fs.rename(`${file}.new`, file);
        }).pipe(Effect.ignore);
      return items.pipe(
        Stream.tap((item) =>
          Effect.suspend(() => {
            const before = flock.machines;
            flock = applyItem(flock, item);
            if ("_tag" in item && item._tag === "Saved") return Effect.void;
            // ponytail: written on every change; debounce if a busy board makes that show.
            return Effect.forEach(
              [...flock.machines].filter(([installation, now]) => before.get(installation) !== now),
              ([, now]) => save(now),
              { discard: true },
            );
          }),
        ),
      );
    }).pipe(Stream.unwrap);
