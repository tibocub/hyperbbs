/**
 * test/brittle/helpers.js
 *
 * Shared test infrastructure for HyperBBS tests.
 * Mirrors the pattern from hypergraph/test/brittle/helpers.js so the
 * test style is consistent across both repos.
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// Hypergraph is CJS — use createRequire to import it from ESM context
const require = createRequire(import.meta.url)
const Corestore   = require('corestore')
const { Hypergraph } = require('hypergraph')

/**
 * Create a fresh Hypergraph instance backed by a temp Corestore directory,
 * with automatic teardown registered on the brittle test context.
 *
 * @param {import('brittle').Test} t - brittle test context
 * @param {string} label             - short label used in the temp dir name
 * @param {object} [opts]            - passed through to new Hypergraph(store, opts)
 * @returns {Promise<{ store: Corestore, graph: Hypergraph, dir: string }>}
 */
export async function createGraph(t, label, opts = {}) {
  const dir = mkdtempSync(
    join(tmpdir(), `hyperbbs-${label}-${process.pid}-`)
  )

  const store = new Corestore(dir)
  const graph = new Hypergraph(store, opts)
  await graph.ready()

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await graph.close() } catch {}
    try { await store.close() } catch {}
  }

  t.teardown(async () => {
    await close()
    await removeDirWithRetry(dir)
  })

  return { store, graph, dir, close }
}

/**
 * Remove a directory with retry/backoff — handles Windows file-locking
 * (EPERM) that can occur briefly after closing RocksDB handles.
 */
export async function removeDirWithRetry(dir) {
  const maxRetries = 10
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      if (attempt === maxRetries) return
      await sleep(300 * attempt)
    }
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
