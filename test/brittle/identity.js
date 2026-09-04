/**
 * test/brittle/identity.js
 *
 * Regression test for a real bug: without a persisted deviceKeyPair,
 * every restart of the same --data= directory silently produces a
 * different Hypergraph identity — and therefore a different graph.key,
 * and therefore a different hyper:// address. This made hosting a site
 * across restarts (or even the exact identical process being re-run)
 * completely unusable: any previously-shared address permanently
 * stopped matching anything the moment the owner process restarted.
 *
 * Root cause (see src/identity.js's file header for the full writeup):
 * hypercore-storage's tmpFixStorage() migration helper silently
 * relocates unrecognized files out of a Corestore directory's root
 * into a `db/` subdirectory the first time it's opened without a
 * CORESTORE marker file — so a naive "write the keypair file inside
 * the data dir" approach breaks on the very first real run.
 *
 * Run: brittle-node test/brittle/identity.js
 */

import test from 'brittle'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { loadOrCreateDeviceKeyPair } from '../../src/identity.js'

const require = createRequire(import.meta.url)
const Corestore = require('corestore')
const { Hypergraph } = require('hypergraph')

test('identity: loadOrCreateDeviceKeyPair returns the same keypair across calls', t => {
  t.plan(2)
  const base = mkdtempSync(join(tmpdir(), 'id-basic-'))
  const dataDir = join(base, 'site-data')
  t.teardown(() => rmSync(base, { recursive: true, force: true }))

  const kp1 = loadOrCreateDeviceKeyPair(dataDir)
  const kp2 = loadOrCreateDeviceKeyPair(dataDir)

  t.ok(kp1.publicKey.equals(kp2.publicKey), 'same publicKey across calls')
  t.ok(kp1.secretKey.equals(kp2.secretKey), 'same secretKey across calls')
})

test('identity: graph.key is stable across simulated restarts of the same data dir', async t => {
  t.plan(1)
  const base = mkdtempSync(join(tmpdir(), 'id-stable-'))
  const dataDir = join(base, 'site-data')
  t.teardown(() => rmSync(base, { recursive: true, force: true }))

  const keys = []

  // Simulate three separate process runs against the same directory
  for (let i = 0; i < 3; i++) {
    const deviceKeyPair = loadOrCreateDeviceKeyPair(dataDir)
    const store = new Corestore(dataDir)
    const graph = new Hypergraph(store, { deviceKeyPair })
    await graph.ready()
    keys.push(graph.key.toString('hex'))
    await graph.close()
    await store.close()
  }

  const allSame = keys.every(k => k === keys[0])
  t.ok(allSame, `graph.key stable across 3 restarts — got: ${JSON.stringify(keys)}`)
})

test('identity: keypair file is NOT relocated/lost by Corestore\'s storage migration', async t => {
  t.plan(1)
  // This locks in the specific failure mode that was found: writing
  // the identity file inside the Corestore data directory (rather
  // than as a sibling) gets silently relocated by hypercore-storage's
  // tmpFixStorage() on first open, breaking the loader on every run
  // after the first. Confirm our sibling-file approach survives it.
  const base = mkdtempSync(join(tmpdir(), 'id-migration-'))
  const dataDir = join(base, 'site-data')
  t.teardown(() => rmSync(base, { recursive: true, force: true }))

  const kp1 = loadOrCreateDeviceKeyPair(dataDir)

  const store = new Corestore(dataDir)
  const graph = new Hypergraph(store, { deviceKeyPair: kp1 })
  await graph.ready()
  await graph.close()
  await store.close()

  // After the Corestore directory has been opened once (triggering
  // any migration behavior), the loader must still find the same key.
  const kp2 = loadOrCreateDeviceKeyPair(dataDir)
  t.ok(kp1.publicKey.equals(kp2.publicKey), 'identity survives a Corestore open (and its migration pass)')
})
