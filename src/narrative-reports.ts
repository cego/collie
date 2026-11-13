import { Effect, FileSystem, Path, Schema, Struct, Result, flow } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import { readCards } from "./cards";
import { readMetrics } from "./metrics";
import { NarrativeReport, concise, type ReportAddress } from "./narrative-model";
import type { RunFacts } from "./runs";
import type { RegisterArtefact, Artefact } from "./artefact-model";
import type { AuditLine } from "./audit";
import type { HostRefused, RequestConflict } from "./board-model";
import { nowIso } from "./time";
import { readRunLinks } from "./run-links";
import { sha256Hex } from "./attachments";

const json = Schema.fromJsonString(NarrativeReport);
const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
interface Source {
  ordinal: number;
  key: string;
  title: string;
  step: string;
  at: string | null;
  body: string;
  summary: string;
  blocker: string | null;
  nextAction: string | null;
  address?: ReportAddress;
  linked?: NarrativeReport;
}
type Register = (
  run: RunFacts,
  installation: string,
  input: RegisterArtefact,
  request: string,
  actor: AuditLine["actor"],
  original: string | null,
) => Effect.Effect<
  { item: Artefact; fresh: boolean },
  HostRefused | RequestConflict,
  FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
>;

export const narrativeReports = (
  register: Register,
  notify: (run: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reports = (run: string) =>
      sql<{
        data: string;
      }>`SELECT data FROM collie_narratives WHERE run = ${run} ORDER BY ordinal`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => Schema.decodeEffect(json)(row.data).pipe(Effect.orDie)),
        ),
      );
    const reconcile = Effect.fn("Narratives.reconcile")(function* (run: RunFacts, limit: number) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const observedAt = yield* nowIso;
      const installation = Str.trim(
        yield* fs
          .readFileString(path.resolve(run.dir, "../../installation"))
          .pipe(Effect.orElseSucceed(() => "")),
      );
      const sources: Source[] = [];
      const episodes = new Map<string, Source>();
      const metrics = yield* readMetrics(run.evidence);
      for (const [index, line] of metrics.entries()) {
        if (line.kind !== "recovery") continue;
        const key = `recovery:${line.recoveryId ?? index}`;
        let source = episodes.get(key);
        if (source === undefined) {
          source = {
            ordinal: index,
            key,
            title: `Recovery ${line.recoveryId ?? index}`,
            step: "unknown",
            at: line.at || null,
            body: "",
            summary: "",
            blocker: null,
            nextAction: null,
          };
          episodes.set(key, source);
          sources.push(source);
        }
        source.body += `\n## ${line.at || "Original date unknown"} · ${line.action ?? "recovery"} ${line.outcome ?? "unknown"}\n\n${line.note}\n`;
        source.ordinal = index;
        source.summary =
          line.summary ?? `${line.action ?? "recovery"}: ${line.outcome ?? "unknown"}.`;
        source.blocker =
          line.blocker ?? (line.cause === undefined ? null : `Park cause: ${line.cause}`);
        source.nextAction = line.next_action ?? null;
        if (line.report !== undefined) source.address = line.report;
      }
      const cards = new Map<string, Source>();
      const recordedCards = yield* readCards(run.dir);
      for (const [index, card] of recordedCards.entries()) {
        if (card.narrative === null || Str.trim(card.narrative) === "") continue;
        const previous = cards.get(card.id);
        const source = {
          ordinal: metrics.length + index,
          key: `card:${card.id}`,
          title: `${card.step} report`,
          step: card.step,
          at: previous?.at ?? (card.at || null),
          body: `${previous?.body ?? ""}\n## ${card.at || "Original date unknown"}\n\n${card.narrative}`,
          summary: card.summary ?? `${card.step}: ${card.readiness}.`,
          blocker: card.blocker ?? null,
          nextAction: card.next_action ?? null,
          address: card.report,
        };
        cards.set(card.id, source);
      }
      sources.push(...cards.values());
      for (const link of yield* readRunLinks(run.dir)) {
        for (const report of link.narratives ?? []) {
          sources.push({
            ordinal: metrics.length + recordedCards.length + sources.length,
            key: `helper:${link.machine.installation}:${link.run}:${report.key}`,
            title: report.title,
            step: report.address?.step ?? "unknown",
            at: report.at,
            body: "",
            summary: report.summary,
            blocker: report.blocker,
            nextAction: report.nextAction,
            linked: report,
          });
        }
      }
      const prior = new Map(
        Arr.map(
          yield* sql<{
            key: string;
            fingerprint: string;
            data: string;
          }>`SELECT key, fingerprint, data FROM collie_narratives WHERE run = ${run.id}`.pipe(
            Effect.orDie,
          ),
          (row) => [row.key, row] as const,
        ),
      );
      const cursor =
        (yield* sql<{
          cursor: string;
        }>`SELECT cursor FROM collie_narrative_work WHERE run = ${run.id}`.pipe(Effect.orDie))[0]
          ?.cursor ?? "";
      const fingerprintOf = (source: Source) => sha256Hex(asJson(Struct.omit(source, ["ordinal"])));
      const waiting = Arr.filter(
        sources,
        (source) => prior.get(source.key)?.fingerprint !== fingerprintOf(source),
      ).sort((a, b) => Str.localeCompare(b.key)(a.key));
      const newest = Arr.reduce<Source, Source | undefined>(waiting, undefined, (latest, source) =>
        latest === undefined || latest.ordinal < source.ordinal ? source : latest,
      );
      const ordered = [
        ...(newest === undefined ? [] : [newest]),
        ...Arr.filter(waiting, (source) => source.key > cursor),
        ...Arr.filter(waiting, (source) => source.key <= cursor),
      ];
      const round = Arr.dedupeWith(ordered, (a, b) => a.key === b.key).slice(0, limit);
      for (const source of round) {
        const ordinal = source.ordinal;
        const fingerprint = fingerprintOf(source);
        const previous = prior.get(source.key);
        if (previous?.fingerprint === fingerprint) continue;
        const base: NarrativeReport = {
          origin: { installation, run: run.id, step: source.step },
          key: source.key,
          title: source.title,
          summary: concise(source.summary),
          blocker: source.blocker,
          nextAction: source.nextAction,
          state: "preparing",
          reason: null,
          at: source.at,
          observedAt,
        };
        const result = yield* Effect.gen(function* () {
          if (source.linked !== undefined) {
            if (source.linked.address !== undefined) return source.linked.address;
            return yield* Effect.fail(
              source.linked.reason ?? "The helper's report is not registered yet",
            );
          }
          if (source.address !== undefined) {
            const address = source.address;
            const retained = (yield* sql<{
              digest: string;
              size: number;
            }>`SELECT revision.digest, revision.size FROM collie_artefact_revisions AS revision JOIN collie_artefacts AS item ON item.run = revision.run AND item.id = revision.id WHERE revision.run = ${address.run} AND revision.id = ${address.id} AND revision.revision = ${address.revision} AND json_extract(item.data, '$.installation') = ${address.installation}`.pipe(
              Effect.orDie,
            ))[0];
            const owner = path.resolve(run.dir, "..", address.run);
            if (
              address.installation !== installation ||
              retained === undefined ||
              !(yield* fs.exists(`${owner}/.artefacts/${retained.digest}`))
            )
              return yield* Effect.fail(
                "The supplied report revision is not retained by this host; original detail remains available",
              );
            return { ...address, digest: retained.digest, size: retained.size };
          }
          if (installation === "")
            return yield* Effect.fail("The owning Machine has no installation identity");
          const key = sha256Hex(source.key);
          const file = `${run.dir}/.reports/${key}.md`;
          const body = `# ${source.title}\n\nRun: ${run.id} · Step: ${source.step}\n\nSource: ${source.key}\n\nOriginal date: ${source.at ?? "unknown (host observation only)"}\n\n${source.body}`;
          yield* fs.makeDirectory(`${run.dir}/.reports`, { recursive: true });
          yield* fs.writeFileString(`${file}.pending`, body);
          yield* fs.rename(`${file}.pending`, file);
          const request = `report:${key}:${fingerprint}:${sha256Hex(previous?.fingerprint ?? "")}`;
          const registered = yield* register(
            run,
            installation,
            { path: file, title: source.title, role: "report", kind: "file", snapshot: true },
            request,
            { origin: "host", requestId: request },
            source.at,
          );
          return {
            installation,
            run: run.id,
            id: registered.item.id,
            revision: registered.item.revision,
            step: source.step,
            digest: registered.item.digest,
            size: registered.item.size,
          };
        }).pipe(Effect.result);
        const report: NarrativeReport =
          source.linked !== undefined
            ? { ...source.linked, key: source.key }
            : result._tag === "Success"
              ? { ...base, state: "ready", address: result.success }
              : { ...base, state: "failed", reason: String(result.failure) };
        const data = yield* Schema.encodeEffect(json)(report).pipe(Effect.orDie);
        if (previous?.data !== data) {
          yield* sql`INSERT INTO collie_narratives (run, key, ordinal, fingerprint, data) VALUES (${run.id}, ${source.key}, ${ordinal}, ${result._tag === "Success" || source.linked !== undefined ? fingerprint : ""}, ${data}) ON CONFLICT(run, key) DO UPDATE SET ordinal = excluded.ordinal, fingerprint = excluded.fingerprint, data = excluded.data`.pipe(
            Effect.orDie,
          );
          yield* notify(run.id);
        }
        yield* sql`INSERT INTO collie_narrative_work (run, cursor) VALUES (${run.id}, ${source.key}) ON CONFLICT(run) DO UPDATE SET cursor = excluded.cursor`.pipe(
          Effect.orDie,
        );
      }
    });
    return { reports, reconcile };
  });
