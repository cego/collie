// Which credentials Desktop gave each Machine, kept as fingerprints of what it gave and
// never the secrets, so a Machine that lacks the current one is given it when it connects.

import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import {
  CREDENTIALS,
  type Credential,
  type KnownMachine,
  type MachineGiven,
  type OnboardStep,
} from "../shared/flock";
import type { Keyring, KeyringEntry } from "./credentials";
import { sha256Hex } from "../../../src/attachments";
import type { ShellRoute } from "./machine";

const ENTRY = { gitlab: "gitlab-token", helle: "helle-token" } satisfies Record<
  Credential,
  KeyringEntry
>;

/** Each Machine's fingerprints, by herdr profile and then credential. */
const GivenFile = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
);
const FILE = "given.json";

export const fingerprint = (text: string) => sha256Hex(text).slice(0, 16);

/** Gives one Machine a credential's text, and answers why it failed, or null. */
export type Give = (route: ShellRoute, text: string) => Effect.Effect<string | null>;

export const givenCredentials = Effect.fn("Given.open")(function* (options: {
  readonly dir: string;
  readonly keyring: Keyring;
  readonly give: Record<Credential, Give>;
  readonly tell: (item: MachineGiven) => Effect.Effect<void>;
  /** The steps a Machine's saved onboarding skipped: their credentials aren't Desktop's to give it. */
  readonly skipped: (profile: string) => Effect.Effect<ReadonlyArray<string>>;
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
  /** What Desktop holds that is its to give `machine`. */
  const heldFor = (machine: KnownMachine) =>
    Effect.zipWith(held, options.skipped(machine.profile), (texts, skipped) =>
      CREDENTIALS.flatMap((credential) => {
        const text = texts[credential];
        return text === undefined || skipped.includes(credential)
          ? []
          : [[credential, text] as const];
      }),
    );
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
  /** One give at a time per Machine and credential, so the last given is the last recorded. */
  const giving = new Map<string, Semaphore.Semaphore>();
  const giveOne = (route: ShellRoute, credential: Credential, text: string) =>
    Effect.suspend(() => {
      const key = `${route.machine.profile} ${credential}`;
      const one = giving.get(key) ?? Semaphore.makeUnsafe(1);
      giving.set(key, one);
      return one.withPermits(1)(
        options.give[credential](route, text).pipe(
          Effect.tap((failed) => recorded(route.machine, credential, text, failed)),
        ),
      );
    });

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
      Effect.flatMap(heldFor(route.machine), (texts) =>
        Effect.forEach(
          texts.filter(([credential, text]) => !stateOf(route.machine, credential, text).given),
          ([credential, text]) =>
            giveOne(route, credential, text).pipe(Effect.map((failed) => ({ credential, failed }))),
        ),
      ),
    /** Counts as given what an onboarding that ended ready was handed and set up. */
    handed: (
      machine: KnownMachine,
      texts: Partial<Record<Credential, string>>,
      steps: ReadonlyArray<OnboardStep>,
    ) =>
      Effect.forEach(
        CREDENTIALS.flatMap((credential) => {
          const text = texts[credential];
          const set = steps.some(
            ({ step, status }) =>
              step === credential && (status === "done" || status === "in_place"),
          );
          return text === undefined || !set ? [] : [[credential, text] as const];
        }),
        ([credential, text]) => recorded(machine, credential, text, null),
        { discard: true },
      ),
    /** Each Machine's standing on every credential Desktop holds and is its to give. */
    states: (machines: ReadonlyArray<KnownMachine>) =>
      Effect.map(
        Effect.forEach(machines, (machine) =>
          Effect.map(heldFor(machine), (texts) =>
            texts.map(([credential, text]) => stateOf(machine, credential, text)),
          ),
        ),
        (each) => each.flat(),
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
