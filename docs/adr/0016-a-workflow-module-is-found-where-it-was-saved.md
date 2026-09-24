# A workflow module is found where it was saved

**Status: accepted, and proven rather than argued.** The lookup is `src/discovery.ts`, the
proofs are `test/discovery.test.ts` and `test/autoload.test.ts`, and the host that uses it
is the one in [ADR-0015](0015-one-local-host-owns-a-state-directory.md).
[ADR-0014](0014-native-workflows-run-on-effects-own-engine.md) decided that a module is
code Effect runs; this is how that code is found, and when a change to it takes effect.

An author saves a file. Nothing else should be needed: no registration list to edit, no
rebuild, no host to restart. And one public id has to be able to mean different things in
different projects, because a project override is the point of having one.

## Decision

**D1. Three directories, nearest first.** `.collie/workflows` in the project, then
`user/workflows` beside the installation — `~/.collie/user/workflows` for a standard
install — then the `workflows/` Collie ships. It is the order the Markdown definitions
already use, so there is one thing to learn rather than two.

**D2. The file name shadows, and the module's `id` is what an operator types.** A file that
cannot be read claims the id its name says it is: `review.workflow.ts` that does not compile
refuses `review` and names itself, rather than quietly running the module it was written to
replace. Two files in one layer claiming one id are both refused, each naming the other —
an ambiguity is a mistake to fix, not a coin to toss on the author's behalf.

**D3. An edit is a change to the directory, and new work gets it.** A generation is staged
from the entry's whole directory, so the revision that identifies one is a digest of that
directory: an edited helper or Markdown prompt counts exactly as much as an edited entry.
New work goes to the generation built from the revision on disk — unchanged, that is the
one already registered; edited, it is a new registration beside it. What is already running
keeps the code it started on, and no reload deregisters anything.

**D4. Discovery reads; it does not build.** Listing what is here imports each entry to ask
what it says it is, and never calls `make` — so nothing is constructed, no Layer is built,
no agent or worktree is acquired. Importing does run the module's own top level, which is
the author's code by definition; this is not a sandbox and does not pretend to be one.

**D5. Which project is asking travels with the request.** One host serves a whole machine,
so the project layer is answered per request. The installation's own two layers are the
host's, named by the client that started it, which keeps a host serving the installation
whose client needed it rather than whatever directory the process happened to start in.

**D6. The author's directory is outside the shipped assets, and the checkout ignores it.**
`collie upgrade` fast-forwards this repository. A workflow saved inside its tracked files
would be something a pull has an opinion about, and this way nothing an author writes ever
is.

## What this does not decide

Where `create` and `fork` write, and what an authoring command lists: the same policy, and
a later ticket. Nor the Markdown definitions' own layers, which are unchanged
([`authoring.md`](../authoring.md)) — the two do not mix until the shipped workflows are
converted. There is no watcher: each start reads the search path, which is what makes an
addition, an edit and a deletion all the same thing.

## Consequences

- A start costs three directory listings and a digest of each. That is the price of having
  no cache to invalidate and no daemon state to get stale.
- Registration is serialised inside a host: two clients starting different modules of one
  id at the same moment would otherwise mint one name for both and stage over each other.
- A module imported to be listed has its top-level code run, so an author's `console.log`
  at the top of a file happens when the workflow is merely listed.
- A toolchain provisioned beside a module counts by its file names, not their contents:
  installing a dependency is a change, editing one inside `node_modules` is not.
