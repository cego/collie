import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { RELEASE_TAG } from "./release";
import { epochMs } from "./time";
import { appliedSignatureOf, RELEASE_PUBLIC_KEY, verifyRelease } from "./signing";

const IDENTIFIER = "dk.cego.collie.desktop";
const RELEASED_FOR = "linux-x64";
const PREFIX = `stable-${RELEASED_FOR}`;

// WARNING: Electrobun's own file format as 2.0.2 writes it; recheck on an upgrade.
const Installed = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    channel: Schema.String,
    identifier: Schema.String,
    baseUrl: Schema.String,
  }),
);
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    identifier: Schema.Literal(IDENTIFIER),
    channel: Schema.Literal("stable"),
    platform: Schema.Literal("linux"),
    arch: Schema.Literal("x64"),
    version: Schema.String,
    hash: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,13}$/)),
    artifact: Schema.Struct({
      file: Schema.String.check(Schema.isPattern(new RegExp(`^${PREFIX}-[\\w.-]+\\.tar\\.zst$`))),
    }),
  }),
);
export const preparedRecordOf = (channelRoot: string) =>
  `${channelRoot}/self-extraction/.electrobun-prepared-update.json`;
export const PreparedRecord = Schema.fromJsonString(
  Schema.Struct({
    schema_version: Schema.Literal(1),
    identifier: Schema.String,
    channel: Schema.String,
    version: Schema.String,
    hash: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
    retained_tar_path: Schema.String,
    artifact_file: Schema.String,
  }),
);

export const releaseOf = (baseUrl: string, version: string) =>
  pipe_(
    baseUrl,
    Str.replace(/\/+$/, ""),
    Str.replace(/\/latest\/download$/, `/download/${version}`),
  );

export const dataHomeOf = (
  home: string,
  xdgDataHome: string | undefined,
  platform: NodeJS.Platform = process.platform,
) =>
  platform === "darwin"
    ? `${home}/Library/Application Support`
    : xdgDataHome !== undefined && pipe_(xdgDataHome, Str.startsWith("/")) && xdgDataHome !== "/"
      ? xdgDataHome
      : `${home}/.local/share`;

export interface DesktopStep {
  readonly step: "desktop";
  readonly state: "done" | "already in place" | "failed";
  readonly detail: string;
}

export interface DesktopUpdateOptions {
  readonly dataHome: string;
  readonly key?: string;
  readonly platform?: string;
  readonly running?: (app: string) => Effect.Effect<boolean, never, FileSystem.FileSystem>;
}

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.mapError((failed) => `could not fetch ${url}: ${failed.message}`),
  );

const bodyOf = (url: string) =>
  fetched(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.arrayBuffer.pipe(
            Effect.map((bytes) => new Uint8Array(bytes)),
            Effect.mapError((failed) => failed.message),
          )
        : Effect.fail(`${url} answered HTTP ${response.status}`),
    ),
  );

const signatureAt = (url: string) =>
  fetched(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text.pipe(Effect.mapError((failed) => failed.message))
        : Effect.succeed(null),
    ),
  );

export const runningFrom = (app: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pids = yield* fs.readDirectory("/proc");
    for (const pid of Arr.filter(pids, (name) => /^\d+$/.test(name))) {
      const exe = yield* fs.readLink(`/proc/${pid}/exe`).pipe(Effect.orElseSucceed(() => ""));
      if (pipe_(exe, Str.startsWith(`${app}/`))) {
        return true;
      }
    }
    return false;
  }).pipe(Effect.orElseSucceed(() => false));

