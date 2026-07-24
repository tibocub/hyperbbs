/**
 * test/brittle/db/query-template.js
 *
 * End-to-end tests of the :::query / :::template pipeline using a real
 * Hypergraph instance as the data source.
 *
 * Run: npx brittle-node test/brittle/db/query-template.js
 */

import test from 'brittle'
import { parse, applyStyles } from 'hypermd'
import { resolveQueries } from '../../../src/query-resolver.js'
import { createQueryFetcher } from '../../../src/db.js'
import { createGraph } from '../helpers.js'

function collectText(nodes) {
  const out = []
  for (const n of nodes) {
    if (n.type === 'Text' && n.props.value) out.push(n.props.value)
    if (n.children?.length) out.push(...collectText(n.children))
  }
  return out
}

test('query-template: type query expands template with real content', async t => {
  const { graph } = await createGraph(t, 'qt-type')
  const ctx = await graph.createContext()

  const p1 = await graph.put({ type: 'post' })
  await graph.putContent(p1.id, 'My first hypersite post', 'text/hypermd')
  const p2 = await graph.put({ type: 'post' })
  await graph.putContent(p2.id, 'Second thoughts on P2P browsing', 'text/hypermd')

  const source = `
::query{type=post sort=createdAt:desc limit=10 as=posts}

:::template{for=posts}
## {{entity.author|pubkey:short}}
{{content.body}}
:::
`
  const doc = parse(source)
  await resolveQueries(doc, createQueryFetcher(graph))
  applyStyles(doc.nodes, doc.styles)

  const tmpl = doc.nodes.find(n => n.type === 'TemplateBlock')
  t.ok(tmpl?.props._resolved, 'template is marked resolved')
  t.ok(tmpl.children.length > 0, 'template has expanded children')

  const text = collectText(tmpl.children).join(' ')
  t.ok(
    text.includes('My first hypersite post') || text.includes('Second thoughts'),
    'real content appears in expanded output'
  )
})

test('query-template: tag query filters correctly', async t => {
  const { graph } = await createGraph(t, 'qt-tag')
  const ctx = await graph.createContext()

  const p1 = await graph.put({ type: 'post' })
  await graph.putContent(p1.id, 'Tagged post', 'text/hypermd')
  await graph.tag(p1.id, 'sub:hyperBBS', { context: ctx })

  const p2 = await graph.put({ type: 'post' })
  await graph.putContent(p2.id, 'Untagged post', 'text/hypermd')

  const source = `
::query{tag=sub:hyperBBS as=tagged}

:::template{for=tagged}
- {{content.body}}
:::
`
  const doc = parse(source)
  await resolveQueries(doc, createQueryFetcher(graph))

  const tmpl = doc.nodes.find(n => n.type === 'TemplateBlock')
  const text = collectText(tmpl.children).join(' ')

  t.ok(text.includes('Tagged post'), 'tagged post appears')
  t.absent(text.includes('Untagged post'), 'untagged post absent')
})

test('query-template: multiple independent query+template pairs', async t => {
  const { graph } = await createGraph(t, 'qt-multi')
  const ctx = await graph.createContext()

  const p1 = await graph.put({ type: 'post' })
  await graph.putContent(p1.id, 'Featured content', 'text/hypermd')
  await graph.tag(p1.id, 'featured', { context: ctx })

  const p2 = await graph.put({ type: 'post' })
  await graph.putContent(p2.id, 'Regular content', 'text/hypermd')

  const source = `
::query{tag=featured as=featured}
::query{type=post limit=5 as=recent}

:::template{for=featured}
FEATURED: {{content.body}}
:::

:::template{for=recent}
RECENT: {{content.body|truncate:30}}
:::
`
  const doc = parse(source)
  await resolveQueries(doc, createQueryFetcher(graph))

  const templates = doc.nodes.filter(n => n.type === 'TemplateBlock')
  t.is(templates.length, 2, 'two templates present')
  t.ok(templates[0].props._resolved, 'first template resolved')
  t.ok(templates[1].props._resolved, 'second template resolved')

  const featuredText = collectText(templates[0].children).join(' ')
  const recentText   = collectText(templates[1].children).join(' ')

  t.ok(featuredText.includes('Featured content'), 'featured template has correct content')
  t.ok(recentText.includes('Regular content') || recentText.includes('Featured content'),
    'recent template has content')
})

test('query-template: empty result set produces no children', async t => {
  const { graph } = await createGraph(t, 'qt-empty')

  const source = `
::query{type=nonexistent as=nothing}

:::template{for=nothing}
{{content.body}}
:::
`
  const doc = parse(source)
  await resolveQueries(doc, createQueryFetcher(graph))

  const tmpl = doc.nodes.find(n => n.type === 'TemplateBlock')
  t.is(tmpl.children.length, 0, 'empty result → zero children')
})

test('query-template: pubkey:short filter renders truncated author', async t => {
  const { graph } = await createGraph(t, 'qt-pubkey')

  const p = await graph.put({ type: 'post' })
  await graph.putContent(p.id, 'Test post', 'text/hypermd')

  const source = `
::query{type=post as=posts}

:::template{for=posts}
{{entity.author|pubkey:short}}
:::
`
  const doc = parse(source)
  await resolveQueries(doc, createQueryFetcher(graph))

  const tmpl = doc.nodes.find(n => n.type === 'TemplateBlock')
  const text = collectText(tmpl.children).join('')

  // pubkey:short = first 8 chars + ellipsis
  t.ok(/^[0-9a-f]{8}…$/.test(text.trim()), `pubkey:short format correct, got: "${text.trim()}"`)
})
