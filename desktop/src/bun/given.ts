import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Effect, FileSystem, Path, Schema, SchemaGetter, Semaphore, flow, Result } from "effect";
import { CREDENTIALS } from "../shared/flock";
import type { Credential, KnownMachine, MachineGiven, OnboardStep } from "../shared/flock";
import type { Keyring, KeyringEntry } from "./credentials";
import { sha256Hex } from "../../../src/attachments";
import type { ShellRoute } from "./machine";

const ENTRY = {
  gitlab: "gitlab-token",
  helle: "helle-token",
  slack: "slack-user-grant",
} satisfies Record<Credential, KeyringEntry>;

const Fingerprints = Schema.Record(Schema.String, Schema.String);

const GivenFile = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Fingerprints.pipe(
      Schema.decodeTo(Fingerprints, {
        decode: SchemaGetter.transform(({ slack: _bot, "slack-user": signIn, ...rest }) =>
          signIn === undefined ? rest : { ...rest, slack: signIn },
        ),
        encode: SchemaGetter.transform(({ slack: signIn, ...rest }) =>
          signIn === undefined ? rest : { ...rest, "slack-user": signIn },
        ),
      }),
    ),
  ),
);
const FILE = "given.json";

export const fingerprint = (text: string) => pipe_(sha256Hex(text), Str.slice(0, 16));

export type Give = (route: ShellRoute, text: string) => Effect.Effect<string | null>;

export const givenCredentials = Effect.fn("Given.open")(function* (options: {
  readonly dir: string;
  readonly keyring: Keyring;
  readonly give: Record<Credential, Give>;
  readonly tell: (item: MachineGiven) => Effect.Effect<void>;
  readonly skipped: (profile: string) => Effect.Effect<ReadonlyArray<string>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const file = (yield* Path.Path).join(options.dir, FILE);
  let record = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(GivenFile)),
    Effect.orElseSucceed(() => {
      const returned: typeof GivenFile.Type = {};
      return returned;
    }),
  );
  const failures = new Map<string, { readonly print: string; readonly reason: string }>();
  const lock = yield* Semaphore.make(1);
  const save = fs.makeDirectory(options.dir, { recursive: true }).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        fs.writeFileString(
          `${file}.new`,
          flow(Schema.encodeResult(GivenFile), Result.getOrThrow)(record),
        ),
      ),
    ),
    Effect.andThen(fs.rename(`${file}.new`, file)),
    Effect.catch((error) => Effect.logWarning(`Could not save ${file}`, error)),
  );

  const current = (credential: Credential) =>
    options.keyring.lookup(ENTRY[credential]).pipe(Effect.orElseSucceed(() => null));
  const held = Effect.gen(function* () {
    const texts: Partial<Record<Credential, string>> = {};
    for (const credential of CREDENTIALS) {
      const text = yield* current(credential);
      if (text !== null) {
        texts[credential] = text;
      }
    }
    return texts;
  });
  const heldFor = (machine: KnownMachine) =>
    Effect.zipWith(held, options.skipped(machine.profile), (texts, skipped) =>
      Arr.flatMap(CREDENTIALS, (credential) => {
        const text = texts[credential];
        return text === undefined || skipped.includes(credential)
          ? []
          : [[credential, text] as const];
      }),
    );
  const stateOf: (machine: KnownMachine, credential: Credential, text: string) => MachineGiven = (
    machine,
    credential,
    text,
  ) => {
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
        } else {
          failures.set(key, { print: fingerprint(text), reason: failed });
        }
        yield* options.tell(stateOf(machine, credential, text));
      }),
    );
  // WARNING: one give at a time per Machine and credential, so the last given is the last recorded.
  const giving = new Map<string, Semaphore.Semaphore>();
  const giveOne = (route: ShellRoute, credential: Credential, text: Effect.Effect<string | null>) =>
    Effect.suspend(() => {
      const key = `${route.machine.profile} ${credential}`;
      const one = giving.get(key) ?? Semaphore.makeUnsafe(1);
      giving.set(key, one);
      return one.withPermits(1)(
        Effect.flatMap(text, (now) =>
          now === null
            ? Effect.succeed(null)
            : options.give[credential](route, now).pipe(
                Effect.tap((failed) => recorded(route.machine, credential, now, failed)),
              ),
        ),
      );
    });

  return {
    held,
    giveEvery: (routes: ReadonlyArray<ShellRoute>, credential: Credential, text: string) =>
      Effect.forEach(
        routes,
        (route) =>
          giveOne(route, credential, Effect.succeed(text)).pipe(
            Effect.map((failed) => ({ name: route.machine.name, failed })),
          ),
        { concurrency: "unbounded" },
      ),
    // WARNING: read again at its turn, so a give queued behind a newer one never undoes it.
    giveLacking: (route: ShellRoute) =>
      Effect.flatMap(heldFor(route.machine), (texts) =>
        Effect.forEach(
          Arr.filter(
            texts,
            ([credential, text]) => !stateOf(route.machine, credential, text).given,
          ),
          ([credential]) =>
            giveOne(
              route,
              credential,
              Effect.map(current(credential), (now) =>
                now === null || stateOf(route.machine, credential, now).given ? null : now,
              ),
            ).pipe(Effect.map((failed) => ({ credential, failed }))),
        ),
      ),
    handed: (
      machine: KnownMachine,
      texts: Partial<Record<Credential, string>>,
      steps: ReadonlyArray<OnboardStep>,
    ) =>
      Effect.forEach(
        Arr.flatMap(CREDENTIALS, (credential) => {
          const text = texts[credential];
          const set = Arr.some(
            steps,
            ({ step, status }) =>
              step === credential && (status === "done" || status === "in_place"),
          );
          return text === undefined || !set ? [] : [[credential, text] as const];
        }),
        ([credential, text]) => recorded(machine, credential, text, null),
        { discard: true },
      ),
    states: (machines: ReadonlyArray<KnownMachine>) =>
      Effect.map(
        Effect.forEach(machines, (machine) =>
          Effect.map(heldFor(machine), (texts) =>
            Arr.map(texts, ([credential, text]) => stateOf(machine, credential, text)),
          ),
        ),
        (each) => each.flat(),
      ),
    drop: (profile: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const { [profile]: _gone, ...kept } = record;
          record = kept;
          for (const credential of CREDENTIALS) {
            failures.delete(`${profile} ${credential}`);
          }
          yield* save;
        }),
      ),
  };
});

export type GivenCredentials = Effect.Success<ReturnType<typeof givenCredentials>>;
