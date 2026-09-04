/**
 * test/brittle/network/delayed-content.js
 *
 * Regression test for a real bug found via manual testing over a real
 * DHT connection: page:index content that arrives AFTER the initial
 * connect()/load attempt was silently never picked up, because
 * graph.on('change') only fires as a result of calling graph.update()
 * — it's not a passive push notification — and nothing was calling
 * graph.update() repeatedly for the life of a connection, and the
 * shell only ever tried loading the page once.
 *
 * This simulates that timing: the visitor's graph starts with the
 * owner's core open but NO content written to the owner side yet
 * (simulating "page hasn't replicated in time"), then the owner writes
 * page:index content AFTER, and we confirm continued polling picks it
 * up eventually via graph.update().
 *
 * Run: brittle-node test/brittle/network/delayed-content.js
 */

import test from 'brittle'
import { createGraph, sleep } from '../helpers.js'

const PAGE_INDEX_TYPE = 'page:index'

test('delayed-content: content written after initial replication is still eventually visible via polling', async t => {
  t.plan(3)

  const { graph: ownerGraph, store: ownerStore } = await createGraph(t, 'dc-owner')
  const { graph: visitorGraph, store: visitorStore } = await createGraph(t, 'dc-visitor')

  const ownerKeyHex = ownerGraph.key.toString('hex')

  // Visitor opens the owner's core and starts replicating BEFORE any
  // content exists — simulating a visitor connecting just as (or just
  // before) the owner's site becomes available.
  await visitorGraph.openUserCore(ownerKeyHex)

  const r1 = ownerStore.replicate(true, { live: true })
  const r2 = visitorStore.replicate(false, { live: true })
  r1.pipe(r2).pipe(r1)
  t.teardown(() => { r1.destroy(); r2.destroy() })

  await sleep(500)
  await visitorGraph.update()

  // Confirm nothing is there yet — this is the exact state that
  // produced a blank page in the real bug
  const early = await visitorGraph.query().type(PAGE_INDEX_TYPE).toArray()
  t.is(early.length, 0, 'no page:index yet — matches the real-world timing gap')

  // NOW the owner writes the page (simulating replication catching up,
  // or the owner writing content moments after the visitor connected)
  const pageEntity = await ownerGraph.put({ type: PAGE_INDEX_TYPE })
  await ownerGraph.putContent(pageEntity.id, '# Hello, late arrival', 'text/hypermd')

  // Simulate the continuous polling loop HyperBBSNetwork now runs
  // (_startUpdatePolling calls graph.update() every 1.5s) by calling
  // update() again after the new data exists
  await sleep(800)
  await visitorGraph.update()

  const later = await visitorGraph.query().type(PAGE_INDEX_TYPE).toArray()
  t.is(later.length, 1, 'page:index becomes visible after a subsequent graph.update() call')

  const content = await visitorGraph.getContent(later[0].id)
  t.is(content?.body, '# Hello, late arrival', 'content is correct once picked up')
})
