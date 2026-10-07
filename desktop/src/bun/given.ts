// Which credentials Desktop gave each Machine, kept as fingerprints of what it gave and
// never the secrets, so a Machine that lacks the current one is given it when it connects.

import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import type { Credential, KnownMachine, MachineGiven } from "../shared/flock";
import type { Keyring, KeyringEntry } from "./credentials";
import type { ShellRoute } from "./machine";

const ENTRY = { gitlab: "gitlab-token", helle: "helle-token" } satisfies Record<
  Credential,
  KeyringEntry
>;
const CREDENTIALS: ReadonlyArray<Credential> = ["gitlab", "helle"];

/** Each Machine's fingerprints, by herdr profile and then credential. */
const GivenFile = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
);
const FILE = "given.json";

export const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Gives one Machine a credential's text, and answers why it failed, or null. */
export type Give = (route: ShellRoute, text: string) => Effect.Effect<string | null>;

export const givenCredentials = Effect.fn("Given.open")(function* (options: {
  readonly dir: string;
  readonly keyring: Keyring;
  readonly give: Record<Credential, Give>;
  readonly tell: (item: MachineGiven) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const file = (yield* Path.Path).join(options.dir, FILE);
  let record = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(GivenFile)),
    Effect.orElseSucceed((): typeof GivenFile.Type => ({})),
  );
  /** Why the last give of a fingerprint failed, by profile and credential; this run's only. */
  const failures = new Map<string, { readonly print: string; readonly reason: string }>();
  const lock = yield* Semaphore.make(1);
  const save = fs.makeDirectory(options.dir, { recursive: true }).pipe(
    Effect.andThen(
      Effect.suspend(() => fs.writeFileString(`${file}.new`, Schema.encodeSync(GivenFile)(record))),
    ),
    Effect.andThen(fs.rename(`${file}.new`, file)),
    Effect.catch((error) => Effect.logWarning(`Could not save ${file}`, error)),
  );

  /** What Desktop holds now, by credential. */
  const held = Effect.gen(function* () {
    const texts: Partial<Record<Credential, string>> = {};
    for (const credential of CREDENTIALS) {
      const text = yield* options.keyring
        .lookup(ENTRY[credential])
        .pipe(Effect.orElseSucceed(() => null));
      if (text !== null) texts[credential] = text;
    }
    return texts;
  });
  const stateOf = (machine: KnownMachine, credential: Credential, text: string): MachineGiven => {
    const print = fingerprint(text);
    const given = record[machine.profile]?.[credential] === print;
    const failure = failures.get(`${machine.profile} ${credential}`);
    return {
      _tag: "Given",
      machine,
      credential,
      given,
      failed: !given && failure?.print === print ? failure.reason : null,
    };
  };
  const recorded = (
    machine: KnownMachine,
    credential: Credential,
    text: string,
    failed: string | null,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const key = `${machine.profile} ${credential}`;
        if (failed === null) {
          failures.delete(key);
          record = {
            ...record,
            [machine.profile]: { ...record[machine.profile], [credential]: fingerprint(text) },
          };
          yield* save;
        } else failures.set(key, { print: fingerprint(text), reason: failed });
        yield* options.tell(stateOf(machine, credential, text));
      }),
    );
  const giveOne = (route: ShellRoute, credential: Credential, text: string) =>
    options.give[credential](route, text).pipe(
      Effect.tap((failed) => recorded(route.machine, credential, text, failed)),
    );

  return {
    held,
    /** Gives `text` to every route, and says how each went. */
    giveEvery: (routes: ReadonlyArray<ShellRoute>, credential: Credential, text: string) =>
      Effect.forEach(
        routes,
        (route) =>
          giveOne(route, credential, text).pipe(
            Effect.map((failed) => ({ name: route.machine.name, failed })),
          ),
        { concurrency: "unbounded" },
      ),
    /** Gives the route each credential Desktop holds whose current one it was not given. */
    giveLacking: (route: ShellRoute) =>
      Effect.flatMap(held, (texts) =>
        Effect.forEach(
          CREDENTIALS.flatMap((credential) => {
            const text = texts[credential];
            return text === undefined || stateOf(route.machine, credential, text).given
              ? []
              : [[credential, text] as const];
          }),
          ([credential, text]) =>
            giveOne(route, credential, text).pipe(Effect.map((failed) => ({ credential, failed }))),
        ),
      ),
    /** Counts what an onboarding that ended ready was handed as given. */
    handed: (machine: KnownMachine, texts: Partial<Record<Credential, string>>) =>
      Effect.forEach(
        CREDENTIALS.flatMap((credential) => {
          const text = texts[credential];
          return text === undefined ? [] : [[credential, text] as const];
        }),
        ([credential, text]) => recorded(machine, credential, text, null),
        { discard: true },
      ),
    /** Each Machine's standing on every credential Desktop holds. */
    states: (machines: ReadonlyArray<KnownMachine>) =>
      Effect.map(held, (texts) =>
        machines.flatMap((machine) =>
          CREDENTIALS.flatMap((credential) => {
            const text = texts[credential];
            return text === undefined ? [] : [stateOf(machine, credential, text)];
          }),
        ),
      ),
    drop: (profile: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const { [profile]: _gone, ...kept } = record;
          record = kept;
          for (const credential of CREDENTIALS) failures.delete(`${profile} ${credential}`);
          yield* save;
        }),
      ),
  };
});

export type GivenCredentials = Effect.Success<ReturnType<typeof givenCredentials>>;
