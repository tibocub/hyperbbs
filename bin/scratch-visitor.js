#!/usr/bin/env node
/**
 * bin/scratch-visitor.js
 *
 * Minimal, standalone visitor script — pairs with bin/scratch-owner.js.
 * Uses HypergraphNetwork.connectFromBootstrap(), the EXACT proven
 * pattern from p2p-reddit-clone/peer.js, NOT HyperBBS's own
 * src/network.js (which uses a bare Hyperswarm + manual openUserCore
 * instead of a real HypergraphNetwork instance on the peer side — a
 * real architectural difference from the proven pattern, not just a
 * timing nuance).
 *
 * Usage:
 *   node bin/scratch-visitor.js --data=./scratch-visitor-data --bootstrap=./scratch-owner-data/bootstrap.json
 *
 * You must copy the owner's bootstrap.json file to the visitor's
 * machine/directory first (out of band — e.g. via a messaging app, USB
 * drive, etc.) exactly as p2p-reddit-clone expects; there is no
 * separate "just type an address" step in this minimal version.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadOrCreateDeviceKeyPair } from '../src/identity.js'

const require = createRequire(import.meta.url)
const Corestore = require('corestore')
const { Hypergraph, HypergraphNetwork } = require('hypergraph')
const Hyperswarm = require('hyperswarm')

async function main () {
  const args = process.argv.slice(2)
  const dataArg = args.find(a => a.startsWith('--data='))
  const bootstrapArg = args.find(a => a.startsWith('--bootstrap='))
  const dataPath = dataArg ? dataArg.slice('--data='.length) : null
  const bootstrapPath = bootstrapArg ? bootstrapArg.slice('--bootstrap='.length) : null

  if (!dataPath || !bootstrapPath) {
    console.error('Usage: node bin/scratch-visitor.js --data=<dir> --bootstrap=<path-to-bootstrap.json>')
    process.exit(1)
  }

  const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf-8'))
  console.log('loaded bootstrap:', JSON.stringify(bootstrap))

  const deviceKeyPair = loadOrCreateDeviceKeyPair(dataPath)
  const store = new Corestore(dataPath)
  const graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()
  console.log('graph ready, own key:', graph.key.toString('hex'))

  const swarm = new Hyperswarm()

  // The proven pattern: connectFromBootstrap() opens the owner's user
  // core AND constructs a real HypergraphNetwork instance for us —
  // this is the piece HyperBBS's own network.js was NOT doing (it used
  // a bare Hyperswarm with manual replicate() instead).
  const networking = await HypergraphNetwork.connectFromBootstrap(
    graph, store, swarm, bootstrap, { role: 'peer' }
  )

  networking.on('peer-join', () => console.log('[visitor] peer joined'))
  networking.on('writer-granted', (msg) => console.log('[visitor] writer granted:', JSON.stringify(msg)))
  networking.on('writer-error', (msg) => console.log('[visitor] writer error:', JSON.stringify(msg)))

  console.log('connecting...')
  await networking.connect()
  console.log('connect() resolved')

  // Poll for the page, printing progress the whole way — no hidden
  // machinery, just the raw facts each second.
  for (let i = 0; i < 30; i++) {
    await graph.update()
    const pages = await graph.query().type('page:index').toArray()
    console.log(`poll #${i + 1}: query results = ${pages.length}`)
    if (pages.length > 0) {
      const content = await graph.getContent(pages[0].id)
      console.log('')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('SUCCESS — page content:')
      console.log(content.body)
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      await networking.destroy()
      await graph.close()
      await store.close()
      process.exit(0)
    }
    await new Promise(r => setTimeout(r, 1000))
  }

  console.log('Timed out after 30s without finding page:index.')
  await networking.destroy()
  await graph.close()
  await store.close()
  process.exit(1)
}

main().catch((err) => {
  console.error('[scratch-visitor] fatal error:', err)
  process.exit(1)
})
