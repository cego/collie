# A human's start is placed, never asked where; an agent's start names everything

The Home has no checkout (ADR-0009), so a start from it used to ask "Which checkout?" and
take a typed path. The human describes the work and nothing else; where it happens is
Collie's to work out. An agent is the opposite case: it does not notice what was quietly
filled in for it, and it is happy to supply as much as a successful Run needs.

## Decision

The **Launch flow** — the human's front door — asks which Workflow and what the human
wants. The words fill the Workflow's **launch Input**: the one field it hints with `goal`,
`work-source`, `diff-target` or `gitlab-repository`, a declaration and never a name
(ADR-0029). Where the words are a value of that Input's kind — a plan directory, a Linear
issue or a description for a work source; a merge request URL, an iid or a branch for a
diff target; a URL or a path for a repository — they are the Input. Otherwise they say
where the work is, and the Input is set from where the Run lands.

Outside the Home the Run starts in the checkout the human is in, as before. From the Home:

- A Workflow whose launch Input is a `goal` (`plan`, `architecture`) is rooted at the
  **Projects root** — a configured `projects.root`, else the gitte folder, else `$HOME` —
  and its prompt says so: the root is not a repository, and the agent finds the
  repositories itself. A plan's `Repo:` lines are paths under it, so the fan-out places
  each Repo run as it already does.
- A Workflow whose launch Input is a work source, a diff target or a repository
  (`implement`, `review`, `renovate`) needs a checkout whether or not it cuts one of its
  own, and is placed from the human's words: a merge request or repository URL is matched
  to a checkout under the Projects root by its remote; failing that, one isolated model
  call picks from the git checkouts there, and the human confirms with Enter. Words that
  span repositories, or match none, are offered as a plan instead.

The git checkouts under the Projects root are the directories with a `.git` directory,
found to a bounded depth with nothing under a checkout descended into; a `.git` file is a
worktree and is not one of them.

What the Launch flow inferred is shown in one line before the Run starts and recorded on
the Run beside what the human gave.

An agent's start — chat's Collie tools and `collie run start`, always — gets none of
this: it names its checkout (or `projects-root`) and every declared Input, an optional one
as an explicit empty. A `collie run start` run inside a git checkout has named it; one run
anywhere else has not. One missing is refused, listing each missing field and the facts
that would fill it, so the agent passes them back explicitly. An Input a Run's own agent
is not given is said to be not given in its prompt, never dropped.

## Considered options

- One placement for every front door, routing agents' starts too: an agent never learns
  that a checkout was chosen for it, which is how silent guesses have gone wrong before.
- Strict only when there is no terminal: a heuristic, and a human at the CLI can type.
- Route every human start through a model call, `plan` included: one checkout cannot hold
  work that spans repositories, and the plan's own `Repo:` lines decide it better.
- Cut the checkout inside the Run, after an agent names the repository: uniform with
  `plan`, but it undoes admission-time checkouts across the engine. The router can be
  replaced by this later without changing what the human sees.
- Sort Workflows by whether they declare a checkout: `review` declares none and still
  cannot run at the Projects root. The launch Input's strategy is the declaration that
  says what the words are, so it is the one that says where they go.

## Consequences

A plan's working directory can be the Projects root, not a repository, and its tickets
then name repositories relative to it. `collie doctor` says which Projects root is in use
and where it came from, since a host started without `GITTE_CWD` falls back to `$HOME`.
Chat and scripts write longer starts than a human does; that is the point. `goal` becomes
an exclusive strategy like the other three, so a module has one launch Input or is refused
at check.
