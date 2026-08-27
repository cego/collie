# 04: review end to end (standalone)

**What to build:** Pick `review`; target inferred MR → branch diff → working tree; reviewer Persona writes review.json (verdict + findings) to the run dir and a summary in the tab; posting to GitLab only with post: true.

**Blocked by:** 03

**Status:** done

- [x] diff-target inference order tested against fake glab/git
- [x] review.json validated against the Output schema
- [x] post defaults to false

**Notes:** `diff-target` inference order is glab open MR (`mr:<iid>`) -> branch vs the
default base (`branch:<base>...<head>`) -> `worktree`, tested against fake `glab`/`git`
put in front of PATH. A merge request that is not open is skipped. Missing `glab` or
`git` falls through instead of failing.

Every declared Output must be a JSON object; one with a `verdict` key is validated
against the review Output schema, so a gate can always read it. Anything else is
opaque JSON a later step can template in via `{{outputs.<step>}}`.

`post` is a `flag` input: always inferred as `false`, never asked, so posting to
GitLab cannot happen by accident.

Found while testing: `Bun.spawn` does not honour a mutated `process.env.PATH` unless
the env is passed explicitly, so `inputs.ts` and `herdr.ts` both pass `env`.
