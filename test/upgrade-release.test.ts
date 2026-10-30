// `collie upgrade` on a release: the runner places the release it carries into the Collie
// directory's `release/`, keeping any edit it finds there, and never writes `user/`. Another
// version is handed to that version's runner, downloaded from a served fake release and
// verified first.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { upgrade } from "../src/operations";
import { shell, type Ran } from "../src/mr";
import { ownPlatform } from "../src/releases";
import { signRelease } from "../src/signing";
import { generateKeyPairSync } from "node:crypto";
import manifest from "../herdr-plugin.toml";

let rig: Rig;
let collieDir: string;
let tree: string;
let runner: string;
let prepared: string[];
let served: ReturnType<typeof Bun.serve>;
/** What the fake release source answers: the newest version, and each published file. */
let latest: string;
let published: Map<string, Uint8Array | string>;

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};
const KEY = pair();
const ASSET = `collie-${ownPlatform()}`;

const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text));
const read = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).readFileString(file);
  });
const exists = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(file);
  });

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      collieDir = `${rig.root}/collie-dir`;
      tree = `${rig.root}/carried/release`;
      runner = `${rig.root}/carried/collie`;
      prepared = [];
      yield* write(`${tree}/herdr-plugin.toml`, `version = "${manifest.version}"\n`);
      yield* write(`${tree}/prepare.sh`, `echo "prepare: runner: already in place"\n`);
      yield* write(`${tree}/personas/planner.md`, "the shipped planner\n");
      yield* write(`${tree}/workflows/plan.workflow.ts`, "export default 1;\n");
      yield* write(runner, "#!/bin/sh\necho runner\n");
      yield* write(`${collieDir}/user/config.json`, `{"mine":true}\n`);
      latest = manifest.version;
      published = new Map();
      served = Bun.serve({
        port: 0,
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/latest") {
            return new Response(null, { status: 302, headers: { location: `/tag/${latest}` } });
          }
          const body = published.get(path);
          return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
        },
      });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.promise(() => served.stop(true));
      yield* rig.close();
    }),
  ),
);

/** Publishes `version`'s runner: it records how it was run and answers as an upgrade. */
const publish = (version: string, signedBy = KEY.privateKey) => {
  const bytes = new TextEncoder().encode(`#!/bin/sh
echo "$COLLIE_DIR $*" > "${rig.root}/handed-off"
echo '{"ok":true,"data":{"root":"'"$COLLIE_DIR"'/release","checkout":false,"release":"${version}","kept":["kept/then/personas/planner.md"],"steps":[{"step":"runner","state":"already in place","detail":""}],"version":"${version}"}}'
`);
  published.set(`/download/${version}/${ASSET}`, bytes);
  published.set(`/download/${version}/${ASSET}.sig`, signRelease(bytes, signedBy));
};

/** Not a checkout to git, a `prepare.sh` whose directory is recorded, and anything else run. */
const run = (cmd: string, args: string[], cwd: string) => {
  if (cmd === "git") return Effect.succeed<Ran>({ code: 128, stdout: "", stderr: "not a git" });
  if (cmd !== "sh") return shell(cmd, args, cwd);
  return Effect.sync((): Ran => {
    prepared.push(`${cmd} ${Arr.join(args, " ")} in ${cwd}`);
    return { code: 0, stdout: "prepare: runner: already in place\n" };
  });
};

/** The files an upgrade said it kept, relative to their `kept/<when>/`. */
const keptOf = (result: Effect.Success<ReturnType<typeof upgrade>>) =>
  result.ok && "kept" in result.data ? result.data.kept : [];
