// Step Outputs are JSON files in the run dir. Gates and loops read these,
// never terminal text (docs/SPEC.md).

export interface Finding {
  file?: string;
  line?: number;
  severity: string;
  title: string;
  detail?: string;
  /** A reviewer's answer to the implementer's reason for disputing this finding. */
  rebuttal?: string;
}

export interface ReviewOutput {
  verdict: "clean" | "findings";
  findings: Finding[];
  disputed: Finding[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseReviewOutput(text: string, where: string): Parsed<ReviewOutput> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `${where}: not valid JSON (${(e as Error).message})` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${where}: expected a JSON object` };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.verdict !== "clean" && obj.verdict !== "findings") {
    return { ok: false, error: `${where}: verdict must be "clean" or "findings", got ${JSON.stringify(obj.verdict)}` };
  }
  const findings = parseFindings(obj.findings, `${where}: findings`);
  if (!findings.ok) return findings;
  const disputed = parseFindings(obj.disputed, `${where}: disputed`);
  if (!disputed.ok) return disputed;
  if (obj.verdict === "findings" && findings.value.length === 0) {
    return { ok: false, error: `${where}: verdict "findings" with an empty findings list` };
  }
  return { ok: true, value: { verdict: obj.verdict, findings: findings.value, disputed: disputed.value } };
}

export function parseFindings(raw: unknown, where: string): Parsed<Finding[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `${where}: expected an array` };
  const out: Finding[] = [];
  for (const [i, item] of raw.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `${where}[${i}]: expected an object` };
    }
    const o = item as Record<string, unknown>;
    if (typeof o.title !== "string" || o.title.trim() === "") {
      return { ok: false, error: `${where}[${i}]: title is required` };
    }
    if (typeof o.severity !== "string" || o.severity.trim() === "") {
      return { ok: false, error: `${where}[${i}]: severity is required` };
    }
    const finding: Finding = { severity: o.severity, title: o.title };
    if (typeof o.file === "string") finding.file = o.file;
    if (typeof o.line === "number") finding.line = o.line;
    if (typeof o.detail === "string") finding.detail = o.detail;
    if (typeof o.rebuttal === "string") finding.rebuttal = o.rebuttal;
    out.push(finding);
  }
  return { ok: true, value: out };
}

/**
 * What makes two findings the same finding. The line is deliberately left out: it
 * moves as the branch is fixed, and a dispute has to survive that to ever settle.
 */
export function findingKey(f: Finding): string {
  return `${f.file ?? ""}::${f.title.trim().toLowerCase()}`;
}

/** Fan-in: the union of every reviewer's findings, deduplicated. */
export function unionFindings(outputs: ReviewOutput[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const o of outputs) {
    for (const f of o.findings) {
      const key = findingKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

export interface Split {
  /** What the fix step still has to act on. */
  live: Finding[];
  /** Already disputed, raised again with no answer: the human decides, not the loop. */
  settled: Finding[];
  /** Disputes a reviewer answered, so they are back in front of the implementer. */
  rebutted: Finding[];
}

/**
 * A finding the implementer has already rejected with a reason cannot be settled by
 * another round of the same two agents — only by the human. So it stops driving the
 * loop, unless a reviewer answers the reason with a `rebuttal`.
 */
export function splitDisputed(findings: Finding[], disputed: Finding[]): Split {
  const known = new Set(disputed.map(findingKey));
  const split: Split = { live: [], settled: [], rebutted: [] };
  for (const finding of findings) {
    if (!known.has(findingKey(finding))) {
      split.live.push(finding);
    } else if (finding.rebuttal) {
      split.live.push(finding);
      split.rebutted.push(finding);
    } else {
      split.settled.push(finding);
    }
  }
  return split;
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "(none)";
  return findings
    .map((f) => {
      const at = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      const detail = f.detail ? `\n  ${f.detail.replace(/\n/g, "\n  ")}` : "";
      const rebuttal = f.rebuttal ? `\n  answers your dispute: ${f.rebuttal.replace(/\n/g, "\n  ")}` : "";
      return `- [${f.severity}] ${f.title}${at}${detail}${rebuttal}`;
    })
    .join("\n");
}
