/**
 * harness.js
 *
 * Runs inside the worker thread. Receives an INIT message, sets up
 * the `hypersite`, `db`, and `identity` proxy API objects, then
 * evaluates the hypersite's script source against them via
 * new Function(). All interaction with the main thread (real DOM
 * patches, Hypergraph queries) goes through postMessage.
 *
 * This file intentionally imports NOTHING that could give the harness
 * (and by extension, the untrusted script) access to fs, net, or
 * process internals. The only import is parentPort from worker_threads,
 * which is the controlled channel back to the host.
 *
 * Security model: the isolation boundary is this worker thread, not
 * a vm.Context. `new Function()` inside a stripped-down worker is
 * roughly equivalent in JS-level isolation to node:vm's runInContext
 * (both are V8 context restrictions on global scope), but the worker
 * thread boundary provides real OS-level isolation on top — the
 * harness itself can't reach anything it doesn't import, and we import
 * nothing dangerous. See protocol.js for the full message shape docs.
 */

import { parentPort, workerData } from 'node:worker_threads'

// ─── Pending RPC table ────────────────────────────────────────────────────────
// Maps requestId -> { resolve, reject } for in-flight db.* calls.
// Each db call sends a message to the host and awaits the response
// here before returning to the script.

const pending = new Map()
let nextId = 1
function makeRequestId() { return String(nextId++) }

// ─── Event handler registry ───────────────────────────────────────────────────
// Maps "eventName:nodeId" -> Set of handler functions registered by
// the script via element.on(eventName, fn).

const handlers = new Map()

function registerHandler(eventName, nodeId, fn) {
  const key = `${eventName}:${nodeId}`
  if (!handlers.has(key)) handlers.set(key, new Set())
  handlers.get(key).add(fn)
}

// ─── Incoming message dispatch ────────────────────────────────────────────────

parentPort.on('message', async (msg) => {
  switch (msg.kind) {
    case 'init':
      await handleInit(msg)
      break

    case 'dom_event': {
      const key = `${msg.eventName}:${msg.nodeId}`
      const fns = handlers.get(key)
      if (fns) {
        for (const fn of fns) {
          try {
            await fn(msg.detail ?? {})
          } catch (e) {
            send({ kind: 'script_error', message: e.message, stack: e.stack })
          }
        }
      }
      break
    }

    case 'query_result':
    case 'get_result':
    case 'put_result': {
      const p = pending.get(msg.requestId)
      if (p) {
        pending.delete(msg.requestId)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      }
      break
    }
  }
})

function send(msg) {
  parentPort.postMessage(msg)
}

function rpc(msg) {
  return new Promise((resolve, reject) => {
    pending.set(msg.requestId, { resolve, reject })
    send(msg)
  })
}

// ─── API objects exposed to the script ───────────────────────────────────────

/**
 * Build the `hypersite` proxy — the script's window into the HyperDOM.
 * Operations that read local snapshot state are synchronous; operations
 * that mutate the real tree go over postMessage and are synchronous-
 * looking at the script level but actually async under the hood (the
 * script uses await, but this is still non-blocking from the main
 * thread's perspective since they're on different threads).
 */
function buildHypersiteApi(snapshot) {
  // Per-element handle: what a script gets back from getElementById().
  function elementHandle(id) {
    const mirror = snapshot[id]

    return {
      get id() { return id },
      get type() { return mirror?.type ?? null },

      // Props are readable from the local snapshot — these are the
      // props as they were at init time, not live-updated. For
      // most use cases (reading an input's value, checking a prop
      // set by the hypersite author) this is sufficient. Scripts
      // that need to react to live changes should use .on() instead.
      get props() { return { ...(mirror?.props ?? {}) } },

      // Convenience getters for the most common interactive props
      get value() { return mirror?.props?.value ?? '' },

      // Convenience alias used by script authors: input.clear()
      clear() {
        if (mirror?.props) mirror.props.value = ''
        send({ kind: 'patch', nodeId: id, props: { value: '' } })
      },

      // setData: replaces the node's content with a list of items.
      // The host renders each as a separate Text row inside the container.
      setData(items) {
        send({ kind: 'patch', nodeId: id, props: { _data: items } })
      },

      // setText: sets a single text node's content directly.
      // Works on Paragraph, Heading, or any node backed by a TextRenderable.
      setText(text) {
        if (mirror?.props) mirror.props.content = text
        send({ kind: 'patch', nodeId: id, props: { content: text } })
      },

      // Register an event handler for a real DOM interaction.
      // Returns `this` so handlers can be chained if needed.
      on(eventName, fn) {
        registerHandler(eventName, id, fn)
        // Tell the host we're interested in this event on this node,
        // so it knows to forward it when it fires on the real
        // Renderable. (The host could forward all events speculatively,
        // but explicitly subscribing avoids unnecessary postMessage
        // traffic for events nobody's listening to.)
        send({ kind: 'subscribe', eventName, nodeId: id })
        return this
      },
    }
  }

  return {
    getElementById(id) {
      if (!snapshot[id]) {
        console.warn(`[hypersite] getElementById("${id}"): no element with this id in snapshot`)
        return elementHandle(id) // return a stub rather than null — avoids NPE on .on() chains
      }
      return elementHandle(id)
    },

    querySelectorAll(type) {
      return Object.entries(snapshot)
        .filter(([, node]) => node.type === type)
        .map(([id]) => elementHandle(id))
    },

    navigate(address) {
      send({ kind: 'navigate', address })
    },

    notify(text, level = 'info') {
      send({ kind: 'notify', text, level })
    },
  }
}

