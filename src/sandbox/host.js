/**
 * host.js
 *
 * Main-thread side of the scripting sandbox. For each ScriptBlock in
 * a hypersite document, SandboxHost:
 *
 *   1. Spawns a worker running harness.js
 *   2. Sends an INIT message with the script source + HyperDOM snapshot
 *   3. Listens for messages from the worker and dispatches them:
 *      - PATCH      -> updates the real HyperDOM node + its _tuiRef
 *      - DB_QUERY   -> runs a query against the (stub) Hypergraph layer
 *      - DB_PUT     -> writes to the (stub) Hypergraph layer
 *      - DB_GET     -> reads from the (stub) Hypergraph layer
 *      - CONSOLE    -> logs the message without touching OpenTUI's buffer
 *      - NAVIGATE   -> signals the renderer to load a different page
 *      - NOTIFY     -> signals the renderer to show a notification
 *      - SUBSCRIBE  -> records that the worker wants DOM events for a
 *                      specific eventName+nodeId, so the Reconciler
 *                      knows which interactions to forward
 *   4. Forwards real Reconciler interaction events to the worker as
 *      DOM_EVENT messages (only for subscribed event+nodeId pairs)
 *   5. Handles worker errors and lifecycle (terminate on navigate/destroy)
 *
 * The db.* layer is currently stubbed — it logs the intent and returns
 * placeholder data. This is the seam where real Hypergraph integration
 * lands later: replace the stub methods with real db.entity.create()
 * etc. calls against the hypersite's live Hypergraph instance. Nothing
 * in the worker/harness changes when that happens.
 */

import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TextRenderable } from '@opentui/core'
import { buildSnapshot } from './snapshot.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HARNESS_PATH = join(__dirname, 'harness.js')

