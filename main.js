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
import { createCliRenderer, ScrollBoxRenderable } from '@opentui/core'
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

  await resolveExternals(doc, createFsLoader(absPath))
  applyStyles(doc.nodes, doc.styles)

  const renderer = await createCliRenderer({ exitOnCtrlC: true })

  // Viewport: a ScrollBoxRenderable so documents taller than the terminal
  // can be scrolled. The scrollbar appears automatically when content
  // overflows (ScrollBarRenderable hides itself when content fits).
  // Mouse wheel and keyboard (arrow keys, PgUp/PgDn) are handled
  // natively by ScrollBoxRenderable — no extra wiring needed.
  //
  // Key options:
  //   scrollY: true          — vertical scrolling only (horizontal is
  //                            rarely useful for a document browser)
  //   viewportCulling: false — disable viewport culling. When true,
  //                            OpenTUI skips layout for children outside
  //                            the visible area, which causes them to
  //                            report zero size and produces incorrect
  //                            scrollbar proportions. Disabling ensures
  //                            the full content height is always measured.
  //   contentOptions          — the inner content box that actually
  //                            receives our HyperDOM children; needs
  //                            flexDirection:'column' and padding/gap.
  //   stickyScroll: false    — don't auto-scroll to the bottom (that's
  //                            a chat-window behavior, not a page browser)
  const viewport = new ScrollBoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    scrollY: true,
    scrollX: false,
    stickyScroll: false,
    viewportCulling: false,
    contentOptions: {
      flexDirection: 'column',
      padding: 1,
      gap: 1,
    },
    verticalScrollbarOptions: {
      showArrows: true,
    },
  })
  renderer.root.add(viewport)

  const reconciler = new Reconciler(renderer)
  reconciler.mountDocument(doc.nodes, viewport)

  if (doc.scripts.length > 0) {
    const sandbox = new SandboxHost({
      reconciler,
      identity: null,
      db: null,
    })
    sandbox.runScripts(doc.scripts, doc.nodes)

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