/**
 * Build the `db` API — the script's interface to the hypersite's
 * Hypergraph. Every call is an async RPC to the main thread. Matches
 * the structured-primitives API we defined in the README (entity,
 * content, relation, tag).
 *
 * Also exposes a `db.query()` shorthand (matching the older
 * GraphQuery-style usage in existing script examples) for backward
 * compatibility with the scripts already written.
 */
function buildDbApi() {
  async function rpcCall(primitive, data) {
    const requestId = makeRequestId()
    return rpc({ kind: 'db_put', requestId, primitive, data })
  }

  return {
    entity: {
      async create(data) { return rpcCall('entity', data) },
    },
    content: {
      async attach(data) { return rpcCall('content', data) },
    },
    relation: {
      async create(data) { return rpcCall('relation', data) },
    },
    tag: {
      async add(data) { return rpcCall('tag', data) },
    },

    async get(key, space) {
      const requestId = makeRequestId()
      return rpc({ kind: 'db_get', requestId, key, space })
    },

    async put(key, value, space) {
      const requestId = makeRequestId()
      return rpc({ kind: 'db_put', requestId, primitive: 'raw', data: { key, value, space } })
    },

    // query() returns a builder stub that collects filter options and
    // sends them as a single db_query message when .exec() is called.
    query() {
      const filter = {}
      const builder = {
        match(pattern) { filter.match = pattern; return builder },
        in(space)      { filter.space = space;   return builder },
        type(t)        { filter.type = t;        return builder },
        tag(tag)       { filter.tag = tag;       return builder },
        limit(n)       { filter.limit = n;       return builder },
        sort(s)        { filter.sort = s;        return builder },
        live(flag)     { filter.live = flag;     return builder },
        async exec() {
          const requestId = makeRequestId()
          return rpc({ kind: 'db_query', requestId, filter })
        },
      }
      return builder
    },
  }
}

// ─── Init handler ─────────────────────────────────────────────────────────────

async function handleInit(msg) {
  const { source, snapshot, identity, scriptId } = msg

  // Override console.* so the worker's output goes to the main thread
  // (which can log it to a debug overlay or stderr) rather than writing
  // raw bytes to stdout, which would corrupt OpenTUI's screen buffer.
  const safeStringify = (v) => {
    try { return typeof v === 'string' ? v : JSON.stringify(v) }
    catch { return String(v) }
  }

  const makeConsoleMethod = (level) => (...args) => {
    send({ kind: 'console', level, args: args.map(safeStringify) })
  }

  const sandboxConsole = {
    log:   makeConsoleMethod('log'),
    warn:  makeConsoleMethod('warn'),
    error: makeConsoleMethod('error'),
  }

  const hypersite = buildHypersiteApi(snapshot)
  const db        = buildDbApi()

  // Evaluate the script source. new Function() creates a function whose
  // body is the script, with named parameters for each injected global.
  // The script's own `var`/`let`/`const` declarations are scoped to
  // the function body — not to the worker global — which is exactly
  // what we want (same-ish isolation as vm.runInContext without
  // requiring the node:vm module, keeping this Bare-portable).
  let scriptFn
  try {
    scriptFn = new Function(
      'hypersite', 'db', 'identity', 'console',
      // Wrap in an async IIFE so the script can use top-level await
      // (matching how our existing sample scripts are written).
      `return (async () => {\n${source}\n})()`
    )
  } catch (e) {
    send({ kind: 'script_error', message: `Syntax error in ${scriptId}: ${e.message}`, stack: e.stack })
    return
  }

  try {
    await scriptFn(hypersite, db, identity, sandboxConsole)
  } catch (e) {
    send({ kind: 'script_error', message: `Runtime error in ${scriptId}: ${e.message}`, stack: e.stack })
  }
}