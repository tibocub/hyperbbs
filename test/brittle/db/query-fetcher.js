/**
 * test/brittle/db/query-fetcher.js
 *
 * Tests for src/db.js createQueryFetcher() against a real Hypergraph instance.
 * All assertions use brittle's t.* API so failures are clearly reported and
 * teardown always runs even if a test throws.
 *
 * Run: npx brittle-node test/brittle/db/query-fetcher.js
 */

import test from 'brittle'
import { createQueryFetcher } from '../../../src/db.js'
import { createGraph } from '../helpers.js'

// ─── Seed helper ─────────────────────────────────────────────────────────────

async function seedPosts(graph) {
  const ctx = await graph.createContext()

  const post1 = await graph.put({ type: 'post' })
  await graph.putContent(post1.id, 'Hello from the first post!', 'text/hypermd')
  await graph.tag(post1.id, 'sub:programming', { context: ctx })

  const post2 = await graph.put({ type: 'post' })
  await graph.putContent(post2.id, 'Second post about HyperBBS', 'text/hypermd')
  await graph.tag(post2.id, 'sub:hyperbbs', { context: ctx })

  const comment = await graph.put({ type: 'comment' })
  await graph.putContent(comment.id, 'Great post!', 'text/hypermd')
  await graph.relate({ from: comment.id, to: post1.id, type: 'reply', context: ctx })

  return { post1, post2, comment, ctx }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('query-fetcher: type filter returns correct entities', async t => {
  const { graph } = await createGraph(t, 'qf-type')
  const { post1, post2 } = await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  const items = await fetcher({ type: 'post' })

  t.is(items.length, 2, 'returns 2 posts')
  t.ok(items.every(i => i.entity.type === 'post'), 'all items are posts')
  t.ok(items.every(i => i.entity.id), 'all items have an id')
  t.ok(items.every(i => i.entity.author), 'all items have an author')
  t.ok(items.every(i => i.entity.createdAt), 'all items have createdAt')
})

test('query-fetcher: content is assembled per entity', async t => {
  const { graph } = await createGraph(t, 'qf-content')
  await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  const items = await fetcher({ type: 'post' })
  const withContent = items.filter(i => i.content !== null)

  t.is(withContent.length, 2, 'both posts have content')
  t.ok(withContent[0].content.body, 'content.body is present')
  t.ok(withContent[0].content.contentType, 'content.contentType is present')
  t.ok(
    withContent.some(i => i.content.body === 'Hello from the first post!'),
    'first post body is correct'
  )
})

test('query-fetcher: limit is respected', async t => {
  const { graph } = await createGraph(t, 'qf-limit')
  await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  const items = await fetcher({ type: 'post', limit: 1 })
  t.is(items.length, 1, 'limit=1 returns exactly 1 item')
})

test('query-fetcher: tag filter returns correct entity', async t => {
  const { graph } = await createGraph(t, 'qf-tag')
  const { post1 } = await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  const items = await fetcher({ tag: 'sub:programming' })

  t.is(items.length, 1, 'exactly 1 entity tagged sub:programming')
  t.is(items[0].entity.id, post1.id, 'correct entity returned')
})

test('query-fetcher: sort=createdAt:desc orders correctly', async t => {
  const { graph } = await createGraph(t, 'qf-sort')
  await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  const items = await fetcher({ type: 'post', sortField: 'createdAt', sortDir: 'desc' })

  t.is(items.length, 2, 'returns both posts')
  t.ok(
    items[0].entity.createdAt >= items[1].entity.createdAt,
    'first item has >= createdAt than second (desc)'
  )
})

test('query-fetcher: relation traversal returns correct entity', async t => {
  const { graph } = await createGraph(t, 'qf-relation')
  const { post1, comment } = await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  const items = await fetcher({ from: post1.id, relation: 'reply' })

  t.is(items.length, 1, 'exactly 1 reply to post1')
  t.is(items[0].entity.id, comment.id, 'correct comment returned')
  t.is(items[0].content?.body, 'Great post!', 'reply content is correct')
})

test('query-fetcher: item shape is complete for template engine', async t => {
  const { graph } = await createGraph(t, 'qf-shape')
  await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  const items = await fetcher({ type: 'post', limit: 1 })
  const item = items[0]

  t.ok('entity' in item, 'item has entity')
  t.ok('content' in item, 'item has content')
  t.ok('tags' in item, 'item has tags')
  t.ok('relations' in item, 'item has relations')
  t.ok('id' in item.entity, 'entity has id')
  t.ok('type' in item.entity, 'entity has type')
  t.ok('author' in item.entity, 'entity has author')
  t.ok('createdAt' in item.entity, 'entity has createdAt')
})

test('query-fetcher: no filter returns empty (not a crash)', async t => {
  const { graph } = await createGraph(t, 'qf-empty-filter')
  await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  const items = await fetcher({})
  t.is(items.length, 0, 'empty filter returns empty array')
})

test('query-fetcher: type+tag combined filter applies both', async t => {
  const { graph } = await createGraph(t, 'qf-type-tag')
  const { post1 } = await seedPosts(graph)
  const fetcher = createQueryFetcher(graph)

  // sub:programming is only on post1, so type=post + tag=sub:programming → 1 result
  const items = await fetcher({ type: 'post', tag: 'sub:programming' })
  t.is(items.length, 1, 'type+tag combined: 1 result')
  t.is(items[0].entity.id, post1.id, 'correct entity')
})