export const updateDesktop = Effect.fn("desktop.update")(function* (
  to: string,
  {
    dataHome,
    key = RELEASE_PUBLIC_KEY,
    platform = `${process.platform}-${process.arch}`,
    running = runningFrom,
  }: DesktopUpdateOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (platform !== RELEASED_FOR || !RELEASE_TAG.test(to)) {
    return null;
  }
  const root = path.resolve(dataHome, IDENTIFIER, "stable");
  const app = path.join(root, "app");
  const installed = yield* fs
    .readFileString(path.join(app, "Resources", "version.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Installed)), Effect.option);
  if (
    Option.isNone(installed) ||
    installed.value.channel !== "stable" ||
    installed.value.identifier !== IDENTIFIER ||
    !RELEASE_TAG.test(installed.value.version)
  ) {
    return null;
  }
  const from = installed.value.version;
  if (Bun.semver.order(from, to) >= 0) {
    return {
      step: "desktop",
      state: "already in place",
      detail: `Desktop is at ${from}`,
    } satisfies DesktopStep;
  }

  const staged = yield* fs
    .readFileString(preparedRecordOf(root))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PreparedRecord)), Effect.option);
  // WARNING: one already staged is never replaced by an older one.
  const target = Option.match(staged, {
    onNone: () => to,
    onSome: ({ version }) => (Bun.semver.order(version, to) >= 0 ? version : to),
  });

  const staging = Effect.gen(function* () {
    const release = releaseOf(installed.value.baseUrl, to);
    const manifest = yield* bodyOf(`${release}/${PREFIX}-update.json`).pipe(
      Effect.flatMap((bytes) =>
        Schema.decodeEffect(Manifest)(new TextDecoder().decode(bytes)).pipe(
          Effect.mapError(() => `release ${to} has no Desktop update for ${RELEASED_FOR}`),
        ),
      ),
    );
    if (manifest.version !== to) {
      return yield* Effect.fail(`release ${to} offers Desktop ${manifest.version}`);
    }
    const archive = yield* bodyOf(`${release}/${manifest.artifact.file}`);
    const tar = yield* Effect.tryPromise({
      try: () => Bun.zstdDecompress(archive),
      catch: () => `${manifest.artifact.file} is not a zstd archive`,
    });
    const signature = yield* signatureAt(
      `${release}/${appliedSignatureOf(manifest.artifact.file)}`,
    );
    const verified = verifyRelease(tar, signature, key);
    if (!verified.ok) {
      return yield* Effect.fail(verified.reason);
    }

    const extraction = path.join(root, "self-extraction");
    const retained = path.join(extraction, `${manifest.hash}.tar`);
    yield* fs.makeDirectory(extraction, { recursive: true });
    yield* fs.writeFile(`${retained}.partial`, tar);
    yield* fs.rename(`${retained}.partial`, retained);
    const record = preparedRecordOf(root);
    yield* fs.writeFileString(
      `${record}.partial`,
      yield* Schema.encodeEffect(PreparedRecord)({
        schema_version: 1,
        identifier: IDENTIFIER,
        channel: "stable",
        version: manifest.version,
        hash: manifest.hash,
        platform: "linux",
        arch: "x64",
        retained_tar_path: retained,
        artifact_file: manifest.artifact.file,
      }),
    );
    yield* fs.rename(`${record}.partial`, record);
    if (Option.isSome(staged) && staged.value.retained_tar_path !== retained) {
      yield* fs.remove(staged.value.retained_tar_path, { force: true });
    }
  });

  return yield* (target === to ? staging : Effect.void).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError(String),
    Effect.andThen(running(app)),
    Effect.match({
      onFailure: (reason) => ({
        step: "desktop",
        state: "failed",
        detail: `Desktop ${to} was not staged: ${reason}`,
      }),
      onSuccess: (live) => ({
        step: "desktop",
        state: "done",
        detail: `Desktop ${from} → ${target} ${live ? "applies when you restart Desktop" : "installs when Desktop next starts"}`,
      }),
    }),
  );
});

export const desktopRootOf = (dataHome: string) => `${dataHome}/${IDENTIFIER}/stable`;

export interface DesktopOwn {
  readonly root: string;
  readonly state: string;
  readonly hash: string | null;
  readonly version: string | null;
}

const USAGE_KEEP_MS = 30 * 24 * 60 * 60_000;
// WARNING: as long as Claude Code keeps the transcripts that name a chat attachment.
const ATTACHMENT_KEEP_MS = 30 * 24 * 60 * 60_000;
const PARTIAL_KEEP_MS = 24 * 60 * 60_000;
const UsageAt = Schema.fromJsonString(Schema.Struct({ at: Schema.String }));

