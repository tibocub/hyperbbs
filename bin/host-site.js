#!/usr/bin/env node
/**
 * bin/host-site.js
 *
 * Creates (or resumes) a hypersite: seeds a Hypergraph with a .hmd file
 * as its page:index content, and hosts it via HyperBBSNetwork so other
 * peers can connect with hyper://<the-site's-own-core-key>.
 *
 * Usage:
 *   node bin/host-site.js <path-to.hmd> --data=./my-site-data
 *
 * The site's address is simply this graph's own core public key — no
 * separate topic to generate or remember. Editing the .hmd file and
 * re-running updates the page:index content in place; the address
 * stays the same across runs against the same --data= directory.
 *
 * Keeps running (announcing on the DHT) until Ctrl+C.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { HyperBBSNetwork, formatHyperAddress } from '../src/network.js'
import { loadOrCreateDeviceKeyPair } from '../src/identity.js'

const require = createRequire(import.meta.url)
const Corestore = require('corestore')
const { Hypergraph } = require('hypergraph')

const PAGE_INDEX_TYPE = 'page:index'

async function main () {
  const args = process.argv.slice(2)
  const hmdPath = args.find(a => !a.startsWith('--'))
  const dataArg = args.find(a => a.startsWith('--data='))
  const dataPath = dataArg ? dataArg.slice('--data='.length) : null

  if (!hmdPath || !dataPath) {
    console.error('Usage: node bin/host-site.js <path-to.hmd> --data=<site-data-dir>')
    process.exit(1)
  }

  const absHmdPath = resolve(hmdPath)
  if (!existsSync(absHmdPath)) {
    console.error(`File not found: ${absHmdPath}`)
    process.exit(1)
  }

  const source = readFileSync(absHmdPath, 'utf8')

  console.log(`Opening site data at ${dataPath}...`)
  // Persist the device identity alongside the data dir so this site's
  // address (derived from graph.key) is STABLE across restarts —
  // without this, every run silently generates a new random identity
  // and therefore a new, different address (confirmed empirically;
  // see src/identity.js for the full writeup of why this is needed).
  const deviceKeyPair = loadOrCreateDeviceKeyPair(dataPath)
  const store = new Corestore(dataPath)
  const graph = new Hypergraph(store, { deviceKeyPair })
  await graph.ready()

  const siteAddress = graph.key.toString('hex')

  // Find or create the page:index entity
  const existingPages = await graph.query().type(PAGE_INDEX_TYPE).toArray()
  let pageEntity

  if (existingPages.length > 0) {
    pageEntity = existingPages[0]
    console.log(`Updating existing page:index (${pageEntity.id})`)
    await graph.putContent(pageEntity.id, source, 'text/hypermd')
  } else {
    pageEntity = await graph.put({ type: PAGE_INDEX_TYPE })
    await graph.putContent(pageEntity.id, source, 'text/hypermd')
    console.log(`Created page:index (${pageEntity.id})`)
  }

  // Host it — address is this graph's own core key, no separate topic
  const network = new HyperBBSNetwork(graph, store, { role: 'owner' })

  network.on('peer-join',     (info) => console.log(`[peer joined] ${JSON.stringify(info)}`))
  network.on('writer-granted',(msg)  => console.log(`[writer granted] ${JSON.stringify(msg)}`))
  network.on('writer-error',  (msg)  => console.log(`[writer error] ${JSON.stringify(msg)}`))
  network.on('flush-timeout', (info) => console.log(`[dht flush timeout] step=${info.step}`))

  await network.host({})

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`Site is live: ${formatHyperAddress(siteAddress)}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('Share this address with visitors. They can open it in HyperBBS:')
  console.log(`  node --experimental-ffi src/main.js ${formatHyperAddress(siteAddress)} --data=<their-own-data-dir>`)
  console.log('')
  console.log('Press Ctrl+C to stop hosting.')

  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    await network.destroy()
    await graph.close()
    await store.close()
    process.exit(0)
  })

  await new Promise(() => {})
}

main().catch((err) => {
  console.error('[host-site] fatal error:', err)
  process.exit(1)
})
