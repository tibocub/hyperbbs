/**
 * main.js — HyperBBS entry point
 *
 * Usage:
 *   node --experimental-ffi src/main.js <path-to.hmd>
 *   node --experimental-ffi src/main.js <path-to.hmd> --data=./my-graph-data
 *   node --experimental-ffi src/main.js hyper://<topic-hex> --data=./my-graph-data
 *
 * Without --data=: file-only mode, stubs for all P2P data (useful for
 * authoring and testing .hmd files without a live graph).
 *
 * With --data=: opens a real Hypergraph at that path. If the address is
 * a hyper:// URL, connects to that topic on the DHT and replicates the
 * site before rendering it.
 */

import { createCliRenderer } from '@opentui/core'
import { createRequire } from 'node:module'
import { BrowserShell } from './shell.js'
import { parseHyperAddress } from './network.js'
import { loadOrCreateDeviceKeyPair } from './identity.js'

const require = createRequire(import.meta.url)

async function main () {
  const args     = process.argv.slice(2)
  const address  = args.find(a => !a.startsWith('--'))
  const dataArg  = args.find(a => a.startsWith('--data='))
  const dataPath = dataArg ? dataArg.slice('--data='.length) : null

  if (!address) {
    console.error('Usage: node --experimental-ffi src/main.js <path-or-hyper-address> [--data=<graph-data-dir>]')
    process.exit(1)
  }

  let graph = null
  let store = null

  if (dataPath) {
    try {
      const Corestore   = require('corestore')
      const { Hypergraph } = require('hypergraph')
      // Persisted identity — see src/identity.js. Without this, every
      // run of HyperBBS gets a new random identity even against the
      // same --data= directory, which matters for the visitor's own
      // authored writes (comments, posts) having a consistent author
      // across sessions.
      const deviceKeyPair = loadOrCreateDeviceKeyPair(dataPath)
      store = new Corestore(dataPath)
      graph = new Hypergraph(store, { deviceKeyPair })
      await graph.ready()
      process.stderr.write(`[hyperbbs] opened graph at ${dataPath}\n`)
    } catch (e) {
      process.stderr.write(`[hyperbbs] failed to open graph at ${dataPath}: ${e.message}\n`)
      process.stderr.write('[hyperbbs] continuing in file-only mode\n')
      graph = null; store = null
    }
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const shell    = new BrowserShell(renderer, { graph, store })

  const topicHex = parseHyperAddress(address)
  if (topicHex) {
    // hyper:// address — connect via P2P network then render
    await shell.connectAndLoad(topicHex)
  } else {
    // Local file path
    await shell.loadFile(address)
  }
}

main().catch((err) => {
  console.error('[hyperbbs] fatal error:', err)
  process.exit(1)
})
