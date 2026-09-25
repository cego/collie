# Authoring workflows and personas

Every workflow and persona Collie ships is a starting point, not a restriction. This page
is where they live, how a fork follows its parent, and every key a persona accepts. For
what a Workflow, an operation, a Persona, a Layer or an Override _is_, see
[`CONTEXT.md`](../CONTEXT.md).

**A workflow is a TypeScript module.** Every workflow Collie ships is one, with its prompts
in the Markdown beside it, and yours is the same kind of thing — [the SDK](sdk.md) is the
reference for writing one, and the rest of this page is about where modules and personas
live and how they are customized.

## Writing one

```sh
collie workflow create tally           # a runnable module, in your own layer
collie workflow check tally            # loaded, constructed and typechecked
collie workflow list                   # it is there, with nothing registered by hand
collie run start tally --input note=hi
```

`create` writes `~/.collie/user/workflows/tally.workflow.ts` — `--layer project` writes
`.collie/workflows/` instead — and provisions the setup to typecheck it beside the file:
`package.json`, `tsconfig.json` and `collie.d.ts`, installed with the executable's
own embedded Bun, so a machine with neither Bun nor Node can still compile a module. What
the setup needs is merged into a `package.json` or `tsconfig.json` you already have — the
`typescript` it lacks, `collie` mapped to `collie.d.ts`, and the `effect` the host runs,
which replaces any other version of it — and nothing else of yours is replaced. With no network on a first use the answer is
`toolchain_unavailable`: the module still runs, and nothing was typechecked.

`check` is the loop's other half. It imports the module, constructs it and runs the
compiler over it, and never starts a run, takes an agent or opens a worktree. It keeps
three answers apart: a problem stops the module running, `drawn without:` is a place the
JSON Schema drawn for a prompt says less than your schema does, and `ok, not typechecked`
means no compiler is installed in that directory.

Modules are ordinary executable code you chose to save. Importing one to describe it runs
its top level, which is yours: this is trust, not a sandbox.

## Layers and lookup order

Three directories, nearest first. The same id in a nearer one wins:

| Layer   | Directory                 | Workflow modules          | Personas    |
| ------- | ------------------------- | ------------------------- | ----------- |
| project | `.collie/` in the project | `workflows/*.workflow.ts` | `personas/` |
| user    | `~/.collie/user/`         | `workflows/*.workflow.ts` | `personas/` |
| shipped | the install, `~/.collie/` | `workflows/*.workflow.ts` | `personas/` |

The project's `.collie/` and your `~/.collie/user/` have the same shape, and hold the rest
of what is yours beside them: `verify.json` in each, and your `config.json` in
`~/.collie/user/`. Your layer sits beside the installation's shipped assets rather than
among them, because those are a git checkout an upgrade fast-forwards — `user/` is ignored
by it, so nothing of yours is somebody else's to move. What Collie itself keeps — runs, the
host's database, tasks — is state, and stays in herdr's state directory for the plugin.

Only entry files take part. A helper or a Markdown prompt beside one is reached because
your entry imports it, never because it was found. Two files in one layer claiming one id
are both refused, each naming the other, and an override that does not compile refuses its
own id rather than falling through to the module it was written to replace.

A module that runs another as a child looks it up the same way, so overriding one changes
every module that runs it.

`collie workflow list` prints the layer each one came from, and `collie workflow check`
validates every layer without starting a run.

## Editing, and what a run in flight is on

