/**
 * sandbox/host.js
 *
 * Main-thread side of the scripting sandbox. Renderer-agnostic — has
 * zero knowledge of OpenTUI, the DOM, or any specific rendering target.
 *
 * Renderer-specific behaviour (how to apply a patch to a real node,
 * where to route console output) is injected via callbacks at
 * construction time, making this class reusable by both the TUI
 * renderer and a future web renderer without modification.
 *
 * Callbacks:
 *   onPatch(nodeId, props, getElementById)
 *     Called when a script sends a PATCH message. The renderer is
 *     responsible for applying the prop changes to whatever its native
 *     node representation is (OpenTUI _tuiRef, DOM element, etc).
 *     `getElementById` is the reconciler's lookup function, provided
 *     as a convenience so the callback doesn't need a reconciler ref.
 *
 *   onConsole(level, args)
 *     Called when a script calls console.log/warn/error. The renderer
 *     decides where to display this (stderr, an overlay panel, etc).
 *     Default: write to process.stderr.
 *
 *   onScriptError(message, stack)
 *     Called when a script throws. Default: write to process.stderr.
 */

import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildSnapshot } from './snapshot.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HARNESS_PATH = join(__dirname, 'harness.js')

export class SandboxHost extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{ getElementById: (id: string) => object|null, on: Function }} opts.reconciler
   * @param {object | null} opts.identity
   * @param {object | null} opts.db
   * @param {(nodeId: string, props: object, getElementById: Function) => void} [opts.onPatch]
   * @param {(level: string, args: string[]) => void} [opts.onConsole]
   * @param {(message: string, stack?: string) => void} [opts.onScriptError]
   */
  constructor({
    reconciler,
    identity    = null,
    db          = null,
    onPatch     = null,
    onConsole   = null,
    onScriptError = null,
  }) {
    super()
    this.reconciler = reconciler
    this.identity   = identity
    this._db        = db

    // Renderer-injected callbacks — fall back to safe defaults
    this._onPatch = onPatch ?? defaultOnPatch
    this._onConsole = onConsole ?? defaultOnConsole
    this._onScriptError = onScriptError ?? defaultOnScriptError

    this._workers = []
    this._subscriptions = new Set()

    this.reconciler.on('press',  (node) => this._forwardDomEvent('press',  node))
    this.reconciler.on('change', (node, detail) => this._forwardDomEvent('change', node, detail))
  }

  runScripts(scripts, nodes) {
    const snapshot = buildSnapshot(nodes)
    for (const scriptNode of scripts) {
      if (!scriptNode.props.source) {
        if (process.env.HYPERBBS_DEBUG) {
          console.warn(`[sandbox] skipping script with no source (id: ${scriptNode.id ?? 'anon'})`)
        }
        continue
      }
      this._spawnWorker(scriptNode, snapshot)
    }
  }

  destroy() {
    for (const worker of this._workers) worker.terminate()
    this._workers = []
    this._subscriptions.clear()
    this.removeAllListeners()
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _spawnWorker(scriptNode, snapshot) {
    const worker = new Worker(HARNESS_PATH, { workerData: null })
    this._workers.push(worker)

    worker.on('message', (msg) => this._handleWorkerMessage(msg, worker))
    worker.on('error', (err) => {
      this._onScriptError(`Worker error (${scriptNode.id ?? 'anon'}): ${err.message}`)
    })
    worker.on('exit', (code) => {
      if (code !== 0 && process.env.HYPERBBS_DEBUG) {
        console.warn(`[sandbox] worker exited code ${code} (${scriptNode.id ?? 'anon'})`)
      }
      this._workers = this._workers.filter(w => w !== worker)
    })

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
        this._onPatch(msg.nodeId, msg.props, this.reconciler.getElementById.bind(this.reconciler))
        break

      case 'subscribe':
        this._subscriptions.add(`${msg.eventName}:${msg.nodeId}`)
        break

      case 'db_query':   this._handleDbQuery(msg, worker);  break
      case 'db_get':     this._handleDbGet(msg, worker);    break
      case 'db_put':     this._handleDbPut(msg, worker);    break

      case 'navigate':   this.emit('navigate', msg.address); break
      case 'notify':     this.emit('notify', msg.text, msg.level); break

      case 'console':
        this._onConsole(msg.level, msg.args)
        break

      case 'script_error':
        this._onScriptError(msg.message, msg.stack)
        break

      default:
        if (process.env.HYPERBBS_DEBUG) {
          console.warn('[sandbox] unknown worker message kind:', msg.kind)
        }
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

  // ─── Hypergraph stub ───────────────────────────────────────────────────────

  async _handleDbQuery(msg, worker) {
    if (process.env.HYPERBBS_DEBUG) {
      console.warn('[sandbox:db] db_query (stub):', JSON.stringify(msg.filter))
    }
    worker.postMessage({ kind: 'query_result', requestId: msg.requestId, result: [] })
  }

  async _handleDbGet(msg, worker) {
    if (process.env.HYPERBBS_DEBUG) {
      console.warn(`[sandbox:db] db_get (stub): key=${msg.key}`)
    }
    worker.postMessage({ kind: 'get_result', requestId: msg.requestId, result: null })
  }

  async _handleDbPut(msg, worker) {
    if (process.env.HYPERBBS_DEBUG) {
      console.warn(`[sandbox:db] db_put (stub): primitive=${msg.primitive}`)
    }
    worker.postMessage({ kind: 'put_result', requestId: msg.requestId, result: { ok: true } })
  }
}

// ─── Default callbacks (Node.js / stderr) ─────────────────────────────────────

function defaultOnConsole(level, args) {
  process.stderr.write(`[script:${level}] ${args.join(' ')}\n`)
}

function defaultOnScriptError(message, stack) {
  process.stderr.write(`[script:error] ${message}\n`)
  if (stack && process.env.HYPERBBS_DEBUG) {
    process.stderr.write(stack + '\n')
  }
}

// The default onPatch is a no-op — if no callback is provided the
// sandbox still runs correctly, patches just have no visible effect.
// Renderers always provide their own.
function defaultOnPatch(_nodeId, _props, _getElementById) {}