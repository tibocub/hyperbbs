#!/usr/bin/env node
/**
 * bin/inspect-graph.js
 *
 * Read-only inspection of a Hypergraph data directory's ACTUAL current
 * state. Prints real facts — not assumptions — about what's actually
 * stored, so we stop guessing and start looking directly at what's
 * really there.
 *
 * Usage (run against the OWNER's data dir, while host-site.js is NOT
 * running — two processes can't safely open the same Corestore dir at
 * once):
 *
 *   node bin/inspect-graph.js --data=.\owner-data
 *
 * Prints: the graph's own key, every entity it can find via query()
 * (no filter), every entity via a direct low-level scan of the user
 * core's raw event log (bypassing the query/index layer entirely, to
 * see if entities exist in the RAW LOG even if the query index can't
 * find them — this is the key discriminator we need).
 */

import { createRequire } from 'node:module'
import { loadOrCreateDeviceKeyPair } from '../src/identity.js'

const require = createRequire(import.meta.url)
const Corestore = require('corestore')
const { Hypergraph } = require('hypergraph')

async function main () {
  const args = process.argv.slice(2)
  const dataArg = args.find(a => a.startsWith('--data='))
  const dataPath = dataArg ? dataArg.slice('--data='.length) : null

  if (!dataPath) {
    console.error('Usage: node bin/inspect-graph.js --data=<dir>')
    process.exit(1)
  }

  // CRITICAL: must load the SAME persisted identity host-site.js /
  // main.js use for this directory — otherwise this opens with a
  // brand new random identity every run (confirmed as a real bug
  // during testing this exact script) and "own user core" would
  // report a throwaway identity's empty data, not the real owner's.
  const deviceKeyPair = loadOrCreateDeviceKeyPair(dataPath)
  const store = new Corestore(dataPath)
  const graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('graph.key (this instance\'s own identity):', graph.key.toString('hex'))
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 1. What does the query/index layer see?
  const queried = await graph.query().toArray()
  console.log(`\nquery().toArray() (via index): ${queried.length} entities`)
  for (const e of queried) console.log('  -', JSON.stringify(e))

  // 2. Direct raw-log scan of the LOCAL user core, bypassing query()
  // entirely — reads every event directly off the core via the real,
  // verified public API (graph.openUserCore + UserCore.core.get).
  const ownKeyHex = graph.key.toString('hex')
  const ownCore = await graph.openUserCore(ownKeyHex)
  console.log(`\nRaw scan of own user core (key ${ownKeyHex.slice(0, 16)}...), length=${ownCore.length}:`)
  for (let i = 0; i < ownCore.length; i++) {
    try {
      const event = await ownCore.core.get(i, { timeout: 3000 })
      console.log(`  [${i}]`, JSON.stringify(event))
    } catch (e) {
      console.log(`  [${i}] FAILED TO FETCH: ${e.message}`)
    }
  }

  await graph.close()
  await store.close()
}

main().catch((err) => {
  console.error('[inspect-graph] fatal error:', err)
  process.exit(1)
})
