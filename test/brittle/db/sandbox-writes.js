/**
 * test/brittle/db/sandbox-writes.js
 *
 * Regression tests for src/db.js createSandboxDbCallbacks() — the :::script
 * write path. Both tests below FAIL against the pre-fix implementation.
 *
 * Background: this path was untested, because every other test in this repo
 * creates exactly one context up front and threads it through explicitly. The
 * sandbox path creates its own, so it was the only place that could push a
 * graph past one open context — which is precisely what breaks hypergraph's
 * context-scoped reads.
 *
 * Run: npx brittle-node test/brittle/db/sandbox-writes.js
 */

import test from 'brittle'
import { createSandboxDbCallbacks } from '../../../src/db.js'
import { createGraph } from '../helpers.js'

// Drive onDbPut the way SandboxHost does, and surface the response.
function put(callbacks, primitive, data) {
  return new Promise((resolve, reject) => {
    callbacks.onDbPut(
      { requestId: `req-${Math.random()}`, primitive, data },
      msg => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result))
    )
  })
}

function query(callbacks, filter) {
  return new Promise((resolve, reject) => {
    callbacks.onDbQuery(
      { requestId: `req-${Math.random()}`, filter },
      msg => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result))
    )
  })
}

test('sandbox writes: two tag writes do not break subsequent tag queries', async t => {
  const { graph } = await createGraph(t, 'sbw-two-tags')
  const cb = createSandboxDbCallbacks(graph)

  const a = await put(cb, 'entity', { type: 'post' })
  const b = await put(cb, 'entity', { type: 'post' })

  // Two separate tag writes. Pre-fix, each minted its own context, so this
  // pushed the graph to 2 open contexts.
  await put(cb, 'tag', { entityId: a.id, tag: 'sub:one' })
  await put(cb, 'tag', { entityId: b.id, tag: 'sub:two' })

  // Pre-fix this threw: 'Multiple contexts are open on this graph instance'.
  // The sandbox callback converts that throw into { error }, which `query()`
  // above rejects on — so the failure surfaces here either way.
  const items = await query(cb, { tag: 'sub:one' })

  t.is(items.length, 1, 'tag query still works after two tag writes')
  t.is(items[0].entity.id, a.id, 'returns the entity that was tagged')
})

test('sandbox writes: a tag written via the sandbox is readable back', async t => {
  const { graph } = await createGraph(t, 'sbw-visible')
  const cb = createSandboxDbCallbacks(graph)

  const e = await put(cb, 'entity', { type: 'post' })
  await put(cb, 'tag', { entityId: e.id, tag: 'sub:visible' })

  const items = await query(cb, { tag: 'sub:visible' })

  // Pre-fix, the write landed in a throwaway context that no read resolved,
  // so this came back empty even when only one write had happened.
  t.is(items.length, 1, 'the tag written by the sandbox is visible to a tag query')
  t.is(items[0].entity.id, e.id, 'it is the right entity')
})

test('sandbox writes: two relation writes do not break relation traversal', async t => {
  const { graph } = await createGraph(t, 'sbw-two-relations')
  const cb = createSandboxDbCallbacks(graph)

  const post = await put(cb, 'entity', { type: 'post' })
  const c1 = await put(cb, 'entity', { type: 'comment' })
  const c2 = await put(cb, 'entity', { type: 'comment' })

  await put(cb, 'relation', { from: c1.id, to: post.id, type: 'reply' })
  await put(cb, 'relation', { from: c2.id, to: post.id, type: 'reply' })

  const items = await query(cb, { from: post.id, relation: 'reply' })

  t.is(items.length, 2, 'both replies are traversable after two relation writes')
})
