/**
 * test/query-hypergraph.js
 *
 * End-to-end: seed a real Hypergraph, parse a .hmd with :::query/:::template,
 * run resolveQueries against the live graph, confirm template expanded with
 * real data. This is the full :::query pipeline with a real db.
 *
 * Run with: node --experimental-vm-modules test/query-hypergraph.js
 */

import { parse, applyStyles } from 'hypermd'
import { resolveQueries } from '../src/query-resolver.js'
import { createQueryFetcher } from '../src/db.js'

const Corestore = (await import('corestore')).default
const { Hypergraph } = await import('hypergraph')
const { mkdtempSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')

// Setup
const dir = mkdtempSync(join(tmpdir(), 'hb-query-test-'))
const store = new Corestore(dir)
const graph = new Hypergraph(store)
await graph.ready()

const ctx = await graph.createContext()
const post1 = await graph.put({ type: 'post' })
await graph.putContent(post1.id, 'My first hypersite post', 'text/hypermd')
await graph.tag(post1.id, 'sub:hyperBBS', { context: ctx })

const post2 = await graph.put({ type: 'post' })
await graph.putContent(post2.id, 'Second thoughts on P2P browsing', 'text/hypermd')
await graph.tag(post2.id, 'sub:hyperBBS', { context: ctx })

console.log('seeded 2 posts')

// Parse a real .hmd document with :::query / :::template
const source = `
# Recent Posts

::query{type=post sort=createdAt:desc limit=10 as=posts}

:::template{for=posts}
## {{entity.author|pubkey:short}}
{{content.body}}
:::

---

## Tagged sub:hyperBBS

::query{tag=sub:hyperBBS as=tagged}

:::template{for=tagged}
- {{content.body|truncate:40}}
:::
`

const doc = parse(source)
const fetcher = createQueryFetcher(graph)
await resolveQueries(doc, fetcher)
applyStyles(doc.nodes, doc.styles)

// Check results
const templates = doc.nodes.filter(n => n.type === 'TemplateBlock')
console.assert(templates.length === 2, `expected 2 templates, got ${templates.length}`)

const [postsTemplate, taggedTemplate] = templates
console.assert(postsTemplate.props._resolved, 'posts template resolved')
console.assert(taggedTemplate.props._resolved, 'tagged template resolved')
console.assert(postsTemplate.children.length > 0, `posts template has children, got ${postsTemplate.children.length}`)
console.assert(taggedTemplate.children.length > 0, `tagged template has children, got ${taggedTemplate.children.length}`)

function collectText(nodes) {
  const out = []
  for (const n of nodes) {
    if (n.type === 'Text' && n.props.value) out.push(n.props.value)
    if (n.children?.length) out.push(...collectText(n.children))
  }
  return out
}

const postText = collectText(postsTemplate.children).join(' ')
const tagText  = collectText(taggedTemplate.children).join(' ')

console.assert(postText.includes('My first hypersite post') || postText.includes('Second thoughts'),
  `posts template should contain real content, got: "${postText.slice(0, 100)}"`)
console.assert(tagText.includes('My first hypersite post') || tagText.includes('Second thoughts'),
  `tagged template should contain real content, got: "${tagText.slice(0, 100)}"`)

console.log('posts template text sample:', postText.slice(0, 80))
console.log('tagged template text sample:', tagText.slice(0, 80))
console.log('posts template children:', postsTemplate.children.length)
console.log('tagged template children:', taggedTemplate.children.length)

await graph.close()
await store.close()
rmSync(dir, { recursive: true, force: true })

console.log('\n✓ :::query/:::template pipeline works with real Hypergraph data')
