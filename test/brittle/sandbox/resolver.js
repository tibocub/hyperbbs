/**
 * test/brittle/sandbox/resolver.js
 *
 * Tests for src/query-resolver.js using stub data — no live Hypergraph
 * needed. These run fast and verify the resolver+template logic in isolation.
 *
 * Run: npx brittle-node test/brittle/sandbox/resolver.js
 */

import test from 'brittle'
import { parse, applyStyles } from 'hypermd'
import { resolveQueries } from '../../../src/query-resolver.js'

// ─── Stub data ────────────────────────────────────────────────────────────────

const STUB_POSTS = [
  {
    entity:  { id: 'post-1', type: 'post', author: 'abcdef1234567890abcd', createdAt: Date.now() - 3600000 },
    content: { body: 'Hello from the first post!', contentType: 'text/hypermd' },
    tags:    ['sub:programming', 'featured'],
    relations: { reply: { count: 3 } },
  },
  {
    entity:  { id: 'post-2', type: 'post', author: 'deadbeef99999999abcd', createdAt: Date.now() - 86400000 },
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
  const out = []
  for (const n of nodes) {
    if (n.type === 'Text' && n.props.value) out.push(n.props.value)
    if (n.children?.length) out.push(...collectText(n.children))
  }
  return out
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('resolver: basic expansion produces children', async t => {
  const doc = parse(`
::query{type=post limit=10 as=posts}

:::template{for=posts}
**{{entity.author|pubkey:short}}** — {{content.body|truncate:50}}
:::
`)
  await resolveQueries(doc, stubFetcher)

  const tmpl = doc.nodes.find(n => n.type === 'TemplateBlock')
  t.ok(tmpl?.props._resolved, 'template is marked resolved')
  t.ok(tmpl.children.length > 0, 'template has expanded children')

  const text = collectText(tmpl.children).join(' ')
  t.ok(text.includes('abcdef12…'), 'pubkey:short filter applied')
})

test('resolver: empty result produces no children', async t => {
  const doc = parse(`
::query{type=nothing as=x}

:::template{for=x}
{{content.body}}
:::
`)
  await resolveQueries(doc, stubFetcher)

  const tmpl = doc.nodes.find(n => n.type === 'TemplateBlock')
  t.is(tmpl.children.length, 0, 'empty result → zero children')
})

test('resolver: route:param is resolved in query filter', async t => {
  let capturedFilter = null

  const doc = parse(`
::query{type=post from=route:id relation=reply as=replies}

:::template{for=replies}
{{content.body}}
:::
`)
  await resolveQueries(
    doc,
    (f) => { capturedFilter = f; return [] },
    { id: 'post-abc-123' }
  )

  t.is(capturedFilter?.from, 'post-abc-123', 'route:id resolved in filter')
})

test('resolver: correct filter shape passed to fetcher', async t => {
  const filters = []

  const doc = parse(`::query{type=post tag=sub:programming sort=createdAt:desc limit=5 as=posts}`)
  await resolveQueries(doc, (f) => { filters.push(f); return [] })

  t.is(filters.length, 1, 'fetcher called once')
  const f = filters[0]
  t.is(f.type, 'post', 'type filter')
  t.is(f.tag, 'sub:programming', 'tag filter')
  t.is(f.sortField, 'createdAt', 'sortField')
  t.is(f.sortDir, 'desc', 'sortDir')
  t.is(Number(f.limit), 5, 'limit')
})

test('resolver: multiple query+template pairs resolved independently', async t => {
  const doc = parse(`
::query{type=post tag=featured as=featured}
::query{type=post limit=1 as=recent}

:::template{for=featured}
F: {{content.body|truncate:20}}
:::

:::template{for=recent}
R: {{content.body|truncate:20}}
:::
`)
  await resolveQueries(doc, stubFetcher)

  const templates = doc.nodes.filter(n => n.type === 'TemplateBlock')
  t.is(templates.length, 2, 'two templates resolved')
  t.ok(templates[0].props._resolved, 'first resolved')
  t.ok(templates[1].props._resolved, 'second resolved')
  t.is(templates[1].children.length, 1, 'recent template: limit=1 respected (1 item → some children)')
})

test('resolver: interpolation filters all work', async t => {
  const doc = parse(`
::query{type=post limit=1 as=item}

:::template{for=item}
Author: {{entity.author|pubkey:short}}
Body: {{content.body|truncate:8}}
Missing: {{entity.missing|default:n/a}}
Upper: {{entity.type|uppercase}}
:::
`)
  await resolveQueries(doc, stubFetcher)

  const tmpl = doc.nodes.find(n => n.type === 'TemplateBlock')
  const text = collectText(tmpl.children).join(' ')

  t.ok(text.includes('abcdef12…'), 'pubkey:short')
  t.ok(text.includes('Hello fr…'), 'truncate:8')
  t.ok(text.includes('n/a'), 'default:n/a')
  t.ok(text.includes('POST'), 'uppercase')
})

test('resolver: missing for= drops template with warning (no crash)', async t => {
  // :::template without for= is dropped at parse time — confirm no crash
  // and the parse succeeds with zero templates
  const doc = parse(`
:::template
{{content.body}}
:::
`)
  t.is(doc.templates.length, 0, 'missing for= → no template collected')
  // resolveQueries on a doc with no templates/queries is a no-op
  await resolveQueries(doc, stubFetcher)
  t.pass('no crash on empty queries/templates')
})
