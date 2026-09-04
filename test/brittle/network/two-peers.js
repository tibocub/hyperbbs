/**
 * test/brittle/network/two-peers.js
 *
 * Tests HyperBBSNetwork's address format and bootstrap read/write.
 *
 * Address format: hyper://<ownerCoreKeyHex> — the address IS the
 * owner's Hypergraph core public key, not an arbitrary topic. This was
 * a deliberate design correction: an earlier version used a random
 * topic, and empirical testing showed that a bare Hyperswarm connection
 * causes ZERO data to flow until at least one side has explicitly
 * opened a specific core by key. See network.js's file header for the
 * full empirical writeup.
 *
 * Run: brittle-node test/brittle/network/two-peers.js
 */

import test from 'brittle'
import { createGraph, sleep } from '../helpers.js'
import { HyperBBSNetwork, parseHyperAddress, formatHyperAddress } from '../../../src/network.js'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)

test('parseHyperAddress: valid hyper:// address', t => {
  const key = crypto.randomBytes(32).toString('hex')
  t.is(parseHyperAddress(`hyper://${key}`), key)
  t.is(parseHyperAddress(`HYPER://${key}`), key, 'case insensitive')
  t.is(parseHyperAddress(null), null, 'null returns null')
  t.is(parseHyperAddress('hyper://tooshort'), null, 'short key returns null')
  t.is(parseHyperAddress('notahyperaddress'), null, 'no protocol returns null')
})

test('formatHyperAddress: formats correctly', t => {
  const key = crypto.randomBytes(32).toString('hex')
  t.is(formatHyperAddress(key), `hyper://${key}`)
})

test('network: host() returns the graph\'s own core key as the site address', async t => {
  t.plan(3)
  const { graph, store } = await createGraph(t, 'net-owner')

  const network = new HyperBBSNetwork(graph, store, { role: 'owner' })
  t.teardown(() => network.destroy())

  // Write the bootstrap manually (what host() does internally) without
  // actually joining a real swarm, since this sandbox has no DHT access.
  const { HypergraphNetwork } = require('hypergraph')
  const ctx = await graph.createContext()
  const crypto2 = require('hypercore-crypto')
  const bootstrap = HypergraphNetwork.generateBootstrap(graph, {
    topic: crypto2.discoveryKey(graph.key).toString('hex'),
    contexts: { content: ctx.toString('hex') }
  })
  await network._writeBootstrap(bootstrap)

  const recovered = await network._readBootstrap()
  t.ok(recovered, 'bootstrap is stored and readable')
  t.is(recovered.ownerCore, graph.key.toString('hex'), 'bootstrap ownerCore matches graph.key')
  t.ok(parseHyperAddress(formatHyperAddress(graph.key.toString('hex'))), 'graph.key round-trips through address format')
})

test('network: openUserCore-before-replicate is required for data to flow (regression test)', async t => {
  t.plan(2)

  // This test locks in the empirical finding that caused a real bug:
  // a bare replication pipe between two stores transfers NOTHING
  // unless the receiving side has opened the specific core by key
  // first. Confirmed by comparing both cases directly.
  const { graph: ownerGraph, store: ownerStore } = await createGraph(t, 'net-regr-owner')
  const { graph: withoutOpen, store: storeA } = await createGraph(t, 'net-regr-a')
  const { graph: withOpen, store: storeB } = await createGraph(t, 'net-regr-b')

  const post = await ownerGraph.put({ type: 'post' })
  await ownerGraph.putContent(post.id, 'test content', 'text/plain')
  const ownerKeyHex = ownerGraph.key.toString('hex')

  // Case A: no openUserCore — should see nothing
  const a1 = ownerStore.replicate(true, { live: true })
  const a2 = storeA.replicate(false, { live: true })
  a1.pipe(a2).pipe(a1)
  t.teardown(() => { a1.destroy(); a2.destroy() })
  await sleep(800)
  await withoutOpen.update()
  const postsA = await withoutOpen.query().type('post').toArray()
  t.is(postsA.length, 0, 'WITHOUT openUserCore: zero posts replicate, confirming the bug is real')

  // Case B: openUserCore first — should see the post
  await withOpen.openUserCore(ownerKeyHex)
  const b1 = ownerStore.replicate(true, { live: true })
  const b2 = storeB.replicate(false, { live: true })
  b1.pipe(b2).pipe(b1)
  t.teardown(() => { b1.destroy(); b2.destroy() })
  await sleep(800)
  await withOpen.update()
  const postsB = await withOpen.query().type('post').toArray()
  t.is(postsB.length, 1, 'WITH openUserCore first: post replicates correctly')
})

test('network: visitor reads bootstrap after openUserCore + replicate', async t => {
  t.plan(3)

  const { graph: ownerGraph, store: ownerStore } = await createGraph(t, 'net-boot-owner')
  const { graph: visitorGraph, store: visitorStore } = await createGraph(t, 'net-boot-visitor')

  const { HypergraphNetwork } = require('hypergraph')
  const crypto2 = require('hypercore-crypto')

  const post = await ownerGraph.put({ type: 'post' })
  await ownerGraph.putContent(post.id, 'Hello from the owner!', 'text/hypermd')

  const ownerNet = new HyperBBSNetwork(ownerGraph, ownerStore, { role: 'owner' })
  t.teardown(() => ownerNet.destroy())

  const ctx = await ownerGraph.createContext()
  const bootstrap = HypergraphNetwork.generateBootstrap(ownerGraph, {
    topic: crypto2.discoveryKey(ownerGraph.key).toString('hex'),
    contexts: { content: ctx.toString('hex') }
  })
  await ownerNet._writeBootstrap(bootstrap)

  const ownerKeyHex = ownerGraph.key.toString('hex')

  // Exactly what HyperBBSNetwork.connect() does internally, minus the
  // real swarm.join() (no DHT in this sandbox) — open the owner's core
  // by key BEFORE replicating.
  await visitorGraph.openUserCore(ownerKeyHex)

  const r1 = ownerStore.replicate(true, { live: true })
  const r2 = visitorStore.replicate(false, { live: true })
  r1.pipe(r2).pipe(r1)
  t.teardown(() => { r1.destroy(); r2.destroy() })

  await sleep(1000)
  await visitorGraph.update()

  const visitorNet = new HyperBBSNetwork(visitorGraph, visitorStore, { role: 'peer' })
  t.teardown(() => visitorNet.destroy())

  const recoveredBootstrap = await visitorNet._readBootstrap()
  t.ok(recoveredBootstrap, 'visitor can read bootstrap after replication')
  t.is(recoveredBootstrap?.ownerCore, ownerKeyHex, 'bootstrap ownerCore matches')

  const posts = await visitorGraph.query().type('post').toArray()
  t.ok(posts.some(p => p.id === post.id), 'visitor sees the owner\'s post')
})
