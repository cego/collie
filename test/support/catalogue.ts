// The four harnesses as fakes: each answers what it answered on vm-mk on 29 Oct 2026.

import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { Effect, Layer, Schema, flow, Result } from "effect";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { FrontDoorRpcs } from "../../src/board-model";
import {
  sourcesOf,
  type CatalogueSources,
  type HarnessAdapters,
  type HarnessCatalogues,
} from "../../src/catalogue";
import { ClaudeModels, CodexModelList } from "../../src/catalogue-model";
import { BUILD, HostRpcs, socketOf } from "../../src/host";
import type { Connection } from "../../src/connection-model";
import claudeModels from "../fixtures/catalogue/claude-supported-models.json";
import codexModelList from "../fixtures/catalogue/codex-model-list.json";

const recorded = (name: string) =>
  Effect.promise(() => Bun.file(`${import.meta.dir}/../fixtures/catalogue/${name}`).text());

export const fakeAdapters: HarnessAdapters = {
  claude: Effect.succeed(flow(Schema.decodeResult(ClaudeModels), Result.getOrThrow)(claudeModels)),
  codex: Effect.succeed(
    flow(Schema.decodeResult(CodexModelList), Result.getOrThrow)(codexModelList),
  ),
  pi: recorded("pi-list-models.txt"),
  opencode: recorded("opencode-models.txt"),
};

/** Every harness answering as recorded, but for the ones a test replaces. */
export const fakeSources = (replaced: Partial<CatalogueSources> = {}): CatalogueSources => ({
  ...sourcesOf(fakeAdapters),
  ...replaced,
});

// Unexpected RPCs die so a CLI test cannot pass by asking the wrong operation.
export const serveCatalogue = (
  state: string,
  catalogues: HarnessCatalogues["Service"],
  connections: ReadonlyArray<Connection> = [],
) =>
  Effect.gen(function* () {
    const group = HostRpcs.merge(FrontDoorRpcs);
    const handlers = new Map([
      ["identity", () => Effect.succeed({ build: BUILD, pid: process.pid, dir: state })],
      ["declare", () => Effect.void],
      ["models", () => catalogues.catalogues],
      ["connections", () => Effect.succeed(connections)],
    ]);
    const served = new Proxy(
      {},
      {
        get: (_, tag: string) =>
          handlers.get(tag) ?? (() => Effect.die(`the fake host has no ${tag}`)),
      },
    );
    yield* Layer.build(
      RpcServer.layer(group).pipe(
        // SAFETY: the Proxy answers every tag the group has, the unserved ones by dying.
        Layer.provide(group.toLayer(served as never)),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(BunSocketServer.layer({ path: socketOf(state) })),
      ),
    );
  });
