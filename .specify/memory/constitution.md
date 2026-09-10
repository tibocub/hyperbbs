<!--
Sync Impact Report
Version change: none (new) → 1.0.0
Rationale: initial ratification — MAJOR because this establishes the first binding
constitution for the project (previously no versioned governance, and no prior AI/process
docs of any kind existed here).
Modified principles: n/a (initial set)
Added sections: Core Principles (I–VI), Documentation & Specification Hygiene,
  Adoption in an Existing Codebase, Governance
Removed sections: none
Templates requiring follow-up:
  ✅ plan-template.md — Constitution Check gate reads this file at runtime, no edit needed
  ⚠ spec-template.md — not yet reframed for this project's domain (terminal-first P2P
     hypersite browser, no traditional "user" beyond the site author/visitor pair); revisit
     if/when the first real /speckit-specify pass surfaces friction, matching how hypergraph's
     spec-template.md was adapted after actual use, not preemptively
  ⚠ TODO: none outstanding — all placeholders resolved from repo evidence (README.md,
    package.json, git log, src/db.js header comments, bin/scratch-*.js, test/brittle/helpers.js)
-->

# HyperBBS Constitution

## Core Principles

### I. P2P-Only, No Central Authority

HyperBBS has no server component and no central directory. A "hypersite" is fully defined by
replicating its author's `hypergraph` graph; visiting a site IS replicating its data locally.
Every feature MUST work with this model — no feature may require a server, a central registry,
or any authority HyperBBS itself operates. Addressing (`hyper://<pubkey>`), auth (keypairs +
hypergraph roles, not sessions), and rendering (client-side, from locally-replicated data) all
follow from this and MUST NOT be compromised for convenience.
Rationale: this is HyperBBS's entire reason to exist — a terminal-first P2P web with no servers.
Any feature that quietly needs a server stops being HyperBBS.

### II. Four Generic Data Primitives Only (NON-NEGOTIABLE)

