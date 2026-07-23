/**
 * main.js — HyperBBS entry point
 *
 * Usage:
 *   bun run src/main.js <path-to.hmd>
 *   bun run src/main.js <path-to.hmd> --data=./my-graph-data
 *
 * When --data= is provided, a real Hypergraph instance is opened at that
 * path and wired into the shell so :::query blocks and script db.* calls
 * use real P2P data instead of stubs.
 *
 * Without --data=, the shell runs in file-only mode (stub data, useful
 * for authoring and testing .hmd files without a live graph).
 */

import { createCliRenderer } from '@opentui/core'
import { BrowserShell } from './shell.js'

async function main() {
  const args = process.argv.slice(2)
  const filePath = args.find(a => !a.startsWith('--'))
  const dataArg  = args.find(a => a.startsWith('--data='))
  const dataPath = dataArg ? dataArg.slice('--data='.length) : null

  if (!filePath) {
    console.error('Usage: bun run src/main.js <path-to.hmd> [--data=<graph-data-dir>]')
    process.exit(1)
  }

  let graph = null
  if (dataPath) {
    try {
      // Dynamic import so main.js still works without hypergraph installed
      const Corestore = (await import('corestore')).default
      const { Hypergraph } = await import('hypergraph')
      const store = new Corestore(dataPath)
      graph = new Hypergraph(store)
      await graph.ready()
      process.stderr.write(`[hyperbbs] opened graph at ${dataPath}\n`)
    } catch (e) {
      process.stderr.write(`[hyperbbs] failed to open graph at ${dataPath}: ${e.message}\n`)
      process.stderr.write('[hyperbbs] continuing in file-only mode (stub data)\n')
      graph = null
    }
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const shell    = new BrowserShell(renderer, { graph })

  await shell.loadFile(filePath)
}

main().catch((err) => {
  console.error('[hyperbbs] fatal error:', err)
  process.exit(1)
})
