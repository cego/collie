import * as Arr from "effect/Array";
import * as Option from "effect/Option";

export interface ComparedSection {
  readonly heading: string;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export interface ComparedTicket {
  readonly id: string;
  readonly title: string;
  readonly blockedBy: ReadonlyArray<string>;
}

export interface Comparison {
  readonly from: number;
  readonly to: number;
  readonly rationale: string | null;
  readonly sections: ReadonlyArray<ComparedSection>;
  readonly addedTickets: ReadonlyArray<ComparedTicket>;
  readonly removedTickets: ReadonlyArray<ComparedTicket>;
}

const padded = (id: string) => (id.length < 2 ? `0${id}` : id);

const ticketLine = (ticket: ComparedTicket) =>
  `${padded(ticket.id)} ${ticket.title}${
    ticket.blockedBy.length === 0
      ? ""
      : ` (blocked by ${Arr.join(Arr.map(ticket.blockedBy, padded), ", ")})`
  }`;

// WARNING: the view says which revision it is showing, so a revision opened from an old Activity link cannot be mistaken for the current one.
export const comparisonLines = (comparison: Comparison) =>
  Arr.join(
    Arr.map(
      [
        [
          `Revision ${comparison.from} → ${comparison.to}`,
          ...(comparison.rationale === null ? [] : [`Why: ${comparison.rationale}`]),
        ],
        Arr.map(comparison.sections, (section) =>
          Arr.join(
            [
              section.heading === "" ? "(intro)" : section.heading,
              ...Arr.map(section.added, (line) => `+ ${line}`),
              ...Arr.map(section.removed, (line) => `- ${line}`),
            ],
            "\n",
          ),
        ),
        Arr.map(comparison.addedTickets, (ticket) => `+ ${ticketLine(ticket)}`),
        Arr.map(comparison.removedTickets, (ticket) => `- ${ticketLine(ticket)}`),
      ],
      (part) => Arr.join(part, "\n"),
    ),
    "\n\n",
  );

export const revisionLine = (input: {
  readonly revision: number;
  readonly at: string;
  readonly actor: string;
}) => `Revision ${input.revision} · ${input.actor} · ${input.at}`;

// WARNING: a view of one revision is that revision's tickets, never the current ones.
export const ticketsOfRevision = (
  revisions: ReadonlyArray<{
    readonly revision: number;
    readonly tickets: ReadonlyArray<ComparedTicket>;
  }>,
  revision: number,
) =>
  Option.match(
    Arr.findFirst(revisions, (one) => one.revision === revision),
    { onNone: () => [], onSome: (one) => one.tickets },
  );