const shipped = (file: string) => pipe(file, Str.replace(/^kept\/[^/]+\//, ""));

const releaseEnv = () => {
  const env = rig.pluginEnv();
  return {
    ...env,
    pluginRoot: `${collieDir}/release`,
    collieDir,
    userDir: `${collieDir}/user`,
    raw: { ...env.raw, COLLIE_RELEASES: `http://127.0.0.1:${served.port}` },
  };
};

const place = (to?: string) =>
  upgrade(releaseEnv(), { carried: { tree, runner }, key: KEY.publicKey, ...(to && { to }) }, run);

test("a release is placed into an empty Collie directory, and prepared from there", () =>
  runEffect(
    Effect.gen(function* () {
      const placed = yield* place();

      expect(placed).toMatchObject({ ok: true, data: { release: manifest.version, kept: [] } });
      expect(yield* read(`${collieDir}/release/personas/planner.md`)).toBe("the shipped planner\n");
      expect(yield* read(`${collieDir}/release/bin/collie`)).toBe("#!/bin/sh\necho runner\n");
      const mode = (yield* (yield* FileSystem.FileSystem).stat(`${collieDir}/release/bin/collie`))
        .mode;
      expect(mode & 0o111).toBe(0o111);
      expect(prepared).toEqual([`sh prepare.sh in ${collieDir}/release`]);
      expect(yield* read(`${collieDir}/user/config.json`)).toBe(`{"mine":true}\n`);
      expect(yield* exists(`${collieDir}/kept`)).toBe(false);
    }),
  ));

test("an edit in a release is kept and named, and a deleted file is restored", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* place();
      yield* write(`${collieDir}/release/personas/planner.md`, "my planner\n");
      yield* write(`${collieDir}/release/personas/mine.md`, "a persona of my own\n");
      yield* fs.remove(`${collieDir}/release/workflows/plan.workflow.ts`);

      const placed = yield* place();

      expect(placed.ok).toBe(true);
      const kept = keptOf(placed);
      expect(Arr.map(kept, shipped).sort()).toEqual(["personas/mine.md", "personas/planner.md"]);
      for (const file of kept) {
        expect(placed.ok && placed.human).toContain(file);
        expect(
          [`my planner\n`, `a persona of my own\n`].includes(yield* read(`${collieDir}/${file}`)),
        ).toBe(true);
      }
      expect(placed.ok && placed.human).toContain("collie persona fork");
      expect(yield* read(`${collieDir}/release/personas/planner.md`)).toBe("the shipped planner\n");
      expect(yield* exists(`${collieDir}/release/personas/mine.md`)).toBe(false);
      expect(yield* read(`${collieDir}/release/workflows/plan.workflow.ts`)).toBe(
        "export default 1;\n",
      );
      expect(yield* read(`${collieDir}/user/config.json`)).toBe(`{"mine":true}\n`);
    }),
  ));

test("every file of a release placed before records existed is kept", () =>
  runEffect(
    Effect.gen(function* () {
      yield* write(`${collieDir}/release/personas/planner.md`, "from before\n");

      const placed = yield* place();

      expect(Arr.map(keptOf(placed), shipped)).toEqual(["personas/planner.md"]);
    }),
  ));

