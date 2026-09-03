# Collie

Collie codifies agent workflows for herdr — `plan`, `implement`, `review`, `architecture` —
as markdown definitions executed by one Effect v4 program with two front doors: herdr
actions, and the `collie` CLI.

## Where to look

- **A term you are unsure of, or one you are about to redefine** → [`CONTEXT.md`](CONTEXT.md).
  It is canonical for vocabulary; docs pages link to it rather than restating a definition.
- **Which file owns what** → [`src/README.md`](src/README.md).
- **Changing workflow or persona frontmatter, `extends:`/`use:` merge semantics, or layer
  lookup** → [`docs/authoring.md`](docs/authoring.md), alongside `src/definitions.ts`.
- **Changing the CLI surface, an error code, or a `--json` envelope** →
  [`docs/cli.md`](docs/cli.md), alongside `src/envelope.ts` and `src/operations.ts`.
- **Adding a herdr call, or a red `contract:stable` pipeline** →
  [`docs/internals.md`](docs/internals.md#checking-the-boundary-against-herdr), alongside
  `herdr-pin.json` and `test/herdr-contract.test.ts`.
- **Changing how a run is executed, coordinated, or recorded** →
  [`docs/internals.md`](docs/internals.md) and [`docs/adr/`](docs/adr).
- **Changing install, keybindings, the Control Plane, or a toast** →
  [`docs/using.md`](docs/using.md).

## Commands

`package.json` scripts are the source of truth — read them there rather than from here.

The one pairing they do not record: before touching anything on the release or install
path, run `bun run build && bun run smoke`. The build alone does not prove the compiled
binary still starts.

## Invariants

1. Every capability ships in both front doors: the CLI and the herdr actions are thin
   adapters over the same Effect services ([ADR-0003](docs/adr/0003-collie-is-one-effect-program.md)).
2. All herdr communication goes through `src/herdr.ts`. The one exception is
   `tools/herdr-schema.ts`, which runs a downloaded release offline to print its schema
   and never touches the session — see [`docs/internals.md`](docs/internals.md#the-herdr-boundary).
3. One Driver owns a run's state. Mutate a run through the schema-validated inbox with
   request ids ([ADR-0004](docs/adr/0004-coordinate-runs-through-the-filesystem.md)).
4. Plan artefacts live in the run directory ([ADR-0002](docs/adr/0002-plan-artefacts-live-in-the-run-directory.md)).
   Glossary and ADR changes belong in the repository.
5. Definition merge semantics (`extends:`, `use:`, layers) are canonical in
   `src/definitions.ts` and `docs/authoring.md` — change both together.
6. Docs change in the same merge request as the behavior they describe.