export const desktopVerdicts = Effect.fn("desktop.verdicts")(function* (own: DesktopOwn) {
  const fs = yield* FileSystem.FileSystem;
  const remove: Array<{ target: string; reason: string }> = [];
  const keep: Array<{ target: string; reason: string }> = [];
  const list = (dir: string) => fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));

  const extraction = `${own.root}/self-extraction`;
  const prepared = yield* fs
    .readFileString(preparedRecordOf(own.root))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PreparedRecord)), Effect.option);
  const waiting = Option.match(prepared, {
    onNone: () => null,
    onSome: (record) => (record.hash === own.hash ? null : `${record.hash}.tar`),
  });
  for (const name of yield* list(extraction)) {
    if (!/\.tar(?:\.(?:previous|preprevious))?$/.test(name)) {
      continue;
    }
    const target = `${extraction}/${name}`;
    if (own.hash === null) {
      keep.push({ target, reason: "which bundle Desktop runs is not known" });
    } else if (name === `${own.hash}.tar`) {
      keep.push({ target, reason: "the running bundle's, the base for its next update" });
    } else if (name === waiting) {
      keep.push({ target, reason: "an update not yet applied" });
    } else {
      remove.push({ target, reason: "a staged update Desktop no longer runs" });
    }
  }

  const runners = `${own.root}/runners`;
  const versions = Arr.filter(yield* list(runners), (name) => Bun.semver.satisfies(name, "*"));
  const newest = Arr.reduce<string, string | null>(versions, null, (best, one) =>
    best === null || Bun.semver.order(one, best) > 0 ? one : best,
  );
  for (const version of versions) {
    const target = `${runners}/${version}`;
    if (version === own.version) {
      keep.push({ target, reason: "the running version's" });
    } else if (version === newest) {
      keep.push({ target, reason: "the newest" });
    } else {
      remove.push({ target, reason: "a runner copy neither running nor newest" });
    }
  }

  const now = yield* Clock.currentTimeMillis;
  const unchangedFor = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => now - (Option.getOrNull(info.mtime)?.getTime() ?? now)),
      Effect.orElseSucceed(() => 0),
    );
  const attachments = `${own.state}/attachments`;
  for (const name of yield* list(attachments)) {
    const target = `${attachments}/${name}`;
    if (/^[0-9a-f]{64}$/.test(name) && (yield* unchangedFor(target)) > ATTACHMENT_KEEP_MS) {
      remove.push({ target, reason: "a chat attachment unused for 30 days" });
    }
  }
  for (const name of yield* list(`${attachments}/.partial`)) {
    const target = `${attachments}/.partial/${name}`;
    if ((yield* unchangedFor(target)) > PARTIAL_KEEP_MS) {
      remove.push({ target, reason: "an attachment's transfer abandoned a day ago" });
    }
  }

  const log = `${own.state}/flock-usage.jsonl`;
  const text = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ""));
  const since = now - USAGE_KEEP_MS;
  const lines = Arr.filter(Str.split(text, "\n"), (line) => Str.trim(line) !== "");
  const recent = Arr.filter(lines, (line) =>
    Option.match(Schema.decodeOption(UsageAt)(line), {
      onNone: () => true,
      onSome: ({ at }) => epochMs(at) >= since,
    }),
  );
  const usage =
    recent.length === lines.length
      ? null
      : { target: log, dropped: lines.length - recent.length, kept: recent };
  return { remove, keep, usage };
});

export const pruneDesktop = Effect.fn("desktop.prune")(function* (own: DesktopOwn) {
  const fs = yield* FileSystem.FileSystem;
  const verdicts = yield* desktopVerdicts(own);
  for (const { target } of verdicts.remove) {
    yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);
  }
  if (verdicts.usage !== null) {
    yield* trimUsage(verdicts.usage);
  }
  return verdicts;
});

export const trimUsage = (usage: {
  readonly target: string;
  readonly kept: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmp = `${usage.target}.${process.pid}.tmp`;
    yield* fs.writeFileString(
      tmp,
      Arr.join(
        Arr.map(usage.kept, (line) => `${line}\n`),
        "",
      ),
    );
    yield* fs.rename(tmp, usage.target);
  }).pipe(Effect.ignore);

export const sshControlsPrefix = (pid: number) => `collie-ssh-${pid}-`;

export const sweepSshControls = Effect.fn("desktop.sweepSshControls")(function* (
  tmp: string,
  env: Readonly<Record<string, string | undefined>>,
  alive: (pid: number) => Effect.Effect<boolean> = (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
) {
  const fs = yield* FileSystem.FileSystem;
  const gone: Array<string> = [];
  for (const name of yield* fs.readDirectory(tmp).pipe(Effect.orElseSucceed(() => []))) {
    const pid = Number(/^collie-ssh-(\d+)-/.exec(name)?.[1] ?? 0);
    if (pid <= 0 || (yield* alive(pid))) {
      continue;
    }
    const dir = `${tmp}/${name}`;
    for (const socket of yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))) {
      yield* Effect.promise(
        () =>
          Bun.spawn(["ssh", "-S", `${dir}/${socket}`, "-O", "exit", "collie-desktop"], {
            env,
            stdout: "ignore",
            stderr: "ignore",
          }).exited,
      );
    }
    yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
    gone.push(dir);
  }
  return gone;
});
