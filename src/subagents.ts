// Claude's native delegation controls, scoped to one managed agent's launch.

import * as Rec from "effect/Record";
import { Schema, flow, Result } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const ClaudeSubagents = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.String),
  forceModel: Schema.optional(Schema.Boolean),
  cacheTtl: Schema.optional(Schema.Literals(["5m", "1h"])),
  maxDepth: Schema.optional(PositiveInt),
  maxConcurrent: Schema.optional(PositiveInt),
});
export type ClaudeSubagents = typeof ClaudeSubagents.Type;

export const decodeSubagents = Schema.decodeUnknownResult(ClaudeSubagents, {
  onExcessProperty: "error",
});
export const readSubagents = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeSubagents), {
  onExcessProperty: "error",
});
export const encodeSubagents = flow(
  Schema.encodeResult(Schema.fromJsonString(ClaudeSubagents)),
  Result.getOrThrow,
);

export function parseSubagents(text: string): { policy: ClaudeSubagents } | { refused: string } {
  const decoded = Schema.decodeResult(Schema.fromJsonString(ClaudeSubagents), {
    onExcessProperty: "error",
  })(text);
  return decoded._tag === "Success"
    ? { policy: decoded.success }
    : { refused: `claude_subagents: ${String(decoded.failure)}` };
}

export function subagentVersion(policy: ClaudeSubagents): string {
  if (policy.forceModel !== undefined) return "2.1.257";
  if (policy.model !== undefined) return "2.1.251";
  if (policy.cacheTtl !== undefined) return "2.1.242";
  if (policy.maxDepth !== undefined || policy.maxConcurrent !== undefined) return "2.1.217";
  return "2.1.63";
}

export function subagentSettings(policy: ClaudeSubagents): Schema.JsonObject {
  const settings: Record<string, Schema.Json> = {};
  const env: Record<string, string> = {};
  if (policy.model !== undefined) env.CLAUDE_CODE_SUBAGENT_MODEL = policy.model;
  if (policy.forceModel !== undefined)
    env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = policy.forceModel ? "1" : "0";
  if (policy.maxDepth !== undefined)
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(policy.maxDepth);
  if (policy.maxConcurrent !== undefined)
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(policy.maxConcurrent);
  if (Rec.keys(env).length > 0) settings.env = env;
  if (policy.cacheTtl !== undefined) settings.subagentPromptCacheTtl = policy.cacheTtl;
  if (policy.enabled === false) settings.permissions = { deny: ["Agent"] };
  return settings;
}
