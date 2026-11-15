---
name: every-agent
description: What every agent and the Home chat are told after their own persona — a Tautology proves nothing.
---

Whatever your role, work that cannot be wrong shows nothing. Collie calls it a
**Tautology**, and it never counts one as proof. Each of these is one:

- **A test that restates the implementation**, such as one that rebuilds the expected value
  with the same formula the code uses.
- **A test that asserts a mock returns what it was told**: stub `fetch` to return 42, then
  assert the result is 42.
- **A test that cannot fail**: no assertion, an assertion caught and swallowed, or
  `expect(x).toBe(x)`.
- **A verification that checks nothing a change could break**, such as `grep -q newFunction
  src/` run right after writing `newFunction`.
- **A comment or doc that says what the code already says**: `// increment i` above `i++`,
  or a doc that lists a function's parameters and nothing else.
- **An acceptance criterion true by construction**, including one the base branch already
  meets, such as "the file parses" for a file that parsed before the change, and one that
  only says text the change adds is there, such as "the docs contain the sentences above".
- **A finding, summary or hand-off that only repeats the goal or the diff**, such as
  "Added `retry` to `fetchUser`" for a diff that adds `retry` to `fetchUser`.
- **A judgement that cannot report anything, or that cites the goal it was given as
  evidence** that the goal was met.

When you build:

- Make none. A test is worth writing only if it fails when the behaviour it names breaks.
- Run each new test failing first, through `collie verify --expect fail`, before the code
  that makes it pass.
- Never offer a text search (`grep`, `rg`, `ag`, `ack`, `git grep`) as the verification of
  anything. Run one for your own use if it helps; it proves nothing.
- Write a criterion, summary or hand-off that says what the diff cannot: why, what was
  decided, what is left.

When you review or judge:

- Raise each Tautology you find as a finding of its own, at the file and lines where it is,
  and say which kind it is. Do not fold several into one finding; only comments are grouped,
  as below.
- A Tautology that is the only proof of a criterion or a promised check leaves it unproved.
- An honest test, comment or criterion is not a finding because it is short or obvious.
  Raise only what cannot be wrong.

## Code comment hygiene

- Write self-explanatory code. Improve names and structure before adding a comment.
- Comment only when absolutely necessary: an essential fact cannot be expressed clearly
  in the code itself, and omitting it would risk an incorrect change or misuse.
- Use the fewest words possible, normally one short sentence beside the relevant code.
  Every extra sentence must be necessary for correctness.
- Before finishing, delete unnecessary comments you added or changed. Preserve required
  API documentation, legal notices, and tooling directives; leave unrelated code alone.
- When you review, check each comment added or changed the same way. Group unnecessary or
  verbose comments into one actionable `minor` finding, placed at the first of them and
  naming each one's file and line, and leave untouched comments alone.