test("a fresh Collie directory gets an empty user/ beside the release", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${collieDir}/user`, { recursive: true });

      yield* place();

      expect((yield* fs.readDirectory(collieDir)).sort()).toEqual(["release", "user"]);
    }),
  ));

test(
  "placements at once take turns, so the release is wholly one of them",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const other = `${rig.root}/other/release`;
        yield* fs.copy(tree, other);
        yield* write(`${other}/personas/extra.md`, "only in the other\n");
        // Large enough that the two placements overlap.
        for (let file = 0; file < 1500; file++) {
          yield* write(`${tree}/bulk/${file}.md`, `${file}\n`);
          yield* write(`${other}/other/${file}.md`, `${file}\n`);
        }

        const both = yield* Effect.promise(() =>
          Promise.all(
            Arr.map(
              [
                [tree, "1.0.0"],
                [other, "2.0.0"],
              ],
              ([from, version]) =>
                Bun.spawn([
                  "bun",
                  `${import.meta.dir}/fixtures/place-release.ts`,
                  from!,
                  runner,
                  collieDir,
                  version!,
                ]).exited,
            ),
          ),
        );

        expect(both).toEqual([0, 0]);
        const record = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ files: Schema.Record(Schema.String, Schema.String) }),
          ),
        )(yield* read(`${collieDir}/release/placed.json`));
        const placed: string[] = [];
        for (const name of yield* fs.readDirectory(`${collieDir}/release`, { recursive: true })) {
          const file = (yield* fs.stat(`${collieDir}/release/${name}`)).type === "File";
          if (file && name !== "placed.json") placed.push(name);
        }
        expect(placed.sort()).toEqual(Rec.keys(record.files).sort());
        expect(yield* exists(`${collieDir}/release.new`)).toBe(false);
      }),
    ),
  60_000,
);

test("placing the same version twice changes nothing and keeps nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* place();
      const before = yield* read(`${collieDir}/release/personas/planner.md`);

      const again = yield* place();

      expect(again).toMatchObject({ ok: true, data: { release: manifest.version, kept: [] } });
      expect(yield* read(`${collieDir}/release/personas/planner.md`)).toBe(before);
      expect(yield* exists(`${collieDir}/kept`)).toBe(false);
    }),
  ));

test("a runner that carries no release places nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const refused = yield* upgrade(releaseEnv(), { carried: null }, run);

      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(yield* exists(`${collieDir}/release`)).toBe(false);
      expect(prepared).toEqual([]);
    }),
  ));

test("a newer release is downloaded, verified and handed the upgrade, whose report is this one's", () =>
  runEffect(
    Effect.gen(function* () {
      latest = "99.0.0";
      publish("99.0.0");

      const upgraded = yield* place();

      expect(upgraded).toMatchObject({
        ok: true,
        data: { release: "99.0.0", version: "99.0.0", kept: ["kept/then/personas/planner.md"] },
      });
      expect(yield* read(`${rig.root}/handed-off`)).toBe(
        `${collieDir} --json upgrade --to 99.0.0\n`,
      );
      expect(upgraded.ok && upgraded.human).toContain("Placed Collie 99.0.0");
      expect(upgraded.ok && upgraded.human).toContain(`${collieDir}/kept/then/personas/planner.md`);
      expect(upgraded.ok && upgraded.human).toMatch(/runner\s+already in place/);
      expect(prepared).toEqual([]);
    }),
  ));

test("--to an older release moves to exactly it", () =>
  runEffect(
    Effect.gen(function* () {
      latest = "99.0.0";
      publish("0.1.0");

      const upgraded = yield* place("0.1.0");

      expect(upgraded).toMatchObject({ ok: true, data: { release: "0.1.0" } });
      expect(yield* read(`${rig.root}/handed-off`)).toContain("upgrade --to 0.1.0");
    }),
  ));

/** The release as it was placed, so a refused upgrade can be shown to have left it alone. */
const placedRecord = () => read(`${collieDir}/release/placed.json`);

test("a version with no release is refused, and the release is left as it was", () =>
  runEffect(
    Effect.gen(function* () {
      yield* place();
      const before = yield* placedRecord();

      const refused = yield* place("98.0.0");

      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(yield* placedRecord()).toBe(before);
    }),
  ));

test("a runner that does not verify is never run, and the release is left as it was", () =>
  runEffect(
    Effect.gen(function* () {
      yield* place();
      const before = yield* placedRecord();
      publish("99.0.0", pair().privateKey);

      const refused = yield* place("99.0.0");

      expect(refused).toMatchObject({ ok: false, error: { code: "operation_failed" } });
      expect(!refused.ok && refused.error.message).toContain("does not match its signature");
      expect(yield* exists(`${rig.root}/handed-off`)).toBe(false);
      expect(yield* placedRecord()).toBe(before);
    }),
  ));

test("a release source that cannot be reached changes nothing, and says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* place();
      const before = yield* placedRecord();
      yield* Effect.promise(() => served.stop(true));

      const refused = yield* place();

      expect(refused).toMatchObject({ ok: false, error: { code: "operation_failed" } });
      expect(yield* placedRecord()).toBe(before);
    }),
  ));