Save a file and new work uses it: nothing to register, no rebuild, no host to restart. Your
entry, the helpers it imports and the Markdown it reads are one thing — the directory a
generation is staged from, and whatever it imports by a relative path from outside it — so
editing any of them sends the next run to a new registration
while a run already going keeps the code it started on. A run recovered in the same host
resumes on its own registration; a host started again rebuilds registrations from the
modules **as they are now**, so a file you fixed is the file it comes back on. Any staged
copy is a cache, and never an archive a past run is recovered from: a host wipes its own on
start, and a listing reads each revision from a copy in your own cache
(`$XDG_CACHE_HOME/collie/entries`, else `~/.cache/collie/entries`), so what an edited helper
exports is what the next listing says. That directory is read as code, so Collie refuses it
while another account owns it or can write to it. A
package is found from a staged copy exactly as from your file: the `node_modules` it would
look in are linked beside the copy, not copied, and the `package.json` files above your
code are copied with it, so a `#` import resolves as it does for you. Editing one of those
is an edit; a package installed without changing one is not.

Deleting a file takes its id away, and putting it back brings it — and any run waiting on
it — back.

## Dependencies and services

A module imports `collie` for what the host lends it, `effect` for everything else,
and whatever else it needs through the same directory's `package.json` — the toolchain is
Bun's, so `bun add <package>` in that directory is the whole of it. The `effect` version
`create` pins is the one the host runs; they have to be the same Effect, or your types are
about a different one.

A service your module invents is supplied by your own Layer, explicitly provided. Merging
siblings supplies nothing. Two projects with a module of the same id are two Layers that
never meet, and a service is its key rather than the file that declared it — so an override
in one project satisfies the same contract the original did, for the modules that asked for
it and no others.

## Forking

`prefix+shift+f`, the Control Plane's `f` key, and `collie workflow fork` /
`collie persona fork` all put a copy in your layer (`--layer user`) or the project's
(`--layer project`), under the id `--name` gives it.

Forking a **module** writes a file that imports the original's definition and spreads it
under the new id, so everything the fork does not name is still the original's and a
baseline change reaches it.
Where a shipped module expects to be varied it takes the varying parts as ordinary
functions or a service, and your fork supplies its own; [the SDK](sdk.md) has a worked one.
There is no step to merge, so `--mode` and `--step` are refused on a module with what to do
instead.

Forking a **persona** copies it whole, or writes a stub that declares `extends: <name>` and
replaces only the sections it names. A `copy` records `forked_from_hash` — the parent's
content hash at the moment of the copy — so when the original moves on the picker can mark
the fork `(stale — the original has changed since this copy)`. A stale fork still works;
the mark tells you a change has passed it by.

## Persona frontmatter

A persona is much smaller: instructions injected when an agent starts, harness-agnostic and
never installed as harness-native config.

| Key                | Type   | What it does                                                |
| ------------------ | ------ | ----------------------------------------------------------- |
| `name`             | string | How steps refer to it. Defaults to the filename.            |
| `description`      | string | One line for the picker.                                    |
| `extends`          | string | Follow another persona and replace only the sections named. |
| `forked_from_hash` | string | Written by a `copy` fork. Do not write it by hand.          |

The body is the persona. Sections merge by name, so a fork can replace `## Output` and keep
everything else. A persona is told nothing but where its skills are: `{{skill:name}}` is the
only expression it may use, `collie doctor` names a persona using any other, and a Run
launching an agent as one parks until the file is fixed.

## Skills

Workflows and personas name the skills they drive, and there are two ways to refer to one.

**A mention** is what an agent reads. `{{skill:code-review}}` in a prompt or a persona
renders the skill's name and the file to read, identically for every harness:

```
the `code-review` skill (read `/home/you/.agents/skills/code-review/SKILL.md` and follow it)
```

A path is a path — nothing expands a slash command inside a file a model is handed — so a
mention is never harness-specific. A skill that is not installed says so in the same place,
`(not installed here)`, which is what a persona's fallback paragraph is for.

**A command** is what the human channel types to _start_ a skill, and that is
harness-specific: `/code-review` for `claude`, `/skill:code-review` for `pi`, and
`the "code-review" skill` for `codex` and `opencode`, which surface skills by description. A
step's `skill:` key is sent that way, which is the only way to run a skill that refuses to
be started by the model itself.

So a module never spells either form: name the skill in the work it asks for, and the same
module works on every harness.

