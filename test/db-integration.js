/**
 * test/db-integration.js
 *
 * End-to-end test of src/db.js against a real Hypergraph instance.
 * Creates real entities, content, tags, and relations, then exercises
 * createQueryFetcher() to confirm the assembled item shapes match what
 * the template engine expects.
 *
 * Run with: node test/db-integration.js
 */

import { createQueryFetcher } from '../src/db.js'

const Corestore = (await import('corestore')).default
const { Hypergraph } = await import('hypergraph')
const { mkdtempSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')

// ─── Setup ───────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'hb-db-test-'))
const store = new Corestore(dir)
const graph = new Hypergraph(store)
await graph.ready()

console.log('graph ready, author:', graph.identity.identityPublicKey.toString('hex').slice(0, 16) + '…')

// ─── Seed data ────────────────────────────────────────────────────────────────

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

console.log('seeded: post1:', post1.id, '| post2:', post2.id, '| comment:', comment.id)

// ─── Tests ───────────────────────────────────────────────────────────────────

const fetcher = createQueryFetcher(graph)

// Test 1: query by type
{
  const items = await fetcher({ type: 'post' })
  console.assert(items.length === 2, `type filter: expected 2 posts, got ${items.length}`)
  console.assert(items[0].entity.type === 'post', 'entity.type is post')
  console.assert(items[0].entity.id, 'entity.id present')
  console.assert(items[0].entity.author, 'entity.author present')
  console.assert(items[0].entity.createdAt, 'entity.createdAt present')
  console.log('Test 1 passed: query by type returns', items.length, 'items')
}

// Test 2: content is assembled
{
  const items = await fetcher({ type: 'post' })
  const withContent = items.filter(i => i.content !== null)
  console.assert(withContent.length === 2, `expected 2 items with content, got ${withContent.length}`)
  console.assert(withContent[0].content.body, 'content.body present')
  console.assert(withContent[0].content.contentType, 'content.contentType present')
  console.log('Test 2 passed: content assembled, body:', withContent[0].content.body.slice(0, 30))
}

// Test 3: limit
{
  const items = await fetcher({ type: 'post', limit: 1 })
  console.assert(items.length === 1, `limit: expected 1, got ${items.length}`)
  console.log('Test 3 passed: limit=1 respected')
}

// Test 4: query by tag
{
  const items = await fetcher({ tag: 'sub:programming' })
  console.assert(items.length === 1, `tag filter: expected 1, got ${items.length}`)
  console.assert(items[0].entity.id === post1.id, 'correct entity returned for tag')
  console.log('Test 4 passed: query by tag returns correct entity')
}

// Test 5: sort desc
{
  const items = await fetcher({ type: 'post', sortField: 'createdAt', sortDir: 'desc' })
  console.assert(items.length === 2, 'sort: got 2 items')
  console.assert(items[0].entity.createdAt >= items[1].entity.createdAt, 'desc sort correct')
  console.log('Test 5 passed: sort=createdAt:desc correct')
}

// Test 6: relation traversal (replies to post1)
{
  const items = await fetcher({ from: post1.id, relation: 'reply' })
  console.assert(items.length === 1, `relation traversal: expected 1 reply, got ${items.length}`)
  console.assert(items[0].entity.id === comment.id, 'correct comment returned')
  console.assert(items[0].content?.body === 'Great post!', 'reply content correct')
  console.log('Test 6 passed: relation traversal returns correct reply')
}

// Test 7: item shape has all template engine fields
{
  const items = await fetcher({ type: 'post', limit: 1 })
  const item = items[0]
  console.assert('entity' in item, 'item has entity')
  console.assert('content' in item, 'item has content')
  console.assert('tags' in item, 'item has tags')
  console.assert('relations' in item, 'item has relations')
  console.assert('id' in item.entity, 'entity has id')
  console.assert('type' in item.entity, 'entity has type')
  console.assert('author' in item.entity, 'entity has author')
  console.assert('createdAt' in item.entity, 'entity has createdAt')
  console.log('Test 7 passed: item shape complete for template engine')
  console.log('  item keys:', Object.keys(item))
  console.log('  entity keys:', Object.keys(item.entity))
  console.log('  content keys:', item.content ? Object.keys(item.content) : 'null')
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

await graph.close()
await store.close()
rmSync(dir, { recursive: true, force: true })

console.log('\n✓ All db integration tests passed')
