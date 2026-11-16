# AGENTS.md — swarm-posture

Rules for any agent (or person) changing this repo. The shape and most of the wording come from the
`modelcontextprotocol/inspector` AGENTS.md (branch v2/main, commit d330df9617e44ec893bc1a53618662239342d433), as the
maintainer ruled on it. Where the source's way and ours differ, **the source's way stands until there is a reason to
depart**; every departure below says why.

`CLAUDE.md` contains only `@./AGENTS.md`. Keep one copy of these rules: two copies are strictly worse than one,
because the stale copy is indistinguishable from the live one.

## What this is

A public, zero-runtime-dependency command-line tool. `swarm-posture.ts` reads a declared swarm description
(`example-swarm.json` is the template) and reports excessive permissions (a worker reaching sensitive data its role
does not own) and attack paths (a chain of invoke edges that reaches sensitive data its origin does not). `adapt.ts`
reads an agent-harness install (`pai`, `pi`, `langgraph`, `crewai`) and prints the swarm description for it.
`README.md` is the user-facing description.

**It reads files and prints; it never runs an agent, calls a model or touches the network.** Keep it that way: a
change that adds a network call, a model call or code execution is a decision made explicitly in the issue, never a
side effect of a refactor.

## The output is the interface (read this before touching either script)

Users read the printed report and pipe the adapter's JSON into the posture check, so the text and JSON are the
contract.

- `test/golden/` holds the exact output the scripts printed for the shipped examples before this tooling was added.
  The golden tests compare byte for byte. A change to a golden file is a behavior change: it needs an issue that
  asks for it, and the PR says so.
- Both scripts do their work at import time. Tests run them in-process through `test/helpers/run.ts` (argv in,
  console captured, `process.exit` turned into a thrown error) so coverage can measure them. Do not restructure the
  scripts just to make testing easier.

## Project structure

- `swarm-posture.ts` — the posture check (CLI).
- `adapt.ts` — the install-to-swarm adapters (CLI).
- `example-swarm.json`, `examples/` — the template and reference inputs the README points at. They are also test
  inputs: editing one changes a golden test.
- `test/` — Vitest suites (`*.test.ts`), `test/helpers/run.ts`, `test/golden/`.
- `scripts/verify-gate-scope.ts` — gate tooling.

## Development setup

- `npm ci`. Tooling runs on npm, the source's runner. Users may still run the scripts with `bun` or `npx tsx`, as
  the README says; the gate does not depend on either.
- Tests run on Vitest with `@vitest/coverage-v8`, the source's choice.
- No account, secret or network is needed for any gate step. Tests build synthetic installs in a temp directory and
  never read a real one.

## Issue-driven work style

- **Before starting work, find the issue.** Every change has one. Before filing a new one, search for a match:
  **never create a duplicate**.
- **`Todo` means the maintainer approved it, and only the maintainer moves an issue into `Todo`.** `Backlog` is
  filed, not approved. Start work only on an approved issue.
- **Label by type: exactly one of `bug` / `enhancement` / `documentation` / `chore` / `question`.**
- **`Done` means the work shipped** (its PR merged) and was verified. Anything else is canceled, not done.
- **When work begins**, assign yourself, set the issue In Progress, and create the branch **in a new git worktree**,
  never by switching branches in a checkout another session may share.
- **When work is complete**, run `npm run format` then `npm run local:gate`, **sign off every commit**
  (`git commit -s`), open a PR with **the issue reference as the body's first line**, and set the issue In Review.
- **After opening a PR, run a Codex review loop** (`codex exec --sandbox read-only`), unprompted. Stop on the
  **first** clean round. **Weigh each finding against the issue the PR closes and decline scope expansion.** Two
  failed rounds in a row: stop, leave the PR open, list the findings in it. (Departure: the source uses Copilot; the
  maintainer chose Codex as the off-lineage reviewer.)
- **If new tasks are discovered during development, file issues** rather than widening the PR.
- **Pace bulk GitHub writes: 1 s between requests, never in parallel**, under 80 a minute and 500 an hour.
- **A security issue stays private until its fix is ready**; accepting or publishing an advisory is outward-facing
  and stays human-gated, never automated.
