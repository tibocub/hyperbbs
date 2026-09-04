/**
 * test/brittle/network/two-peers.js
 *
 * Tests HyperBBSNetwork with two local peers — owner hosting a site,
 * visitor connecting to it. Uses local Corestore replication (no real
 * DHT/internet) piped directly, matching hypergraph's own test pattern
 * for P2P scenarios.
 *
 * Run: brittle-node test/brittle/network/two-peers.js
 */

import test from 'brittle'
import { createGraph, sleep } from '../helpers.js'
import { HyperBBSNetwork, parseHyperAddress, formatHyperAddress } from '../../../src/network.js'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const Hyperswarm = require('hyperswarm')

test('parseHyperAddress: valid hyper:// address', t => {
  const topic = crypto.randomBytes(32).toString('hex')
  t.is(parseHyperAddress(`hyper://${topic}`), topic)
  t.is(parseHyperAddress(`HYPER://${topic}`), topic, 'case insensitive')
  t.is(parseHyperAddress(null), null, 'null returns null')
  t.is(parseHyperAddress('hyper://tooshort'), null, 'short key returns null')
  t.is(parseHyperAddress('notahyperaddress'), null, 'no protocol returns null')
})

test('formatHyperAddress: formats correctly', t => {
  const topic = crypto.randomBytes(32).toString('hex')
  t.is(formatHyperAddress(topic), `hyper://${topic}`)
})

test('network: owner can host a site and write a bootstrap', async t => {
  t.plan(2)
  const { graph, store } = await createGraph(t, 'net-owner')
  const topic = crypto.randomBytes(32).toString('hex')

  const network = new HyperBBSNetwork(graph, store, { role: 'owner' })
  t.teardown(() => network.destroy())

  // We can't do a real swarm join in this sandbox (no DHT/internet),
  // but we CAN test that host() writes the bootstrap to the graph
  // and that the network instance is set up correctly.
  // The actual two-peer replication test uses local pipe replication below.

  // Write a bootstrap manually (what host() does internally)
  const { HypergraphNetwork } = require('hypergraph')
  const ctx = await graph.createContext()
  const bootstrap = HypergraphNetwork.generateBootstrap(graph, {
    topic,
    contexts: { content: ctx.toString('hex') }
  })

  // Expose internal method for test access
  await network._writeBootstrap(bootstrap)

  // Verify it can be read back
  const recovered = await network._readBootstrap(topic)
  t.ok(recovered, 'bootstrap is stored and readable')
  t.is(recovered.topic, topic, 'bootstrap topic matches')
})

test('network: two peers replicate via local pipe (no DHT)', async t => {
  t.plan(4)

  const { graph: ownerGraph, store: ownerStore } = await createGraph(t, 'net-owner2')
  const { graph: visitorGraph, store: visitorStore } = await createGraph(t, 'net-visitor')

  const topic = crypto.randomBytes(32).toString('hex')

  // Owner creates a post and a bootstrap descriptor
  const post = await ownerGraph.put({ type: 'post' })
  await ownerGraph.putContent(post.id, 'Hello from the owner!', 'text/hypermd')

  const { HypergraphNetwork } = require('hypergraph')
  const ownerNet = new HyperBBSNetwork(ownerGraph, ownerStore, { role: 'owner' })
  t.teardown(() => ownerNet.destroy())

  const ctx = await ownerGraph.createContext()
  const bootstrap = HypergraphNetwork.generateBootstrap(ownerGraph, {
    topic,
    contexts: { content: ctx.toString('hex') }
  })
  await ownerNet._writeBootstrap(bootstrap)

  // Critical: visitor must open the owner's core BEFORE replication starts
  // so that Corestore knows which blocks to request. This is what
  // connectFromBootstrap() does automatically via bootstrap.ownerCore.
  await visitorGraph.openUserCore(bootstrap.ownerCore)

  // Wire local pipe replication with live: true
  const r1 = ownerStore.replicate(true, { live: true })
  const r2 = visitorStore.replicate(false, { live: true })
  r1.pipe(r2).pipe(r1)
  t.teardown(() => { r1.destroy(); r2.destroy() })

  // Wait for replication to propagate
  await sleep(1000)
  await visitorGraph.update()

  const visitorNet = new HyperBBSNetwork(visitorGraph, visitorStore, { role: 'peer' })
  t.teardown(() => visitorNet.destroy())

  const recoveredBootstrap = await visitorNet._readBootstrap(topic)
  t.ok(recoveredBootstrap, 'visitor can read bootstrap after replication')
  t.is(recoveredBootstrap?.topic, topic, 'topic matches')

  const posts = await visitorGraph.query().type('post').toArray()
  t.ok(posts.length > 0, 'visitor sees replicated posts')
  t.ok(posts.some(p => p.id === post.id), 'visitor sees the specific post')
})