Skills are a prerequisite, like the harness binary. `collie doctor` says whether the store
is there and what puts it back; `.agents/skills` in the project you are in is checked
first, then `~/.agents/skills`.

## Harnesses, models and effort

| Harness    | Model flag                 | Persona                                                  | Effort                                                   | Unattended switch                            |
| ---------- | -------------------------- | -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| `claude`   | `--model`                  | `--append-system-prompt-file`                            | `--effort low\|medium\|high\|xhigh\|max`                 | `--permission-mode bypassPermissions`        |
| `codex`    | `-m`                       | prompt prefix                                            | —                                                        | `--dangerously-bypass-approvals-and-sandbox` |
| `pi`       | `--model <provider/model>` | `--append-system-prompt` (reads the persona file's path) | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` | none — pi has no tool-approval prompt        |
| `opencode` | `--model <provider/model>` | prompt prefix                                            | —                                                        | `--auto`                                     |

`claude` accepts `fable`, `opus`, `sonnet`, `haiku`, `opusplan` and any `claude-…` id. `codex`
accepts `gpt-5-codex`, `gpt-5`, `gpt-5-mini` and any `gpt…`/`o…` id. `pi` and `opencode`
take provider-qualified ids (`openai-codex/gpt-5.6-sol`). Add more with `models` in your
`config.json`.

`model: default` is accepted by every harness and uses its adapter's pinned default. Claude
pins that default to `opus`, so every base Claude agent receives `--model opus`; adapters
without a pinned default omit the model flag. Effort is optional — leave it out and each
harness uses its own default.

Which harness, model and effort a piece of work gets is decided layer over layer: your
configuration, then the workflow's own `agents`, then a Run's `--harness`, `--model` and
`--effort`, then a `withAgents` scope around the work, then the work's own options. A layer
that switches harness keeps nothing chosen for the one below, and a combination the harness
does not take is refused rather than replaced. [The SDK](sdk.md#which-agent-does-the-work)
has the whole of it.

The unattended switch is passed unless `permissions` says `harness`, in your `config.json`
or on the operation; see [Permissions](using.md#permissions-unattended-by-default) for what it
means. pi's column says none because it does not ask before a tool call — its `--approve`
only trusts project-local files — so `bypass` and `harness` start it identically.

A module asks for one piece of work at a time and says what that piece needs, so an
operation that should ask is the one that asks for `permissions: "harness"`.

The mode is settled when an agent starts, so work handed to an agent that is already
running keeps the mode that agent was started in. An unknown harness, model, effort or
permissions mode is refused before a single tab opens.

## Worked example: a reviewer on another harness

The canonical fork. You want one reviewer on a different harness, and nothing else changed.
`collie workflow fork review --layer user --name review` writes a module that spreads the
original's definition; you change the one thing you came to change — here
`agents: { harness: "codex", model: "gpt-5" }` — and leave the rest importing.

Check it before you rely on it:

```sh
collie workflow check review      # loads it, constructs it and typechecks it
collie workflow show review       # what it takes, what it gives back, and where it is
```

## YAML in a persona's frontmatter

A persona's frontmatter is parsed as YAML 1.2 — block and flow collections, quoted and block scalars,
anchors and aliases. Four things to know:

- A value with `: ` inside it has to be quoted, as YAML 1.2 requires. `description: your
call: fix it` is refused; `description: "your call: fix it"` is the same text as a string.
- A key may not be set twice in one mapping. `a: 1` over `a: 2` is an error where the
  parser Collie used before this took the last value, so a definition that relied on that
  needs the duplicate removed.
- Date-like values stay strings, which is what `forked_from_hash` and version-shaped inputs
  need.
- The parser is close to YAML 1.2's core schema without being conformant to it: `.inf` and
  `.nan` read as null, and `1_000` as `1000`. No persona key takes any of those, so this
  matters only if you were relying on one.
