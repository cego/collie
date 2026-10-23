// A fake `pi --mode rpc` for the model reader. `set_model` answers late, as Pi's does, and
// `get_available_thinking_levels` at once for whichever model is set by then.
// Arguments: the file it records to, the scenario, then what Pi itself is given.

import { Effect, Schema } from "effect";
import { childEnv } from "../../desktop/src/bun/login-env";
import type { JsonObject } from "../../src/schema";

const [record, scenario] = Bun.argv.slice(2);
const emit = (line: JsonObject) =>
  process.stdout.write(`${Schema.encodeSync(Schema.fromJsonString(Schema.Json))(line)}\n`);
const recorded = [
  Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
    args: Bun.argv.slice(4),
    agentDir: childEnv().PI_CODING_AGENT_DIR ?? null,
    pid: process.pid,
  }),
];
await Bun.write(record!, `${recorded.join("\n")}\n`);

if (scenario === "exits") {
  process.stderr.write("Error: models.json is not valid JSON\n");
  process.exit(1);
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const model = (provider: string, id: string, name: string, reasoning: boolean) => ({
  provider,
  id,
  name,
  reasoning,
  api: "openai-responses",
  input: ["text"],
});
const MODELS = [
  model("openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol", true),
  model("openai-codex", "gpt-5.5", "GPT-5.5", true),
  model("ollama", "tiny-thinker", "Tiny Thinker", true),
  model("openai", "gpt-4o-mini", "GPT-4o mini", false),
];
const levelsOf = new Map([
  ["openai-codex/gpt-6.1-sol", LEVELS.slice(1)],
  ["openai-codex/gpt-5.5", LEVELS.slice(0, -1)],
  ["ollama/tiny-thinker", ["off"]],
]);
let current = "openai-codex/gpt-6.1-sol";

const Command = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  provider: Schema.optionalKey(Schema.String),
  modelId: Schema.optionalKey(Schema.String),
});

const answer = (command: typeof Command.Type) => {
  const respond = (data: JsonObject) =>
    emit({ id: command.id, type: "response", command: command.type, success: true, data });
  if (command.type === "get_available_models") {
    if (scenario === "error")
      return emit({
        id: command.id,
        type: "response",
        command: command.type,
        success: false,
        error: "No models available: no provider is logged in",
      });
    // An event between answers, as Pi sends while it works.
    emit({ type: "extension_ui_request", id: "ui-1", method: "notify", message: "Ready" });
    return respond({ models: MODELS });
  }
  if (command.type === "set_model") {
    const set = `${command.provider}/${command.modelId}`;
    return void Effect.runFork(
      Effect.sleep("30 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            current = set;
            respond(MODELS.find(({ provider, id }) => `${provider}/${id}` === set)!);
          }),
        ),
      ),
    );
  }
  if (command.type === "get_available_thinking_levels")
    return respond({ levels: [...(levelsOf.get(current) ?? ["off"])] });
};

let input = "";
for await (const chunk of Bun.stdin.stream()) {
  input += new TextDecoder().decode(chunk);
  let at: number;
  while ((at = input.indexOf("\n")) >= 0) {
    const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command))(input.slice(0, at));
    input = input.slice(at + 1);
    recorded.push(`${command.type} ${command.provider ?? ""}/${command.modelId ?? ""}`);
    // Recorded before it is answered, so the record is whole by the time Pi is ended.
    await Bun.write(record!, `${recorded.join("\n")}\n`);
    answer(command);
  }
}