- **This repo is public. Merging is the maintainer's act**, and nothing personal goes into a commit, PR or test
  (home paths, emails, names, tokens). Tests use synthetic data only.
- **Releases are human-gated.** No agent publishes, tags or releases, and no workflow does.

### Responding to code reviews

- Judge each suggestion against the issue the PR closes. Fix defects in what the PR added; decline, with a reason,
  what expands it; file an issue for anything worth doing on its own.
- Reply in each review comment's own thread (a rollup comment does not discharge it), then post a summary in
  addition.

## Always test new or modified code

- **Every source file must clear ≥ 90 on all four dimensions (lines, statements, functions, branches), per file**,
  enforced by `vitest.config.mts` and therefore by `npm test`, `npm run local:gate` and CI. This is the source's bar.
  **Never lower the threshold to pass.**
- The source files are the `.ts` files at the repo root. Coverage `include` names them as exact paths, never a glob.
  A new source file is added to that list in the same change.
- Measured on 2026-11-16 (statements / branches / functions / lines): `adapt.ts` 99.54 / 99.24 / 100 / 99.43,
  `swarm-posture.ts` 99.15 / 98.18 / 100 / 100. No coverage exclusions.
- Coverage exclusions, if one is ever needed, are exact paths, one per entry, each with a reason and a follow-up
  issue; never a glob that could hide a new file.
- **A genuinely-unreachable branch is annotated at the source** (`/* v8 ignore next -- <reason> */`), never waved
  through by lowering the gate.
- **A gate must show how much it checked.** `scripts/verify-gate-scope.ts` runs after the tests and fails if a
  tracked `.ts`/`.mts` file is in no tsconfig project, if a root `.ts` source is missing from the coverage summary,
  or if coverage measured zero files. Fix that by fixing the lists, never by excusing the file.
- Test files are `test/**/*.test.ts`; a file named otherwise is silently not run.
- A test that races is fixed with fake timers or an awaited condition, never with a longer timeout.

## Mandatory pre-push gate

- **ALWAYS run `npm run format` before committing.**
- **`npm run local:gate` is the mandatory pre-push command.** It runs every check CI runs: `format:check`, `lint`,
  `typecheck` and `test` (Vitest with the coverage bar, then the gate-scope check).
- There is deliberately no `ci` script (the name collides with the package-manager built-in). CI runs the four
  stages directly and never calls a `local:*` script.
- Departures, each for a stated reason: no gate lease (the gate takes seconds and binds no ports); no DCO check job
  (adding a required-check ruleset is a repository setting, the maintainer's to change); no smoke stage beyond the
  golden tests (they already drive both CLIs end to end on the shipped examples).

## Waiting on long-running work

**When you are waiting for something to finish, arm a notifier and stop. Never spend turns polling.** For state the
harness cannot observe (a CI run, a remote review), poll inside one backgrounded loop that exits when the condition
holds, at 30 s or more.

## Build output is never a gate target

**No gate (lint, format or typecheck) may read generated output.** Out of scope: `node_modules/`, `coverage/`,
`dist/`, `package-lock.json`. Each scope states it: `globalIgnores` in `eslint.config.mjs`, `.prettierignore`, and the
tsconfig `include` list. **When a build starts writing to a new location, add it to the ignore lists in the same
change.** Never widen an ignore to silence a finding in first-party code. Markdown is also outside the format scope:
prettier rewrites prose.

## Lint has no warning tier

**`lint` runs with `--max-warnings 0`, so a warning fails the gate exactly as an error does.** Rules: ESLint
recommended, typescript-eslint recommended, and `@typescript-eslint/no-floating-promises` at `error`.

- **Do not silence a finding to satisfy the gate.** If a rule genuinely must be waived on one line, use its inline
  disable comment **with a one-line justification**. Dropping a rule or widening an ignore to make `lint` pass is
  not a fix.

## TypeScript

- TypeScript for all code. Never `any`: narrow JSON at the boundary from `unknown`.
- No floating promises: `await` them, or `void` them with a comment saying why.
- Every new file starts with a header comment saying what it is for and why.
- A rule about what the code does is asserted at runtime in a test, not read out of the source.
