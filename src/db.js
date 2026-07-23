/**
 * src/db.js — Hypergraph adapter for HyperBBS
 *
 * Bridges Hypergraph's real API to the two interfaces HyperBBS uses:
 *
 * 1. queryFetcher(filter) → item[]
 *    Used by resolveQueries() for :::query/:::template rendering.
 *    Translates a HyperMD filter object into Hypergraph calls and
 *    assembles each result into the { entity, content, tags, relations }
 *    envelope the template engine expects.
 *
 * 2. SandboxHost callbacks (onDbQuery, onDbGet, onDbPut)
 *    Used by the script sandbox for db.query()/db.get()/db.put() calls
 *    from :::script blocks.
 *
 * EMPIRICALLY VERIFIED shapes (probe_query.js, 2026-07):
 *
 *   graph.put({ type })
 *     → { id: "${type}/${authorHex}/${seq}", type, author }
 *     NOTE: id and author are NOT passed in — both are auto-assigned.
 *     The README examples showing `graph.put({ id, author })` are wrong.
 *
 *   graph.query().type(t).toArray()
 *     → [{ id, type, author, createdAt, deleted, version }]
 *
 *   graph.getContent(id)
 *     → { entityId, contentType, body, createdAt, encrypted, scope, epoch, nonce }
 *     encrypted:true means the content is inaccessible without a scope key.
 *
 *   graph.getByTag(tag)
 *     → [{ id, type, author, createdAt, deleted, version, tag }]
 *
 *   graph.edges(id, { type, direction: 'in'|'out' })
 *     → [{ from, to, type, author, createdAt, deleted }]
 */

/**
 * Create the queryFetcher function for resolveQueries().
 *
 * @param {import('hypergraph').Hypergraph} graph
 * @returns {(filter: object) => Promise<object[]>}
 */
export function createQueryFetcher(graph) {
  return async function queryFetcher(filter) {
    const {
      type,
      tag,
      from,       // entity id for relation traversal (::query{from=route:id})
      relation,   // relation type for traversal (e.g. 'reply')
      sortField,
      sortDir,
      limit,
    } = filter

    let entities = []

    if (from && relation) {
      // Relation traversal: get all entities connected to `from` via `relation`.
      // Hypergraph uses edges() for this, not query() — different code path.
      // direction:'in' means "entities that point TO `from` via `relation`"
      // which is the natural meaning for "replies to this post".
      const edgeList = []
      for await (const edge of graph.edges(from, { type: relation, direction: 'in' })) {
        if (!edge.deleted) edgeList.push(edge)
      }
      // Fetch the full entity for each edge source
      const fetched = await Promise.all(edgeList.map(e => graph.get(e.from)))
      entities = fetched.filter(Boolean).filter(e => !e.deleted)
    } else if (tag) {
      // Tag-based query: getByTag() returns entities directly
      const tagged = []
      for await (const node of graph.getByTag(tag)) {
        if (!node.deleted) tagged.push(node)
      }
      entities = tagged
      // Apply type filter if both tag and type are specified
      if (type) entities = entities.filter(e => e.type === type)
    } else if (type) {
      // Type-based query: the most common case
      entities = await graph.query().type(type).toArray()
      entities = entities.filter(e => !e.deleted)
    } else {
      // No filter — not something we'd normally do in a hypersite, but
      // return empty rather than crash
      if (process.env.HYPERBBS_DEBUG) {
        process.stderr.write('[db] queryFetcher called with no type, tag, or from — returning empty\n')
      }
      return []
    }

    // Apply sort
    if (sortField === 'createdAt') {
      entities.sort((a, b) => sortDir === 'desc'
        ? b.createdAt - a.createdAt
        : a.createdAt - b.createdAt)
    }

    // Apply limit
    if (limit != null) entities = entities.slice(0, Number(limit))

    // Assemble each entity into the { entity, content, tags, relations }
    // envelope the template engine expects. Content is fetched concurrently.
    const items = await Promise.all(entities.map(e => assembleItem(graph, e)))
    return items
  }
}

/**
 * Assemble a single template item from a raw Hypergraph entity.
 * Fetches content and (future) tag/relation metadata concurrently.
 */
async function assembleItem(graph, entity) {
  // Fetch content (null if none stored, or encrypted without key)
  let content = null
  try {
    const raw = await graph.getContent(entity.id)
    if (raw && !raw.encrypted) {
      content = { body: raw.body, contentType: raw.contentType }
    } else if (raw?.encrypted) {
      content = { body: '[encrypted]', contentType: raw.contentType }
    }
  } catch {
    // getContent() throws if entity has no content — treat as null
  }

  return {
    entity: {
      id:        entity.id,
      type:      entity.type,
      author:    entity.author,
      createdAt: entity.createdAt,
    },
    content,
    tags:      [],       // future: fetch via tag index
    relations: {},       // future: fetch edge counts
  }
}

/**
 * Create the sandbox db callbacks for SandboxHost.
 * These handle db.query(), db.get(), db.put() calls from :::script blocks.
 *
 * @param {import('hypergraph').Hypergraph} graph
 * @returns {{ onDbQuery, onDbGet, onDbPut }}
 */
export function createSandboxDbCallbacks(graph) {
  const fetcher = createQueryFetcher(graph)

  return {
    async onDbQuery(msg, respond) {
      try {
        const items = await fetcher(msg.filter)
        respond({ kind: 'query_result', requestId: msg.requestId, result: items })
      } catch (e) {
        respond({ kind: 'query_result', requestId: msg.requestId, result: [], error: e.message })
      }
    },

    async onDbGet(msg, respond) {
      try {
        const entity = await graph.get(msg.key)
        const content = entity ? await graph.getContent(msg.key).catch(() => null) : null
        respond({
          kind: 'get_result',
          requestId: msg.requestId,
          result: entity ? { entity, content } : null,
        })
      } catch (e) {
        respond({ kind: 'get_result', requestId: msg.requestId, result: null, error: e.message })
      }
    },

    async onDbPut(msg, respond) {
      try {
        // All writes go through the structured primitives we designed.
        // `msg.primitive` determines which Hypergraph method to call.
        let result = null
        const d = msg.data

        switch (msg.primitive) {
          case 'entity':
            result = await graph.put({ type: d.type })
            break

          case 'content':
            await graph.putContent(d.entityId, d.body, d.contentType ?? 'text')
            result = { ok: true, entityId: d.entityId }
            break

          case 'relation': {
            const ctx = await graph.createContext()
            await graph.relate({
              from: d.from,
              to: d.to,
              type: d.type,
              context: ctx,
            })
            result = { ok: true }
            break
          }

          case 'tag': {
            const ctx = await graph.createContext()
            await graph.tag(d.entityId, d.tag, { context: ctx })
            result = { ok: true }
            break
          }

          case 'raw':
            // Legacy path used by old db.put(key, value, space) calls in
            // scripts written before the structured primitives were designed.
            // For now, treat `key` as entity type and `value.body` as content.
            if (process.env.HYPERBBS_DEBUG) {
              process.stderr.write(`[db] raw put: ${JSON.stringify(d)}\n`)
            }
            result = await graph.put({ type: d.key?.split(':')[0] ?? 'item' })
            if (d.value?.body) {
              await graph.putContent(result.id, JSON.stringify(d.value), 'application/json')
            }
            break

          default:
            throw new Error(`Unknown primitive: ${msg.primitive}`)
        }

        respond({ kind: 'put_result', requestId: msg.requestId, result })
      } catch (e) {
        respond({ kind: 'put_result', requestId: msg.requestId, result: null, error: e.message })
      }
    },
  }
}
