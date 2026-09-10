# CLAUDE.md

Guidance for any Claude Code session working in this repo. Read this before doing anything else
here — it's the one file every session auto-loads, unlike `.specify/memory/constitution.md`
below, which only loads during a `/speckit-*` skill invocation.

## What this is

HyperBBS is a terminal-first, P2P web browser — self-contained "hypersites" (data = a
`hypergraph` graph, replicated P2P, no servers), rendered via OpenTUI, authored in HyperMD
(Markdown + declarative/scripted directives). Explicitly an early-stage research prototype —
expect incomplete features and active debugging, per README.md's own "Status" section.

## Governing document

**`.specify/memory/constitution.md` is the project's binding governance document.** Read it
before any non-trivial change. Two principles are NON-NEGOTIABLE: the sandbox execution boundary
(untrusted remote script MUST stay confined — no `fs`/`net`/`process`, ever) and the four generic
data primitives (`Entity`/`Content`/`Relation`/`Tag` — never bake in an app-specific model). A
third principle worth internalizing immediately: verify a dependency's (especially hypergraph's)
actual API behavior empirically via a probe script, don't trust its docs or your assumptions —
this project has already been burned by that once (see `src/db.js`'s header comment).

## Wider ecosystem — read this before any cross-project work

HyperBBS is one of five sibling P2P projects under `E:\Code\P2P\`, and it is the **most
dependent** of them. **Canonical map:
[`E:\Code\P2P\hypergraph\ECOSYSTEM.md`](../hypergraph/ECOSYSTEM.md).**

- **hypergraph** (`E:\Code\P2P\hypergraph`) — P2P graph database. The hub. Provides data,
  identity, permissions, replication.
- **HyperMD** (`E:\Code\P2P\HyperMD`) — the `.hmd` document format/parser.
- **hyperDNS** (`E:\Code\P2P\hyperDNS`) — federated naming; not yet integrated here.
- **SwarmFS** (`E:\Code\P2P\SwarmFS`) — bulk file transfer; paused, unrelated for now.

**Untill shipped on npm, both `hypergraph` and `hypermd` are symlinks in `node_modules/` pointing
at those live local checkouts.** Consequences you must know:

1. Their source is on this machine — when Principle IV says verify hypergraph's behavior
   empirically, read `E:\Code\P2P\hypergraph\src\` directly and use the `bin/scratch-*.js` probes.
2. Editing hypergraph changes HyperBBS's runtime *instantly*. There is no version bump. Conversely,
   a hypergraph change can break this repo with no warning — hypergraph is ALPHA and takes
   intentional breaking changes, logged in its `CHANGELOG.md`.
3. **`package-lock.json` has no `hypergraph` entry at all**, so `npm ci` cannot reproduce the
   working setup and may destroy the symlinks. Restore with `npm link` in the dependency's
   checkout, then `npm link hypergraph` / `npm link hypermd` here.
4. HyperMD has **no real tests** (its `test/` files are probe scripts with zero assertions), so a
   green HyperMD run proves nothing. Cover format changes from this side.

## Spec-kit workflow

Every `/speckit-*` skill has `disable-model-invocation: false` — I can invoke these directly via
the Skill tool, without you typing the slash command. Decide myself whether a request needs the
full pipeline (new/ambiguous features, real design decisions) or just a direct fix with a
regression test (a small, already-understood bug) — don't default to ceremony for its own sake.

`/speckit-specify` → (optional `/speckit-clarify`) → `/speckit-plan` → `/speckit-tasks` →
(optional `/speckit-analyze`, `/speckit-checklist`) → `/speckit-implement` → `/speckit-converge`
for periodic backlog sweeps against the codebase.

`specs/<NNN-feature>/spec.md` → `plan.md` → `tasks.md` is the source of truth for that feature's
reasoning. `README.md` stays the current-state reference (architecture, HyperMD spec, sandbox
API, addressing, and — importantly — its own "Status" checklist of what's actually built) and
must be kept in sync as specced work lands.

## Tooling

- Script runtime: **Node.js ≥26.4.0 + npm, not Bun** — despite a leftover tracked-but-gitignored
  `bun.lock`, the project deliberately moved off Bun for native FFI/RocksDB support (see commit
  `5f279d4`). Run scripts as `node ...`/`npm run ...`.
- Spec-kit's own `/speckit-*` skills shell out to `.specify/scripts/python/*.py` (stdlib-only) —
  `python3` must resolve on PATH. If a skill's `python3 ...` call fails with "command not found,"
  retry as `python .specify/scripts/...` (some Windows setups only expose `python`).
- Tests: `brittle`, run via `brittle-node`. `test/brittle/helpers.js` deliberately mirrors
  `hypergraph`'s own test helper conventions (temp Corestore dirs, `t.teardown`, EPERM-retry
  cleanup) — keep new tests consistent with that style, don't invent a different one.
  `npm test` chains `test:sandbox && test:db && test:network && test:identity`.

## Git convention: branch per feature

No spec-kit git extension is installed, so branch creation isn't automatic. After
`/speckit-specify` creates `specs/<NNN-name>/`, run `git checkout -b <NNN-name>` (same name as
the spec directory). Merge back to `master` once that feature's `/speckit-implement` is done and
its tests pass. Note this project's existing commit style is long, narrative, and honest about
WIP/broken state ("still not working," "Next step: ...") rather than terse conventional-commits —
don't impose a different style on top of a feature branch's own commits.
