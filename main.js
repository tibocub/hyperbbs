/**
 * main.js
 *
 * Parses a .hmd file with hypermd, mounts the resulting HyperDOM tree
 * into OpenTUI via the Reconciler, and runs any script blocks in the
 * worker-based sandbox.
 *
 * Usage: bun run src/main.js <path-to.hmd>
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCliRenderer, BoxRenderable } from '@opentui/core'
import { parse, applyStyles, resolveExternals } from 'hypermd'
import { Reconciler } from './src/reconciler.js'
import { createFsLoader } from './src/loader.js'
import { SandboxHost } from './src/sandbox/host.js'

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: bun run src/main.js <path-to.hmd>')
    process.exit(1)
  }

  const absPath = resolve(filePath)
  const source = readFileSync(absPath, 'utf8')
  const doc = parse(source, { baseKey: absPath })

  // Resolve any ::script{src=...} / ::style{src=...} external references
  // before applying styles, since an external :::style file can itself
  // contain rules that need to land on the tree exactly like an inline
  // one would.
  await resolveExternals(doc, createFsLoader(absPath))
  applyStyles(doc.nodes, doc.styles)

  const renderer = await createCliRenderer({ exitOnCtrlC: true })

  // Viewport: a scrollable container the hypersite content mounts into,
  // distinct from renderer.root so a future browser shell can wrap it
  // with an address bar / status line without the hypersite knowing.
  //
  // KNOWN GAP: this should be a ScrollBoxRenderable — without scrolling,
  // content past the bottom edge silently clips. ScrollBoxRenderable
  // couldn't be verified in this no-TTY dev environment (correct child
  // count but no visible output, likely viewport-culling against a zero
  // terminal size). Verify and swap in from a real terminal.
  const viewport = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    padding: 1,
    gap: 1,
  })
  renderer.root.add(viewport)

  const reconciler = new Reconciler(renderer)
  reconciler.mountDocument(doc.nodes, viewport)

  // Wire up the script sandbox — one worker per script block, with
  // the reconciler as the bridge for DOM events and patching.
  if (doc.scripts.length > 0) {
    const sandbox = new SandboxHost({
      reconciler,
      identity: null, // no identity system yet
      db: null,       // Hypergraph stub until real integration lands
    })
    sandbox.runScripts(doc.scripts, doc.nodes)

    // Forward browser-level events from scripts upward — currently just
    // log to stderr since we have no browser shell yet.
    sandbox.on('navigate', (address) => {
      process.stderr.write(`[hyperbbs] navigate -> ${address}\n`)
    })
    sandbox.on('notify', (text, level) => {
      process.stderr.write(`[hyperbbs:${level}] ${text}\n`)
    })
  }
}

main().catch((err) => {
  console.error('[hyperbbs] fatal error:', err)
  process.exit(1)
})
