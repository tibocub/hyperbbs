/**
 * main.js
 *
 * Entry point. Wires the browser shell, loads a .hmd file, renders it.
 *
 * Usage: bun run src/main.js <path-to.hmd>
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCliRenderer } from '@opentui/core'
import { parse, applyStyles, resolveExternals } from 'hypermd'
import { createFsLoader } from './loader.js'
import { BrowserShell } from './shell.js'

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: bun run src/main.js <path-to.hmd>')
    process.exit(1)
  }

  const absPath = resolve(filePath)
  const source  = readFileSync(absPath, 'utf8')
  const doc     = parse(source, { baseKey: absPath })

  await resolveExternals(doc, createFsLoader(absPath))
  applyStyles(doc.nodes, doc.styles)

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const shell    = new BrowserShell(renderer)

  shell.load(doc, absPath)
}

main().catch((err) => {
  console.error('[hyperbbs] fatal error:', err)
  process.exit(1)
})