The data layer is exactly `Entity`, `Content`, `Relation`, `Tag` (hypergraph's own primitives) —
HyperBBS MUST NOT invent app-specific data models (no "post" or "comment" entity type baked into
the data layer). Anything that looks like a domain concept (a guestbook entry, a forum post) is a
convention over these four primitives — a query, a tag, a relation type — expressed in HyperMD,
never a new stored shape. New HyperMD directives or sandbox APIs MUST be checked against this
before being added.
Rationale: this is the deliberate difference from a normal web stack (fixed schemas per feature).
Baking in an app-specific model the first time it's convenient defeats the actual design.

### III. Sandboxed Script Execution Is Inviolable (NON-NEGOTIABLE)

Tier 2 HyperMD (`:::script`) runs untrusted, remote-authored JS. It MUST stay confined to a
Worker thread + `vm.runInContext`, with no access to `fs`, `net`, or `process`, communicating
only via structured-clone postMessage IPC and the documented `db`/`identity`/`hypersite` API
surface. No change may weaken this boundary — not for convenience, not for a missing feature,
not even temporarily. Any new sandbox-exposed capability MUST be deliberately added to the
allowed API surface, reviewed for what it lets remote script do, never granted by an accidental
leak (e.g. a closure capturing a Node global, a new `require` reachable from sandboxed code).
Rationale: every hypersite visited runs another author's script locally. A broken sandbox isn't
a bug to fix later — it's a remote-code-execution hole in a P2P system with no central authority
to revoke or patch anything after the fact.

### IV. Verify Empirically, Don't Assume API Shapes

HyperBBS is a thin consumer of `hypergraph`, a sibling project evolving independently and faster.
Before relying on a hypergraph (or any dependency's) API shape, confirm it directly against the
real, current behavior — a probe script (see `bin/inspect-graph.js`, `bin/scratch-owner.js`,
`bin/scratch-visitor.js` for the established pattern), not the dependency's own README examples
or prior assumptions. `src/db.js`'s header comment already documents a real case where
hypergraph's own README examples were wrong. When debugging a cross-project issue, isolate
whether the bug is in HyperBBS's own code or upstream by reproducing the dependency's own proven
usage pattern directly (as `bin/scratch-*.js` do), before assuming either side.
Rationale: this project's two most recent commits are exactly this kind of unresolved
cross-boundary bug (replication looks correct, rendering doesn't). Assuming instead of verifying
wastes time chasing the wrong side of the boundary.

### V. Respect the TUI/Portability Boundary

README.md documents which modules are OpenTUI-coupled (`reconciler.js`, `node-map.js`,
`inline-text.js`, `custom-renderables/`, `main.js`) versus TUI-agnostic and meant to survive a
future WebUI (the `hypermd` package, `sandbox/protocol.js`, `sandbox/snapshot.js`,
`sandbox/harness.js`, `loader.js`). Changes to the TUI-agnostic set MUST NOT introduce an
OpenTUI/terminal-only dependency. When genuinely unsure which side a change belongs on, that's a
signal to check README.md's boundary section before writing the code, not after.
Rationale: recorded here because it's an easy boundary to blur by accident (one convenient
import) and expensive to unwind later if a WebUI is ever actually built.

### VI. Regression Test on Change, Consistent with hypergraph's Conventions

Every behavioral change MUST add or update a `brittle` test under `test/brittle/` that fails
before the change and passes after — `test/all.mjs`'s brittle-node harness follows the same
shape as hypergraph's own test suite deliberately (`test/brittle/helpers.js` states this
explicitly: "Mirrors the pattern from hypergraph/test/brittle/helpers.js so the test style is
consistent across both repos"). Keep it that way — don't introduce a different test philosophy
or helper style here than hypergraph uses, and don't let a new test file skip the shared
`helpers.js` patterns (temp Corestore dirs, `t.teardown`, retry-on-EPERM cleanup) it already
provides. Standalone ad hoc probe scripts (the `bin/scratch-*.js` / `test/*-integration.js`
style) are for empirically verifying a dependency's actual behavior (Principle IV) — they are
not a substitute for a real regression test once the behavior itself is understood.

## Documentation & Specification Hygiene

`specs/<feature>/` (spec → plan → tasks) is the source of truth for anything new or changed,
going forward. `README.md` remains the current-state reference for what already exists —
architecture pipeline, HyperMD format (Tier 1 declarative / Tier 2 scripted), sandbox API
surface, addressing, and the explicit "Status" checklist of what is/isn't built yet — and MUST be
kept current as specced work lands, the same role hypergraph's `docs/` tree plays for that
project. There is no other pre-existing AI/process documentation in this repo (no `AGENTS.md`,
no `CLAUDE.md`, no `ARCHITECTURE.md` existed before this constitution) — `CLAUDE.md` alongside
this file is the first, and stays a short pointer, not a restatement of README.md.

**Doc-sync-on-change**: a change to a module changes the truth README.md's architecture/status
sections claim — update the relevant section in the *same* change, especially the "Status"
checklist (it's meant to reflect exactly what's built, not what's planned).

## Adoption in an Existing Codebase

This constitution governs new and changed work from this point forward; it does not require
retroactive specs for already-working modules (`sandbox/`, `custom-renderables/`, the HyperMD
parser). The project is explicitly early-stage ("expect rough edges" per README) with two
unresolved, actively-debugged issues in the most recent commits (hypersite replication vs.
rendering). The first real `/speckit-specify` pass should target whichever of those the user
picks up next — not be defaulted to arbitrarily. Two small, non-blocking pieces of cleanup
noted during setup, for whenever convenient: `bun.lock` is stale and gitignored-but-still-tracked
(the project moved to Node ≥26.4.0 + npm for native FFI/RocksDB support, per commit `5f279d4`) and
could be `git rm`'d; `test/all.mjs` only loads `sandbox`/`db` tests despite `package.json`'s
`test` script chaining `network`/`identity` too, which is already correctly covered by the
separate script chain, just worth knowing about if `all.mjs` is ever relied on directly.

## Governance

This constitution supersedes ad hoc practice. Amendments happen via `/speckit-constitution`,
using semantic versioning for this document itself: MAJOR for a principle removed or redefined
incompatibly, MINOR for a principle or section added, PATCH for wording/clarity fixes. Every
`/speckit-plan` MUST pass the Constitution Check gate against the current version of this file
before Phase 0 research begins, and re-check after Phase 1 design; violations are either resolved
or justified in that plan's Complexity Tracking table. Principles II and III are NON-NEGOTIABLE:
a plan cannot justify away a violation of them, only avoid causing one.

**Version**: 1.0.0 | **Ratified**: 2026-09-09 | **Last Amended**: 2026-09-09
