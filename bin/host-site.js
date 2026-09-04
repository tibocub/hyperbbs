#!/usr/bin/env node
/**
 * bin/host-site.js
 *
 * Creates (or resumes) a hypersite: seeds a Hypergraph with a .hmd file
 * as its page:index content, generates or reuses a DHT topic, and hosts
 * it via HyperBBSNetwork so other peers can connect with hyper://<topic>.
 *
 * Usage:
 *   node bin/host-site.js <path-to.hmd> --data=./my-site-data
 *
 * On first run, generates a new random topic and prints the hyper://
 * address to share. On subsequent runs against the same --data=
 * directory, reuses the existing topic (stored in the graph itself) and
 * re-hosts the same site — editing the .hmd file and re-running updates
 * the page:index content.
 *
 * Keeps running (announcing on the DHT) until Ctrl+C.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import { HyperBBSNetwork, formatHyperAddress } from '../src/network.js'

const require = createRequire(import.meta.url)
const Corestore = require('corestore')
const { Hypergraph } = require('hypergraph')

const PAGE_INDEX_TYPE = 'page:index'
const SITE_TOPIC_TYPE = 'site:topic'

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
  const store = new Corestore(dataPath)
  const graph = new Hypergraph(store)
  await graph.ready()

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

  // Find or create the site's topic
  const existingTopics = await graph.query().type(SITE_TOPIC_TYPE).toArray()
  let topicHex

  if (existingTopics.length > 0) {
    const content = await graph.getContent(existingTopics[0].id)
    topicHex = content.body
    console.log('Reusing existing site topic.')
  } else {
    topicHex = crypto.randomBytes(32).toString('hex')
    const topicEntity = await graph.put({ type: SITE_TOPIC_TYPE })
    await graph.putContent(topicEntity.id, topicHex, 'text/plain')
    console.log('Generated new site topic.')
  }

  // Host it
  const network = new HyperBBSNetwork(graph, store, { role: 'owner' })

  network.on('peer-join', (info) => {
    console.log(`[peer joined] ${JSON.stringify(info)}`)
  })
  network.on('writer-granted', (msg) => {
    console.log(`[writer granted] ${JSON.stringify(msg)}`)
  })
  network.on('writer-error', (msg) => {
    console.log(`[writer error] ${JSON.stringify(msg)}`)
  })
  network.on('flush-timeout', (info) => {
    console.log(`[dht flush timeout] step=${info.step}`)
  })

  await network.host(topicHex, {})

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`Site is live: ${formatHyperAddress(topicHex)}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('Share this address with visitors. They can open it in HyperBBS:')
  console.log(`  node --experimental-ffi src/main.js ${formatHyperAddress(topicHex)} --data=<their-own-data-dir>`)
  console.log('')
  console.log('Press Ctrl+C to stop hosting.')

  // Keep the process alive, announcing on the DHT
  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    await network.destroy()
    await graph.close()
    await store.close()
    process.exit(0)
  })

  await new Promise(() => {}) // block forever until SIGINT
}

main().catch((err) => {
  console.error('[host-site] fatal error:', err)
  process.exit(1)
})
