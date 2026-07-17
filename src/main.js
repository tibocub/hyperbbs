/**
 * main.js — HyperBBS entry point
 *
 * Usage: bun run src/main.js <path-to.hmd>
 */

import { createCliRenderer } from '@opentui/core'
import { BrowserShell } from './shell.js'

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: bun run src/main.js <path-to.hmd>')
    process.exit(1)
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const shell    = new BrowserShell(renderer)

  await shell.loadFile(filePath)
}

main().catch((err) => {
  console.error('[hyperbbs] fatal error:', err)
  process.exit(1)
})