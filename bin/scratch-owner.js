#!/usr/bin/env node
/**
 * bin/scratch-owner.js
 *
 * Minimal, standalone owner script for empirically testing "put a page,
 * host it, have a visitor fetch it" — using the EXACT pattern from
 * hypergraph's own p2p-reddit-clone example (the one CHANGELOG.md
 * confirms was rewritten and verified end-to-end against the current
 * HypergraphNetwork API), not HyperBBS's own network.js abstraction.
 *
 * This exists specifically to isolate: does the proven, already-tested
 * hypergraph pattern work for our case, or is something upstream of
 * HyperBBS broken? If this works, the bug is in HyperBBS's own
 * src/network.js. If this ALSO fails, the bug is upstream.
 *
 * Usage:
 *   node bin/scratch-owner.js --data=./scratch-owner-data
 *
 * Prints a bootstrap.json file's path — share that file's CONTENT
 * (not just a key) with the visitor script.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { loadOrCreateDeviceKeyPair } from '../src/identity.js'

const require = createRequire(import.meta.url)
const Corestore = require('corestore')
const { Hypergraph, HypergraphNetwork } = require('hypergraph')
const Hyperswarm = require('hyperswarm')

async function main () {
  const args = process.argv.slice(2)
  const dataArg = args.find(a => a.startsWith('--data='))
  const dataPath = dataArg ? dataArg.slice('--data='.length) : null
  if (!dataPath) {
    console.error('Usage: node bin/scratch-owner.js --data=<dir>')
    process.exit(1)
  }

  const bootstrapPath = join(dataPath, 'bootstrap.json')

  const deviceKeyPair = loadOrCreateDeviceKeyPair(dataPath)
  const store = new Corestore(dataPath)
  const graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()
  console.log('graph ready, key:', graph.key.toString('hex'))

  // Write (or update) the page content
  const existing = await graph.query().type('page:index').toArray()
  let pageId
  if (existing.length > 0) {
    pageId = existing[0].id
    await graph.putContent(pageId, '# Scratch test page\n\nHello from the owner!', 'text/hypermd')
    console.log('updated existing page:index:', pageId)
  } else {
    const entity = await graph.put({ type: 'page:index' })
    pageId = entity.id
    await graph.putContent(pageId, '# Scratch test page\n\nHello from the owner!', 'text/hypermd')
    console.log('created new page:index:', pageId)
  }

  // Bootstrap: load existing or generate new — EXACT pattern from
  // p2p-reddit-clone/peer.js
  let bootstrap = existsSync(bootstrapPath)
    ? JSON.parse(readFileSync(bootstrapPath, 'utf-8'))
    : null

  if (!bootstrap) {
    bootstrap = HypergraphNetwork.generateBootstrap(graph, {
      topic: graph.discoveryKey.toString('hex'),
      contexts: {},
    })
    writeFileSync(bootstrapPath, JSON.stringify(bootstrap, null, 2))
    console.log('generated new bootstrap.json at', bootstrapPath)
  } else {
    console.log('reusing existing bootstrap.json at', bootstrapPath)
  }

  const swarm = new Hyperswarm()
  const networking = new HypergraphNetwork(graph, store, swarm, {
    topic: bootstrap.topic,
    contexts: bootstrap.contexts || {},
    role: 'owner',
  })

  networking.on('peer-join', () => console.log('[owner] peer joined'))
  networking.on('writer-granted', (msg) => console.log('[owner] writer granted:', JSON.stringify(msg)))
  networking.on('writer-error', (msg) => console.log('[owner] writer error:', JSON.stringify(msg)))

  await networking.connect()
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('Owner is hosting. Share this exact file with the visitor:')
  console.log('  ', bootstrapPath)
  console.log('Visitor runs: node bin/scratch-visitor.js --data=<dir> --bootstrap=<path-to-that-file>')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('Press Ctrl+C to stop.')

  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    await networking.destroy()
    await graph.close()
    await store.close()
    process.exit(0)
  })

  await new Promise(() => {})
}

main().catch((err) => {
  console.error('[scratch-owner] fatal error:', err)
  process.exit(1)
})
