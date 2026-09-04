#!/usr/bin/env node
/**
 * bin/diagnose-network.js
 *
 * Standalone diagnostic — run this on BOTH the owner and visitor
 * machines to print exactly what each side computes for the DHT
 * rendezvous topic, so a mismatch (if any) is directly visible instead
 * of inferred from timeout behavior.
 *
 * On the owner:
 *   node bin/diagnose-network.js --data=.\owner-data
 *
 * On the visitor:
 *   node bin/diagnose-network.js --data=.\visitor-data --address=hyper://<the-address-you-are-trying>
 *
 * Compare the "Discovery key (topic)" line printed on each side —
 * they must be byte-for-byte identical for the DHT to ever connect
 * the two peers. If they differ, the address the visitor typed does
 * not match the owner's actual current core key.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Corestore = require('corestore')
const { Hypergraph } = require('hypergraph')
const crypto = require('hypercore-crypto')

async function main () {
  const args = process.argv.slice(2)
  const dataArg = args.find(a => a.startsWith('--data='))
  const addressArg = args.find(a => a.startsWith('--address='))
  const dataPath = dataArg ? dataArg.slice('--data='.length) : null
  const address = addressArg ? addressArg.slice('--address='.length) : null

  if (!dataPath) {
    console.error('Usage: node bin/diagnose-network.js --data=<dir> [--address=hyper://<key>]')
    process.exit(1)
  }

  const store = new Corestore(dataPath)
  const graph = new Hypergraph(store)
  await graph.ready()

  const ownKeyHex = graph.key.toString('hex')
  const ownDiscoveryKey = graph.discoveryKey.toString('hex')
  const computedDiscoveryKey = crypto.discoveryKey(graph.key).toString('hex')

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`This graph's own core key:       ${ownKeyHex}`)
  console.log(`graph.discoveryKey:               ${ownDiscoveryKey}`)
  console.log(`crypto.discoveryKey(graph.key):   ${computedDiscoveryKey}`)
  console.log(`These two match:                  ${ownDiscoveryKey === computedDiscoveryKey}`)
  console.log(`hyper:// address for this site:   hyper://${ownKeyHex}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  if (address) {
    const stripped = address.replace(/^hyper:\/\//i, '').trim().toLowerCase()
    const validHex = /^[0-9a-f]{64}$/i.test(stripped)
    console.log('')
    console.log(`Parsing address you provided:    ${address}`)
    console.log(`Stripped key:                     ${stripped}`)
    console.log(`Valid 64-char hex:                ${validHex}`)
    if (validHex) {
      const targetKeyBuf = Buffer.from(stripped, 'hex')
      const targetDiscoveryKey = crypto.discoveryKey(targetKeyBuf).toString('hex')
      console.log(`Discovery key you would join:     ${targetDiscoveryKey}`)
      console.log('')
      console.log('If running this on the VISITOR machine, this last line')
      console.log('must exactly match "graph.discoveryKey" printed on the')
      console.log('OWNER machine for the two to ever find each other.')
    }
  }

  await graph.close()
  await store.close()
}

main().catch((err) => {
  console.error('[diagnose-network] fatal error:', err)
  process.exit(1)
})
