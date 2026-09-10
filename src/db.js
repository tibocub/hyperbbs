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
 *     Passing an id now throws ('Entity id must NOT be provided').
 *
 *   graph.query().type(t).toArray()
 *     → [{ id, type, author, createdAt, deleted, version }]
 *
 *   graph.getContent(id)
 *     → UNENCRYPTED: { entityId, contentType, body, createdAt, encrypted, scope, epoch, nonce }
 *       ENCRYPTED:   { contentType, body, encrypted: true, scope, epoch }
 *                    (narrower — no entityId, no createdAt, no nonce)
 *       → null if the entity has no content record. It does NOT throw.
 *     `encrypted: true` means "was stored encrypted", NOT "you can't read it" —
 *     hypergraph returns encrypted:true together with the decrypted plaintext when
 *     we hold the scope key. Test `body === null` for inaccessible content.
 *
 *   graph.getByTag(tag)
 *     → [{ id, type, author, createdAt, deleted, version, tag }]
 *
 *   graph.edges(id, { type, direction: 'in'|'out' })
 *     → [{ from, to, type, author, createdAt, deleted }]
 *
 * CONTEXT RULE (hypergraph src/utils.js resolveOpenContexts): once MORE THAN ONE
 * context is open on a graph instance, any context-scoped read that passes neither
 * { context } nor { allContexts: true } THROWS. The reads in this file
 * (graph.edges, graph.getByTag) deliberately pass no context, so this file must
 * never open more than one. See getWriteContext() below.
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
    // Discriminate on `body`, NOT on `encrypted`. hypergraph returns
    // `encrypted: true` on every record that was STORED encrypted — including
    // ones it just successfully decrypted for us (src/hypergraph.js getContent()
    // returns `{ body: <plaintext>, encrypted: true }` when we hold the scope key).
    // `body === null` is the real "you can't read this" signal. Keying off
    // `encrypted` rendered [encrypted] over content we could actually read.
    if (raw && raw.body !== null && raw.body !== undefined) {
      content = { body: raw.body, contentType: raw.contentType }
    } else if (raw) {
      content = { body: '[encrypted]', contentType: raw.contentType }
    }
  } catch {
    // Defensive only — getContent() returns null for a missing content record,
    // it does not throw.
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

  // ONE context, shared by every sandbox write, created lazily on first use.
  //
  // This used to be `await graph.createContext()` inline at each write site. That was
  // wrong twice over: (1) hypergraph's resolveOpenContexts() (src/utils.js) THROWS once
  // more than one context is open on a graph instance and a context-scoped read doesn't
  // say which one — so the second sandbox relation/tag write permanently broke every
  // subsequent :::query{tag=...} and relation traversal, which pass no { context };
  // and (2) each write landed in its own throwaway context, so the tag/edge it wrote was
  // invisible to reads anyway. Memoizing keeps contexts.size at 1 and makes writes
  // mutually visible. Do not move this back inside a write.
  let sharedContext = null
  let sharedContextPromise = null
  async function getWriteContext() {
    if (sharedContext) return sharedContext
    if (!sharedContextPromise) sharedContextPromise = graph.createContext()
    sharedContext = await sharedContextPromise
    return sharedContext
  }

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
            const ctx = await getWriteContext()
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
            const ctx = await getWriteContext()
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
