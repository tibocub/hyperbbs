import { parse, applyStyles } from 'hypermd'
import { resolveQueries } from '../src/query-resolver.js'

const STUB_POSTS = [
  {
    entity:  { id: 'post-1', type: 'post', author: 'abcdef1234567890', createdAt: Date.now() - 3600000 },
    content: { body: 'Hello from the first post!', contentType: 'text/hypermd' },
    tags:    ['sub:programming', 'featured'],
    relations: { reply: { count: 3 } },
  },
  {
    entity:  { id: 'post-2', type: 'post', author: 'deadbeef99999999', createdAt: Date.now() - 86400000 },
    content: { body: 'A second post about HyperBBS', contentType: 'text/hypermd' },
    tags:    ['sub:hyperbbs'],
    relations: { reply: { count: 0 } },
  },
]

async function stubFetcher(filter) {
  if (filter.type && filter.type !== 'post') return []
  const items = [...STUB_POSTS]
  if (filter.limit) return items.slice(0, Number(filter.limit))
  return items
}

function collectText(nodes) {
  const texts = []
  for (const n of nodes) {
    if (n.type === 'Text' && n.props.value) texts.push(n.props.value)
    if (n.children?.length) texts.push(...collectText(n.children))
  }
  return texts
}

// Test 1: basic expansion
const doc1 = parse(`
::query{type=post limit=10 as=posts}

:::template{for=posts}
**{{entity.author|pubkey:short}}** — {{content.body|truncate:50}}
:::
`)
await resolveQueries(doc1, stubFetcher)
const tmpl1 = doc1.nodes.find(n => n.type === 'TemplateBlock')
console.assert(tmpl1?.props._resolved === true, 'resolved')
console.assert(tmpl1?.children.length > 0, 'has children')
const text1 = collectText(tmpl1.children).join(' ')
console.assert(text1.includes('abcdef12…'), `pubkey:short in output — got: "${text1}"`)
console.log('Test 1 passed: expansion + filters work, children:', tmpl1.children.length)

// Test 2: empty result
const doc2 = parse(`
::query{type=nothing as=x}
:::template{for=x}
{{content.body}}
:::
`)
await resolveQueries(doc2, stubFetcher)
const tmpl2 = doc2.nodes.find(n => n.type === 'TemplateBlock')
console.assert(tmpl2.children.length === 0, 'empty result = no children')
console.log('Test 2 passed: empty result → no children')

// Test 3: route:param
let capturedFilter = null
const doc3 = parse(`
::query{type=post from=route:id relation=reply as=replies}
:::template{for=replies}{{content.body}}:::
`)
await resolveQueries(doc3, (f) => { capturedFilter = f; return [] }, { id: 'post-abc-123' })
console.assert(capturedFilter?.from === 'post-abc-123', `route:id — got: "${capturedFilter?.from}"`)
console.log('Test 3 passed: route:id resolved in filter')

// Test 4: correct filter shape
const filters = []
const doc4 = parse(`::query{type=post tag=sub:programming sort=createdAt:desc limit=5 as=posts}`)
await resolveQueries(doc4, (f) => { filters.push(f); return [] })
const f = filters[0]
console.assert(f.type === 'post' && f.tag === 'sub:programming' && f.sortField === 'createdAt' && f.sortDir === 'desc' && Number(f.limit) === 5, `filter shape — got: ${JSON.stringify(f)}`)
console.log('Test 4 passed: correct filter object passed to fetcher')

console.log('\n✓ All resolver tests passed')