import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { frontDoor, socketOf } from "../src/host";
import { collie, proves } from "./support/world";

test(
  "a host reports only its configured local values and the harnesses on its PATH",
  () =>
    proves(
      "collie-machine-own-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const bin = `${world.home}/bin`;
          yield* fs.makeDirectory(bin);
          yield* fs.writeFileString(`${bin}/codex`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
          yield* fs.writeFileString(`${bin}/pi`, "#!/bin/sh\nexit 1\n", { mode: 0o644 });
          yield* fs.writeFileString(
            `${world.config}/config.json`,
            Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
              projects: { root: "/work/projects" },
              chat_harness: "pi",
              linear: { team: "TOOLS" },
              gitlab: { assignee: "mk" },
              harness: "codex",
              models: { codex: ["extra"] },
              notifications: { "run-done": false },
            }),
          );
          expect(
            (yield* collie(world, ["board"], { PATH: `${bin}:/usr/bin:/bin` })).envelope.ok,
          ).toBe(true);
          const door = yield* frontDoor(socketOf(world.state));
          expect(yield* door.machineOwn()).toEqual({
            projectsRoot: "/work/projects",
            chatHarness: "pi",
            harnesses: ["codex"],
            remembered: [
              { key: "linear.team", value: "TOOLS" },
              { key: "gitlab.assignee", value: "mk" },
            ],
          });
          yield* fs.writeFileString(`${world.config}/config.json`, "{}");
          const unset = yield* door.machineOwn();
          expect(unset).toEqual({ harnesses: ["codex"], remembered: [] });
          expect(Object.hasOwn(unset, "projectsRoot")).toBe(false);
          expect(Object.hasOwn(unset, "chatHarness")).toBe(false);
        }),
      [],
    ),
  120_000,
);
