import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Option from "effect/Option";
import { DEFAULT_MODEL } from "./harness";
import { mrWords, parseMrTarget } from "./board-model";
import { diffTargetOf, type Settled } from "./strategies";
import { stringifyJson } from "./json";

const MAX = 32;
const DIGEST = 6;

function sanitize(text: string) {
  return pipe(
    Str.toLowerCase(text),
    Str.replace(/[^a-z0-9_-]+/g, "-"),
    Str.replace(/-+/g, "-"),
    Str.replace(/^-+|-+$/g, ""),
  );
}

export function agentName(slug: string, stepId: string, variantKey: string | null, seq: number) {
  return nameWith(slug, stepId, variantKey, seq, false);
}

export const legacyAgentName = (
  slug: string,
  stepId: string,
  variantKey: string | null,
  seq: number,
) => nameWith(slug, stepId, variantKey, seq, true);

function nameWith(
  slug: string,
  stepId: string,
  variantKey: string | null,
  seq: number,
  legacy: boolean,
) {
  const whole = layout(slug, stepId, variantKey, `r${seq}`, legacy);
  if (!whole.cut) return whole.name;
  const sum = pipe(
    Bun.hash(stringifyJson([slug, stepId, variantKey])).toString(36),
    Str.slice(-DIGEST),
  );
  return layout(slug, stepId, variantKey, `${sum}-r${seq}`, legacy).name;
}

export const launchedAs = (
  one: { readonly agent: string; readonly runId: string; readonly sequence?: number },
  name: string,
) =>
  one.agent === agentName(one.runId, name, null, one.sequence ?? 1) ||
  one.agent === legacyAgentName(one.runId, name, null, one.sequence ?? 1);

function layout(
  slug: string,
  stepId: string,
  variantKey: string | null,
  suffix: string,
  legacy: boolean,
) {
  const trim = (text: string, room: number) =>
    pipe(text, Str.slice(0, Math.max(0, room)), Str.replace(/-+$/g, ""));
  const step = sanitize(
    Arr.join(
      Arr.map(
        Arr.filter([stepId, variantKey], (p) => Boolean(p)),
        (part) => (part === null || part === undefined ? "" : globalThis.String(part)),
      ),
      "-",
    ),
  );
  const clean = sanitize(slug);
  const fitted = (limit: number) => {
    const core = trim(step, limit - suffix.length - 1);
    const tail = core ? `${core}-${suffix}` : suffix;
    const room = limit - tail.length - 1;
    const head = room > 0 ? trim(clean, room) : "";
    return { name: head ? `${head}-${tail}` : tail, cut: core !== step || head !== clean };
  };
  const full = fitted(MAX);
  if (/^[a-z]/.test(full.name)) return full;
  if (legacy) return { ...full, name: pipe(`w${full.name}`, Str.slice(0, MAX)) };
  const shorter = fitted(MAX - 1);
  return { ...shorter, name: `w${shorter.name}` };
}

export function stepLabel(slug: string, stepId: string, variantKey: string | null) {
  return Arr.join(
    Arr.map(
      Arr.filter([slug, stepId, variantKey], (p) => Boolean(p)),
      (part) => (part === null || part === undefined ? "" : globalThis.String(part)),
    ),
    "/",
  );
}

export function unsafePathComponent(value: string) {
  if (value === "") return "is empty";
  if (value === "." || value === "..") return `is "${value}"`;
  if (pipe(value, Str.includes("/")) || pipe(value, Str.includes("\\")))
    return "contains a path separator";
  if (/\p{Cc}/u.test(value)) return "contains a control character";
  return null;
}

export function reason(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export const GLYPH = { running: "⚙", waiting: "⚠", done: "✓", failed: "✗" } as const;

const COLLIE_GLYPH = "\u{1F415}";

export const COLLIE_TAB = `${COLLIE_GLYPH} Collie`;

export function displayName(name: string) {
  const [head, ...rest] = Str.split(name, " · ");
  const word = /^[a-z][a-z-]*$/.test(head)
    ? `${Str.toUpperCase(head[0]!)}${pipe(head, Str.slice(1))}`
    : head;
  return Arr.join([word, ...rest], " · ");
}

function opaque(ref: string) {
  return ref === "" || ref === "HEAD" || /^[0-9a-f]{7,40}$/i.test(ref);
}

export function runName(workflow: string, slug: string) {
  const prefix = `${workflow}-`;
  return pipe(slug, Str.startsWith(prefix)) ? pipe(slug, Str.slice(prefix.length)) : slug;
}

export function targetLabel(workflow: string, slug: string, target: string) {
  if (target === "worktree") return "worktree";
  const mr = parseMrTarget(target);
  if (mr) return `${mrWords(mr).sign}${mr.iid}`;
  if (pipe(target, Str.startsWith("branch:"))) {
    const [base, head = ""] = Str.split(pipe(target, Str.slice(7)), "...");
    if (!opaque(head)) return head;
    if (!opaque(base)) return base;
    return "diff";
  }
  return runName(workflow, slug);
}

export function tabLabel(glyph: string, name: string) {
  return `${glyph} ${displayName(name)}`;
}

export function tabNameOf(label: string) {
  const glyphs = Arr.join([...Rec.values(GLYPH), COLLIE_GLYPH], "");
  return Str.trim(pipe(label, Str.replace(new RegExp(`^[${glyphs}]\\s*`, "u"), "")));
}

export function disambiguate(name: string, target: string) {
  return target ? `${name} · ${target}` : name;
}

export function agentTabLabel(ask: { role: string; operation: string; agent: string | null }) {
  const step =
    ask.agent === null
      ? pipe(
          ask.operation,
          Str.slice(Option.getOrElse(pipe(ask.operation, Str.lastIndexOf(".")), () => -1) + 1),
        )
      : "";
  return disambiguate(displayName(ask.role), step);
}

function shortModel(model: string) {
  return pipe(model, Str.slice(Option.getOrElse(pipe(model, Str.lastIndexOf("/")), () => -1) + 1));
}

export function paneLabel(
  variant: { harness: string; model: string },
  stepId: string,
  variantCount: number,
  sharesTab: boolean,
) {
  if (variantCount > 1) {
    const name = variant.model === DEFAULT_MODEL ? variant.harness : shortModel(variant.model);
    return displayName(name);
  }
  return sharesTab
    ? displayName(
        pipe(stepId, Str.slice(Option.getOrElse(pipe(stepId, Str.lastIndexOf(".")), () => -1) + 1)),
      )
    : null;
}

export function evenRatio(index: number, count: number) {
  return 1 / (count - index + 1);
}

export function runTitle(run: { readonly workflow: string; readonly settled: Settled }) {
  const target = diffTargetOf(run.settled)?.value ?? "";
  return disambiguate(displayName(run.workflow), targetLabel(run.workflow, "", target));
}

export function taskWorkspaceLabel(name: { project: string; title: string }) {
  return Arr.join(
    Arr.filter([displayName(oneLine(name.project)), oneLine(name.title)], (part) => part !== ""),
    " | ",
  );
}

export function taskTitleOf(label: string) {
  const at = Option.getOrElse(pipe(label, Str.indexOf(" | ")), () => -1);
  return at < 0 ? label : pipe(label, Str.slice(at + 3));
}

export function oneLine(text: string) {
  return Str.trim(pipe(text, Str.replace(/\p{Cc}/gu, " "), Str.replace(/\s+/g, " ")));
}
