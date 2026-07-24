/**
 * test/all.mjs — brittle test entrypoint
 *
 * Loads all HyperBBS test files sequentially.
 * Used by both brittle-node (Node.js) and brittle-bare (Bare runtime).
 *
 * Run all:     brittle-node test/all.mjs
 * Sandbox only: brittle-node test/brittle/sandbox/resolver.js
 * DB only:      brittle-node test/brittle/db/query-fetcher.js test/brittle/db/query-template.js
 */

import { load } from 'brittle'

// Sandbox tests — stub data, no Hypergraph, fast
await load(import.meta.resolve('./brittle/sandbox/resolver.js'))

// DB integration tests — real Hypergraph, slower
await load(import.meta.resolve('./brittle/db/query-fetcher.js'))
await load(import.meta.resolve('./brittle/db/query-template.js'))
