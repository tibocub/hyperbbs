/**
 * src/identity.js
 *
 * Persists a Hypergraph deviceKeyPair alongside a graph's data
 * directory, so the site's identity (and therefore its core key / its
 * hyper:// address) is STABLE across restarts.
 *
 * This exists because of a documented Hypergraph gotcha: `new
 * Hypergraph(store)` with no explicit deviceKeyPair generates a fresh,
 * random one every time, even against the same Corestore directory.
 *
 * IMPORTANT — the keypair file is stored ALONGSIDE the data directory
 * (`<dataDir>.identity.json`), never inside it. Confirmed empirically
 * that hypercore-storage's `tmpFixStorage()` migration helper silently
 * relocates any file it doesn't recognize (deviceKeyPair.json included)
 * out of the Corestore directory root into a `db/` subdirectory the
 * first time Corestore opens a directory with no `CORESTORE` marker
 * file yet — this isn't destructive (the file isn't deleted, just
 * moved), but it means a naive "write the keypair file inside the data
 * dir" approach silently breaks on the very first real run: the file
 * written before Corestore ever opens ends up somewhere our loader
 * never looks, so every subsequent run regenerates a fresh keypair
 * anyway. Keeping our file outside the directory Corestore manages
 * sidesteps this migration behavior entirely.
 *
 * Pattern matches hypergraph's own examples/forum-web/peer.js
 * loadOrCreateDeviceKeyPair(), adapted for this storage-location fix.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const hypercoreCrypto = require('hypercore-crypto')

/**
 * Build the sibling path for a data directory's identity file.
 * E.g. dataDir "./owner-data" -> "./owner-data.identity.json"
 * (a sibling FILE, not something inside the directory Corestore owns).
 */
function identityFilePath (dataDir) {
  const dir = dirname(dataDir)
  const name = basename(dataDir)
  return join(dir, `${name}.identity.json`)
}

/**
 * Load an existing deviceKeyPair from the sibling identity file, or
 * generate and persist a new one if none exists yet.
 *
 * @param {string} dataDir - the Corestore data directory (--data= value)
 * @returns {{ publicKey: Buffer, secretKey: Buffer }}
 */
export function loadOrCreateDeviceKeyPair (dataDir) {
  const keyPath = identityFilePath(dataDir)

  if (existsSync(keyPath)) {
    try {
      const raw = JSON.parse(readFileSync(keyPath, 'utf8'))
      if (raw?.publicKey && raw?.secretKey) {
        return {
          publicKey: Buffer.from(raw.publicKey, 'hex'),
          secretKey: Buffer.from(raw.secretKey, 'hex'),
        }
      }
    } catch (e) {
      console.error(`[identity] failed to read ${keyPath}, generating a new identity: ${e.message}`)
    }
  }

  const kp = hypercoreCrypto.keyPair()
  // Ensure the parent directory exists (dataDir's parent, not dataDir
  // itself — we deliberately do NOT create dataDir here; Corestore
  // owns that directory's lifecycle).
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, JSON.stringify({
    publicKey: kp.publicKey.toString('hex'),
    secretKey: kp.secretKey.toString('hex'),
  }, null, 2))
  return kp
}
