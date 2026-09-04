/**
 * test/brittle/network/full-site-flow.js
 *
 * End-to-end: seed a site (page:index, matching what
 * bin/host-site.js writes), replicate to a visitor via local pipe,
 * confirm the visitor can read the page:index content and render it.
 *
 * This doesn't use HyperBBSNetwork.connect() itself (which needs a real
 * DHT) — it verifies the DATA SHAPE contract between host-site.js and
 * shell.js's _loadSiteIndex() is correct, using the same local-pipe
 * replication technique as two-peers.js.
 *
 * Run: brittle-node test/brittle/network/full-site-flow.js
 */

import test from 'brittle'
import { parse, applyStyles } from 'hypermd'
import { createGraph, sleep } from '../helpers.js'
import { createQueryFetcher } from '../../../src/db.js'
import { resolveQueries } from '../../../src/query-resolver.js'
import crypto from 'node:crypto'

const PAGE_INDEX_TYPE = 'page:index'

const SITE_SOURCE = `
# Welcome to my first hypersite

This is a simple, static hypersite.

::bigtext[HI]{font=tiny}
`

test('full-site-flow: owner seeds page:index, visitor replicates and renders it', async t => {
  t.plan(4)

  const { graph: ownerGraph, store: ownerStore } = await createGraph(t, 'fsf-owner')
  const { graph: visitorGraph, store: visitorStore } = await createGraph(t, 'fsf-visitor')

  // Owner: seed the site exactly as bin/host-site.js does
  const pageEntity = await ownerGraph.put({ type: PAGE_INDEX_TYPE })
  await ownerGraph.putContent(pageEntity.id, SITE_SOURCE, 'text/hypermd')

  const ownerKey = ownerGraph.key.toString('hex')

  // Visitor: must open owner's core BEFORE replication (empirically
  // required — see two-peers.js for the discovery of this requirement)
  await visitorGraph.openUserCore(ownerKey)

  const r1 = ownerStore.replicate(true, { live: true })
  const r2 = visitorStore.replicate(false, { live: true })
  r1.pipe(r2).pipe(r1)
  t.teardown(() => { r1.destroy(); r2.destroy() })

  await sleep(1000)
  await visitorGraph.update()

  // Visitor: exactly what shell.js's _loadSiteIndex() does
  const pages = await visitorGraph.query().type(PAGE_INDEX_TYPE).toArray()
  t.is(pages.length, 1, 'visitor sees exactly one page:index entity')

  const content = await visitorGraph.getContent(pages[0].id)
  t.ok(content?.body, 'visitor can read page content')
  t.is(content.body, SITE_SOURCE, 'content matches exactly what owner wrote')

  // Confirm it actually parses and renders as HyperMD
  const doc = parse(content.body)
  await resolveQueries(doc, createQueryFetcher(visitorGraph))
  applyStyles(doc.nodes, doc.styles)

  const heading = doc.nodes.find(n => n.type === 'Heading')
  t.ok(heading, 'parsed HyperMD document has a heading node')
})
