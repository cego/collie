// WARNING: a Task's spec is read by the Plan view alone; nothing here decides what a Run may do.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Result } from "effect";
import { afterMergeIn, checksIn, criteriaIn } from "./plan";

export interface SpecTicket {
  // WARNING: the ticket's one number however it was padded, so `3` is `03` in every revision.
  readonly id: string;
  readonly title: string;
  readonly blockedBy: ReadonlyArray<string>;
  readonly criteria: ReadonlyArray<string>;
  readonly afterMerge: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<string>;
  readonly text: string;
}

export interface SpecRevision {
  readonly task: string;
  readonly revision: number;
  readonly at: string;
  readonly actor: string;
  readonly rationale: string | null;
  readonly text: string;
  readonly tickets: ReadonlyArray<SpecTicket>;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const TICKETS = /^##\s+tickets\s*$/i;
const TICKET = /^###\s+(?:0*(\d+)\s*[:.-]?\s*)?(.*?)\s*$/;

export const ticketNumber = (raw: string) => /^0*(\d+)/.exec(raw)?.[1] ?? raw;

const headingLevel = (line: string) => HEADING.exec(line)?.[1]?.length ?? 0;

const sectionAfter = (text: string, heading: RegExp) => {
  const lines = Str.split(text, "\n");
  const at = Arr.findFirstIndex(lines, (line) => heading.test(line));
  if (at._tag === "None") {
    return null;
  }
  const level = headingLevel(lines[at.value] ?? "");
  const rest = lines.slice(at.value + 1);
  const end = Arr.findFirstIndex(
    rest,
    (line) => headingLevel(line) > 0 && headingLevel(line) <= level,
  );
  return end._tag === "Some" ? rest.slice(0, end.value) : rest;
};

const printed = (lines: ReadonlyArray<string>) =>
  pipe_(
    Arr.filter(Arr.map(lines, Str.trim), (line) => line !== ""),
    (kept) => Arr.join(kept, " "),
  );

export const objectiveIn = (text: string) =>
  Str.trim(printed(sectionAfter(text, /^#+\s+objective\b/i) ?? []));

export function doneIn(text: string) {
  const section = sectionAfter(text, /^#+\s+done when\b/i);
  const returned: string | null = section === null ? null : printed(section) || null;
  return returned;
}

const blockersIn = (body: string) => {
  const said = Str.trim(/\*\*Blocked by:\*\*\s*(.*?)\s*$/m.exec(body)?.[1] ?? "");
  const ids = Arr.filter(
    Arr.map(Str.split(said, /[\s,;]+/), (word) =>
      pipe_(word, Str.replaceAll(/^[([{'"]+|[)\]}'".:]+$/g, "")),
    ),
    (word) => /^\d+$/.test(word),
  );
  return Arr.map(ids, ticketNumber);
};

export const requirementsIn = (text: string) =>
  Arr.filterMap(sectionAfter(text, /^#+\s+requirements\b/i) ?? [], (line) =>
    line === "" ? Result.failVoid : Result.succeed(line),
  );

export function ticketsInSpec(text: string) {
  const section = sectionAfter(text, TICKETS);
  if (section === null) {
    const none: Array<SpecTicket> = [];
    return none;
  }
  const blocks: Array<{ heading: string; body: Array<string> }> = [];
  let open: { heading: string; body: Array<string> } | null = null;
  for (const line of section) {
    const found = TICKET.exec(line);
    if (found !== null && headingLevel(line) === 3) {
      open = { heading: line, body: [] };
      blocks.push(open);
      continue;
    }
    open?.body.push(line);
  }
  const returned = Arr.filterMap(blocks, (block) => {
    const found = TICKET.exec(block.heading);
    const digits = found?.[1];
    if (found === null || digits === undefined) {
      return Result.failVoid;
    }
    const body = Arr.join(block.body, "\n");
    const identity: SpecTicket = {
      id: ticketNumber(digits),
      title: Str.trim(found[2] ?? ""),
      blockedBy: blockersIn(body),
      criteria: criteriaIn(body),
      afterMerge: afterMergeIn(body),
      checks: checksIn(body),
      text: Str.trim(body),
    };
    return Result.succeed(identity);
  });
  const kept: Array<SpecTicket> = returned;
  return kept;
}

export interface SectionChange {
  readonly heading: string;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export interface TicketChange {
  readonly id: string;
  readonly title: string;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export interface SpecComparison {
  readonly from: number;
  readonly to: number;
  readonly rationale: string | null;
  readonly sections: ReadonlyArray<SectionChange>;
  readonly addedTickets: ReadonlyArray<SpecTicket>;
  readonly removedTickets: ReadonlyArray<SpecTicket>;
  readonly changedTickets: ReadonlyArray<TicketChange>;
}

const sectionsOf = (text: string) => {
  const found: Array<{ heading: string; lines: Array<string> }> = [{ heading: "", lines: [] }];
  for (const line of Str.split(text, "\n")) {
    if (headingLevel(line) === 1 || headingLevel(line) === 2) {
      found.push({ heading: Str.trim(HEADING.exec(line)?.[2] ?? ""), lines: [] });
      continue;
    }
    found.at(-1)?.lines.push(Str.trim(line));
  }
  const kept: Array<{ heading: string; lines: Array<string> }> = [];
  for (const one of found) {
    kept.push({ ...one, lines: Arr.filter(one.lines, (line) => line !== "") });
  }
  return kept;
};

// WARNING: compared as a multiset of lines, so a line moved within its section is not a change.
const difference = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) => {
  const counted = new Map<string, number>();
  for (const line of before) {
    counted.set(line, (counted.get(line) ?? 0) + 1);
  }
  const added: Array<string> = [];
  for (const line of after) {
    const left = counted.get(line) ?? 0;
    if (left > 0) {
      counted.set(line, left - 1);
    } else {
      added.push(line);
    }
  }
  const repeated = Arr.filterMap([...counted.entries()], ([line, count]) =>
    count > 0 ? Result.succeed(Arr.map(Arr.range(1, count), () => line)) : Result.failVoid,
  );
  return { added, removed: Arr.flatten(repeated) };
};

export const compareSpecs = (before: SpecRevision, after: SpecRevision) => {
  const was = new Map(Arr.map(sectionsOf(before.text), (one) => [one.heading, one.lines] as const));
  const now = sectionsOf(after.text);
  const sections: Array<SectionChange> = [];
  for (const one of now) {
    const previous = was.get(one.heading) ?? (one.heading === "" ? [] : []);
    was.delete(one.heading);
    const change = difference(previous, one.lines);
    if (change.added.length > 0 || change.removed.length > 0) {
      sections.push({ heading: one.heading, added: change.added, removed: change.removed });
    }
  }
  for (const [heading, lines] of was) {
    if (lines.length > 0) {
      sections.push({ heading, added: [], removed: lines });
    }
  }
  const ids = (one: SpecRevision) => new Set(Arr.map(one.tickets, (ticket) => ticket.id));
  const before_ = ids(before);
  const after_ = ids(after);
  const keeping = new Map(Arr.map(before.tickets, (ticket) => [ticket.id, ticket] as const));
  const changedTickets: Array<TicketChange> = [];
  for (const ticket of after.tickets) {
    const prior = keeping.get(ticket.id);
    if (prior === undefined) {
      continue;
    }
    const change = difference(Str.split(prior.text, "\n"), Str.split(ticket.text, "\n"));
    if (change.added.length > 0 || change.removed.length > 0) {
      changedTickets.push({
        id: ticket.id,
        title: ticket.title,
        added: change.added,
        removed: change.removed,
      });
    }
  }
  return {
    from: before.revision,
    to: after.revision,
    rationale: after.rationale,
    sections,
    addedTickets: Arr.filter(after.tickets, (ticket) => !before_.has(ticket.id)),
    removedTickets: Arr.filter(before.tickets, (ticket) => !after_.has(ticket.id)),
    changedTickets,
  } satisfies SpecComparison;
};
