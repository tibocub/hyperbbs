/**
 * query-resolver.js
 *
 * Resolves :::query blocks by calling a pluggable data-fetching function,
 * then expands :::template blocks into real HyperDOM node subtrees by
 * interpolating each query result item into the template source and
 * re-parsing the result as HyperMD.
 *
 * The data-fetching function is injected at call time (same pattern as
 * resolveExternals' loader) so this module has zero knowledge of
 * Hypergraph. In HyperBBS it calls db.query(); in a static-site build
 * it could read from a JSON file; in tests it uses stub data.
 *
 * Usage:
 *   import { resolveQueries } from 'hypermd'
 *
 *   const doc = parse(source)
 *   await resolveQueries(doc, async (filter) => {
 *     // filter: { type?, tag?, from?, relation?, sortField?, sortDir?, limit? }
 *     return await db.query(filter)  // returns item[]
 *   })
 *   // doc.nodes containing QueryBlock/TemplateBlock nodes now have
 *   // their children filled in with real HyperDOM subtrees
 *
 * Item shape returned by the fetcher:
 *   {
 *     entity:    { id, type, author, createdAt }
 *     content:   { body, contentType } | null
 *     tags:      string[]
 *     relations: { [type]: { count: number } }
 *   }
 */

import { parse }         from 'hypermd'
import { interpolate }   from 'hypermd'

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @callback QueryFetcher
 * @param {object} filter
 * @param {string} [filter.type]
 * @param {string} [filter.tag]
 * @param {string} [filter.from]       entity id for relation traversal
 * @param {string} [filter.relation]   relation type (e.g. "reply")
 * @param {string} [filter.sortField]  field to sort by (e.g. "createdAt")
 * @param {string} [filter.sortDir]    "asc" | "desc"
 * @param {number} [filter.limit]
 * @returns {Promise<object[]>}
 */

/**
 * Run all :::query blocks in a parsed document, then expand all
 * :::template blocks into real HyperDOM children.
 *
 * Mutates the doc's node tree in place: QueryBlock and TemplateBlock
 * nodes get their children populated, and props._resolved set to true.
 *
 * Query resolution is concurrent (Promise.all). Template expansion is
 * sequential per template (items are rendered in result-set order).
 *
 * Errors in individual queries are caught and logged rather than
 * propagating — a broken query block produces an error message child
 * node instead of crashing the whole page.
 *
 * @param {{ nodes: object[], queries: object[], templates: object[] }} doc
 * @param {QueryFetcher} fetcher
 * @param {object} [routeParams]  current page route params (e.g. { id: 'abc' })
 * @returns {Promise<void>}
 */
export async function resolveQueries(doc, fetcher, routeParams = {}) {
  if (!doc.queries?.length && !doc.templates?.length) return

  // 1. Run all queries concurrently → build a named result map
  const resultSets = {}
  await Promise.all(
    (doc.queries ?? []).map(async (queryNode) => {
      const name = queryNode.props.as
      try {
        const items = await fetcher(buildFilter(queryNode.props, routeParams))
        resultSets[name] = items ?? []
      } catch (e) {
        console.warn(`[hypermd] :::query{as=${name}} failed:`, e.message)
        resultSets[name] = []
        queryNode.props._error = e.message
      }
      queryNode.props._resolved = true
    })
  )

  // 2. Expand each :::template block using its named result set
  for (const templateNode of (doc.templates ?? [])) {
    const name  = templateNode.props.for
    const items = resultSets[name]

    if (items === undefined) {
      console.warn(`[hypermd] :::template{for=${name}}: no :::query with as=${name} found`)
      templateNode.children = [makeErrorNode(`No query named "${name}"`)]
      templateNode.props._resolved = true
      continue
    }

    if (items.length === 0) {
      // Empty result — leave children empty (template renders nothing,
      // like an empty `v-for` in Vue). Authors can add a fallback via
      // a sibling paragraph after the template block.
      templateNode.children = []
      templateNode.props._resolved = true
      continue
    }

    templateNode.children = expandTemplate(
      templateNode.props.templateSource,
      items,
      routeParams,
    )
    templateNode.props._resolved = true
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Build a filter object from a QueryBlock's props, resolving any
 * `route:param` references in attribute values.
 *
 * In ::query attributes, route parameters are referenced as:
 *   from=route:id       → resolved to routeParams.id
 *   tag=route:category  → resolved to routeParams.category
 *
 * We can't use {{route.id}} inside directive attribute values because
 * the `{` character breaks micromark's attribute parser (it expects
 * `{key=value}` not `{key={{...}}}`). The `route:` prefix is unambiguous
 * and survives attribute parsing correctly.
 */
function buildFilter(props, routeParams) {
  const resolve = (val) => {
    if (typeof val !== 'string') return val
    if (val.startsWith('route:')) {
      const key = val.slice(6)
      return routeParams[key] ?? ''
    }
    return val
  }

  return {
    type:      props.type,
    tag:       resolve(props.tag),
    from:      resolve(props.from),
    relation:  props.relation,
    sortField: props.sortField,
    sortDir:   props.sortDir,
    limit:     props.limit != null ? Number(props.limit) : undefined,
  }
}

/**
 * Expand a template source string once per item in the result set.
 * Returns a flat array of HyperDOM nodes — one "group" of nodes per
 * item (since a template body can produce multiple top-level blocks).
 */
function expandTemplate(templateSource, items, routeParams) {
  const allNodes = []

  for (let index = 0; index < items.length; index++) {
    const item    = items[index]
    const context = buildContext(item, index, routeParams)

    // Substitute {{expr}} holes in the template source
    const interpolated = interpolate(templateSource, context)

    // Re-parse the interpolated string as a full HyperMD document.
    // styles/scripts/queries in template bodies are intentionally
    // ignored — templates are for layout and display, not behaviour.
    try {
      const subdoc = parse(interpolated)
      allNodes.push(...subdoc.nodes)
    } catch (e) {
      console.warn(`[hypermd] template expansion error (item ${index}):`, e.message)
      allNodes.push(makeErrorNode(`Template parse error: ${e.message}`))
    }
  }

  return allNodes
}

/**
 * Build the interpolation context for one query result item.
 * This is what {{entity.author}}, {{content.body}}, etc. resolve against.
 */
function buildContext(item, index, routeParams) {
  return {
    entity:    item.entity    ?? {},
    content:   item.content   ?? { body: '', contentType: '' },
    tags:      item.tags      ?? [],
    relations: item.relations ?? {},
    index,
    route: routeParams,
  }
}

/**
 * Produce a minimal HyperDOM error node for display when a query or
 * template expansion fails — visible in the rendered page rather than
 * silently empty.
 */
function makeErrorNode(message) {
  return {
    type: 'Paragraph',
    id: null,
    props: {},
    children: [{
      type: 'Text',
      id: null,
      props: { value: `⚠ ${message}` },
      children: [],
      _tuiRef: null,
    }],
    _tuiRef: null,
  }
}