export class SandboxHost extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../reconciler.js').Reconciler} opts.reconciler
   * @param {object | null} opts.identity - { pubkey } or null
   * @param {object | null} opts.db - real Hypergraph db instance,
   *   or null to use the stub (current default)
   */
  constructor({ reconciler, identity = null, db = null }) {
    super()
    this.reconciler = reconciler
    this.identity   = identity
    this._db        = db

    /** @type {Worker[]} one per ScriptBlock */
    this._workers = []

    /** Set<"eventName:nodeId"> — populated by SUBSCRIBE messages */
    this._subscriptions = new Set()

    // Forward real Reconciler interactions to any subscribed worker
    this.reconciler.on('press',  (node) => this._forwardDomEvent('press',  node))
    this.reconciler.on('change', (node, detail) => this._forwardDomEvent('change', node, detail))
  }

  /**
   * Start a worker for each ScriptBlock in the document.
   *
   * @param {object[]} scripts - doc.scripts from hypermd's parse()
   * @param {object[]} nodes   - doc.nodes (used to build the snapshot)
   */
  runScripts(scripts, nodes) {
    const snapshot = buildSnapshot(nodes)

    for (const scriptNode of scripts) {
      if (!scriptNode.props.source) {
        // External script that hasn't been resolved yet, or explicitly
        // empty. Skip rather than run an empty function body.
        if (process.env.HYPERBBS_DEBUG) {
          console.warn(`[hyperbbs] skipping script block with no source (id: ${scriptNode.id ?? 'anon'})`)
        }
        continue
      }
      this._spawnWorker(scriptNode, snapshot)
    }
  }

  /**
   * Stop all workers. Called when the renderer navigates away from the
   * current page, so scripts from the old page don't keep running (and
   * especially don't keep sending PATCH messages to a dismounted tree).
   */
  destroy() {
    for (const worker of this._workers) {
      worker.terminate()
    }
    this._workers = []
    this._subscriptions.clear()
    this.removeAllListeners()
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _spawnWorker(scriptNode, snapshot) {
    const worker = new Worker(HARNESS_PATH, {
      // Pass nothing via workerData — all bootstrapping goes through
      // the INIT message so the protocol stays in one place.
      workerData: null,
    })

    this._workers.push(worker)

    worker.on('message', (msg) => this._handleWorkerMessage(msg, worker))

    worker.on('error', (err) => {
      console.error(`[hyperbbs] worker error (script: ${scriptNode.id ?? 'anon'}):`, err.message)
    })

    worker.on('exit', (code) => {
      if (code !== 0 && process.env.HYPERBBS_DEBUG) {
        console.warn(`[hyperbbs] worker exited with code ${code} (script: ${scriptNode.id ?? 'anon'})`)
      }
      this._workers = this._workers.filter(w => w !== worker)
    })

    // Send the INIT message — this kicks off script execution in the harness
    worker.postMessage({
      kind: 'init',
      scriptId: scriptNode.id ?? `anon-${Date.now()}`,
      source: scriptNode.props.source,
      snapshot,
      identity: this.identity,
    })
  }

  _handleWorkerMessage(msg, worker) {
    switch (msg.kind) {
      case 'patch':
        this._applyPatch(msg)
        break

      case 'subscribe':
        this._subscriptions.add(`${msg.eventName}:${msg.nodeId}`)
        break

      case 'db_query':
        this._handleDbQuery(msg, worker)
        break

      case 'db_get':
        this._handleDbGet(msg, worker)
        break

      case 'db_put':
        this._handleDbPut(msg, worker)
        break

      case 'navigate':
        this.emit('navigate', msg.address)
        break

      case 'notify':
        this.emit('notify', msg.text, msg.level)
        break

      case 'console':
        // Route to stderr to avoid corrupting OpenTUI's stdout buffer
        process.stderr.write(`[script:${msg.level}] ${msg.args.join(' ')}\n`)
        break

      case 'script_error':
        process.stderr.write(`[script:error] ${msg.message}\n`)
        if (msg.stack && process.env.HYPERBBS_DEBUG) {
          process.stderr.write(msg.stack + '\n')
        }
        break

      default:
        if (process.env.HYPERBBS_DEBUG) {
          console.warn('[hyperbbs] unknown worker message kind:', msg.kind)
        }
    }
  }

  /**
   * Apply a PATCH message from a worker to the real HyperDOM tree.
   * Currently handles:
   *   - Arbitrary prop merges (sets props on the node and its _tuiRef)
   *   - _data: a list of strings to display in a container node
   *     (used by list.setData() — the main "script updates displayed
   *     content" primitive until a full reactive re-render is built)
   */
  _applyPatch(msg) {
    const node = this.reconciler.getElementById(msg.nodeId)
    if (!node) {
      if (process.env.HYPERBBS_DEBUG) {
        console.warn(`[hyperbbs] PATCH targeting unknown node id: "${msg.nodeId}"`)
      }
      return
    }

    const { _data, content, ...propUpdates } = msg.props

    // Merge plain prop updates onto the node and its _tuiRef setters
    Object.assign(node.props, propUpdates)
    if (node._tuiRef) {
      for (const [k, v] of Object.entries(propUpdates)) {
        try { node._tuiRef[k] = v } catch { /* no setter for this prop */ }
      }
    }

    // `content`: direct text content update.
    // If the node's own _tuiRef has a .content setter (TextRenderable),
    // use it directly. If the node is a container (BoxRenderable — e.g.
    // a :::panel whose text lives in a child Paragraph), walk into the
    // first child that does have a .content setter. This covers both:
    //   paragraph.setText('...')  — targets the TextRenderable directly
    //   panel.setText('...')      — walks into the first Paragraph child
    if (content != null && node._tuiRef) {
      const target = this._findTextTarget(node._tuiRef)
      if (target) {
        try { target.content = content } catch { /* setter rejected value */ }
      } else if (process.env.HYPERBBS_DEBUG) {
        console.warn(`[hyperbbs] setText on #${msg.nodeId}: no TextRenderable found on node or its children`)
      }
    }

    // `_data`: re-render the node's content as a list of string items
    if (_data != null && node._tuiRef) {
      this._applyDataList(node, _data)
    }
  }

  /**
   * Render an array of strings as Text children of a container node,
   * replacing whatever was there before. The reconciler's existing
   * add()/remove() primitives are sufficient for this — no full diff needed.
   */
  /**
   * Find the first renderable in a subtree that has a writable .content
   * property (i.e. a TextRenderable). Checks the node itself first, then
   * walks children depth-first. Returns null if nothing found.
   *
   * This lets setText() work naturally on both leaf text nodes and
   * container nodes (panels, forms) whose visible text is a child
   * TextRenderable — without the script author needing to know which
   * level of the tree holds the actual text content.
   */
  _findTextTarget(renderable) {
    if (!renderable) return null

    // Walk the full prototype chain to find a .content setter, since it
    // may be defined several levels up the inheritance hierarchy.
    // Confirmed via probe: BoxRenderable has no .content setter anywhere
    // in its chain; TextRenderable does.
    if (this._hasContentSetter(renderable)) return renderable

    // Walk children depth-first
    if (renderable.getChildren) {
      for (const child of renderable.getChildren()) {
        const found = this._findTextTarget(child)
        if (found) return found
      }
    }

    return null
  }

  _hasContentSetter(obj) {
    // Check own properties first (handles plain object stubs in tests,
    // and any renderable that defines content directly on the instance).
    const own = Object.getOwnPropertyDescriptor(obj, 'content')
    if (own?.set) return true
    // Then walk the prototype chain (handles real OpenTUI class instances,
    // where the setter is defined on the class prototype, not the instance).
    let proto = Object.getPrototypeOf(obj)
    while (proto && proto !== Object.prototype) {
      const d = Object.getOwnPropertyDescriptor(proto, 'content')
      if (d?.set) return true
      proto = Object.getPrototypeOf(proto)
    }
    return false
  }

  _applyDataList(node, items) {
    const box = node._tuiRef
    if (!box?.getChildren || !box?.remove || !box?.add) return

    // Remove only previously-dynamic children, not static HyperMD ones.
    // OpenTUI auto-generates an id for every Renderable even when none
    // is provided (confirmed: new TextRenderable(ctx, {}).id returns
    // e.g. "renderable-2") so remove(renderable.id) is always safe.
    if (node._dynamicChildren) {
      for (const childId of node._dynamicChildren) {
        try { box.remove(childId) } catch { /* already gone */ }
      }
    }
    node._dynamicChildren = []

    for (const item of items) {
      const text = new TextRenderable(this.reconciler.ctx, {
        content: String(item),
      })
      box.add(text)
      node._dynamicChildren.push(text.id)
    }
  }

  _forwardDomEvent(eventName, node, detail) {
    if (!node.id) return
    if (!this._subscriptions.has(`${eventName}:${node.id}`)) return

    for (const worker of this._workers) {
      worker.postMessage({
        kind: 'dom_event',
        eventName,
        nodeId: node.id,
        detail: detail ?? {},
      })
    }
  }

  // ─── Hypergraph stub (replace with real db calls later) ─────────────────────

  async _handleDbQuery(msg, worker) {
    if (process.env.HYPERBBS_DEBUG) {
      console.warn('[hyperbbs:db] db_query (stub):', JSON.stringify(msg.filter))
    }
    // Stub: return empty results. When Hypergraph is wired in, replace
    // this with a real GraphQuery built from msg.filter.
    worker.postMessage({
      kind: 'query_result',
      requestId: msg.requestId,
      result: [],
    })
  }

  async _handleDbGet(msg, worker) {
    if (process.env.HYPERBBS_DEBUG) {
      console.warn(`[hyperbbs:db] db_get (stub): key=${msg.key} space=${msg.space}`)
    }
    worker.postMessage({
      kind: 'get_result',
      requestId: msg.requestId,
      result: null,
    })
  }

  async _handleDbPut(msg, worker) {
    if (process.env.HYPERBBS_DEBUG) {
      console.warn(`[hyperbbs:db] db_put (stub): primitive=${msg.primitive}`, JSON.stringify(msg.data))
    }
    worker.postMessage({
      kind: 'put_result',
      requestId: msg.requestId,
      result: { ok: true },
    })
  }
}