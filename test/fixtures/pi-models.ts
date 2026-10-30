import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { Effect, Schema, flow, Result } from "effect";
import { childEnv } from "../../desktop/src/bun/login-env";
import type { JsonObject } from "../../src/schema";

const Command = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  provider: Schema.optionalKey(Schema.String),
  modelId: Schema.optionalKey(Schema.String),
});
const mode = Bun.argv[2];
await Bun.write(
  `${process.cwd()}/reader-start.json`,
  JSON.stringify({
    args: Bun.argv.slice(3),
    agent: childEnv().PI_CODING_AGENT_DIR,
    pid: process.pid,
  }),
);
const emit = (record: JsonObject) => process.stdout.write(`${JSON.stringify(record)}\n`);
const models = [
  { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
  { provider: "openai-codex", id: "gpt-6.1-sol", name: "Sol", reasoning: true },
  { provider: "local", id: "only-off", name: "Off only", reasoning: true },
  { provider: "local", id: "plain", name: "Plain", reasoning: false },
  { provider: "", id: "refused", name: "Refused", reasoning: true },
];
let selected = "";
let pending = "";
let busy = false;
let previousId = "old";
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  while (pipe_(pending, Str.includes("\n"))) {
    const end = Option.getOrElse(pipe_(pending, Str.indexOf("\n")), () => -1);
    const command = flow(
      Schema.decodeResult(Schema.fromJsonString(Command)),
      Result.getOrThrow,
    )(pipe_(pending, Str.slice(0, end)));
    pending = pipe_(pending, Str.slice(end + 1));
    if (busy) {
      process.stderr.write("Commands overlapped before Pi answered");
      process.exit(2);
    }
    if (mode === "exit") {
      process.stderr.write("Pi could not load this provider");
      process.exit(1);
    }
    busy = true;
    void Effect.runPromise(
      Effect.sleep("5 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            emit({
              id: previousId,
              type: "response",
              command: command.type,
              success: true,
              data: { levels: ["wrong"] },
            });
            if (mode === "error" && command.type === "set_model") {
              emit({
                id: command.id,
                type: "response",
                command: command.type,
                success: false,
                error: "Pi login expired for openai-codex",
              });
            } else {
              let data: JsonObject;
              if (command.type === "get_available_models") data = { models };
              else if (command.type === "set_model") {
                if (command.modelId === "plain" || command.modelId === "refused") {
                  process.stderr.write("A non-reasoning or refused model was selected");
                  process.exit(4);
                }
                selected = command.modelId!;
                data = {};
              } else if (command.type === "get_available_thinking_levels") {
                data = {
                  levels:
                    selected === "gpt-5.5"
                      ? ["off", "minimal", "low", "medium", "high", "xhigh"]
                      : selected === "gpt-6.1-sol"
                        ? ["minimal", "low", "medium", "high", "xhigh", "max"]
                        : ["off"],
                };
              } else {
                process.stderr.write(`Unexpected command: ${command.type}`);
                process.exit(3);
              }
              emit({
                id: command.id,
                type: "response",
                command: command.type,
                success: true,
                data,
              });
            }
            previousId = command.id;
            busy = false;
          }),
        ),
      ),
    );
  }
}
