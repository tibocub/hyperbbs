/**
 * src/network.js
 *
 * Networking layer for HyperBBS. Wraps Hypergraph's HypergraphNetwork
 * (and the underlying Hyperswarm) for the browser use case:
 *
 *   - A visitor types hyper://<topic> in the address bar
 *   - HyperBBSNetwork connects to that topic on the DHT
 *   - Replicates the site's store
 *   - Reads the site's bootstrap descriptor from the graph
 *   - Upgrades to a full HypergraphNetwork connection (writer auth etc.)
 *   - Emits 'ready' when the site's data is accessible
 *   - Emits 'update' when new data arrives from peers
 *
 * The owner side (hosting a site) uses the same class but with
 * role: 'owner' — it generates and stores the bootstrap descriptor
 * in the graph on first run, then announces on the DHT topic.
 *
 * SITE BOOTSTRAP DESCRIPTOR
 * Stored as a well-known entity in the site's own graph so a visitor
 * who only knows the topic can discover everything else after initial
 * replication. Stored under type 'site:bootstrap' by the owner on
 * site creation.
 *
 * SITE ADDRESS FORMAT
 * hyper://<topic-hex>        - 64 hex chars (32 bytes), the DHT topic
 *
 * HyperDNS (future): a DNS record resolves a human name to a hyper://
 * address — HyperBBSNetwork doesn't need to know about DNS at all,
 * the shell resolves names before calling connect().
 */

import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const Hyperswarm = require('hyperswarm')
const { HypergraphNetwork } = require('hypergraph')

// How long to wait (ms) for DHT flush before proceeding anyway.
// Matches the timeout used in the forum example's ForumNetwork.
const FLUSH_TIMEOUT_MS = 2000

// Entity type used to store the site bootstrap descriptor in the graph.
const BOOTSTRAP_ENTITY_TYPE = 'site:bootstrap'

export class HyperBBSNetwork extends EventEmitter {
  /**
   * @param {object} graph     - Hypergraph instance (the visitor's own graph)
   * @param {object} store     - Corestore instance
   * @param {object} [opts]
   * @param {string} [opts.role]      - 'owner' | 'peer' (default: 'peer')
   * @param {number} [opts.maxPeers]  - default 16
   */
  constructor (graph, store, opts = {}) {
    super()
    this._graph    = graph
    this._store    = store
    this._role     = opts.role || 'peer'
    this._maxPeers = opts.maxPeers || 16
    this._swarm    = null
    this._network  = null
    this._topic    = null
    this._ready    = false
    this._destroyed = false
  }

  // ─── Visitor (peer) side ────────────────────────────────────────────────────

  /**
   * Connect to a hypersite by its topic (the hex string from hyper://<topic>).
   * Performs the two-phase connect:
   *   1. Join DHT topic → replicate store → read site bootstrap from graph
   *   2. Upgrade to full HypergraphNetwork with writer auth
   *
   * Emits 'ready' when data is accessible, 'update' on new peer data,
   * 'peer-join'/'peer-leave' for connection lifecycle.
   *
   * @param {string} topicHex - 64-char hex string
   */
  async connect (topicHex) {
    if (this._destroyed) throw new Error('Network instance has been destroyed')

    this._topic = topicHex
    const topicBuf = Buffer.from(topicHex, 'hex')

    this._swarm = new Hyperswarm({ maxPeers: this._maxPeers })

    // Phase 1: raw replication — join the topic and replicate the store
    // so we can read the site's bootstrap descriptor from the graph.
    this._swarm.on('connection', (conn) => {
      this._store.replicate(conn)
      conn.on('error', () => {}) // silence expected disconnect errors
    })

    const discovery = this._swarm.join(topicBuf, { server: true, client: true })

    // Don't block on flush — the forum example uses a 2s timeout and
    // proceeds anyway. DHT announcement timing is best-effort here.
    await withTimeout(discovery.flushed(), FLUSH_TIMEOUT_MS)
    await withTimeout(this._swarm.flush(), FLUSH_TIMEOUT_MS)

    // Wait briefly for initial replication so the bootstrap is available
    await this._graph.update()

    // Phase 2: read bootstrap from graph, upgrade to HypergraphNetwork
    const bootstrap = await this._readBootstrap(topicHex)
    if (!bootstrap) {
      // No bootstrap yet — site may be empty or bootstrap not yet replicated.
      // Stay connected with raw replication and retry on 'update'.
      this.emit('ready', { partial: true })
      this._scheduleBootstrapRetry(topicHex)
      return
    }

    await this._upgradeToNetwork(bootstrap)
    this._ready = true
    this.emit('ready', { partial: false })
  }

  // ─── Owner side ─────────────────────────────────────────────────────────────

  /**
   * Host a site as its owner. Generates or loads the bootstrap descriptor,
   * stores it in the graph, announces on the DHT topic, and starts serving.
   *
   * @param {string} topicHex    - the site's DHT topic (generated once, stored in site config)
   * @param {object} [contexts]  - { name: contextKeyHex } passed to generateBootstrap
   */
  async host (topicHex, contexts = {}) {
    if (this._destroyed) throw new Error('Network instance has been destroyed')

    this._topic = topicHex

    // Store bootstrap in graph if not already there
    let bootstrap = await this._readBootstrap(topicHex)
    if (!bootstrap) {
      bootstrap = HypergraphNetwork.generateBootstrap(this._graph, {
        topic: topicHex,
        contexts,
      })
      await this._writeBootstrap(bootstrap)
    }

    this._swarm = new Hyperswarm({ maxPeers: this._maxPeers })
    this._network = new HypergraphNetwork(
      this._graph, this._store, this._swarm,
      {
        topic: topicHex,
        contexts,
        role: 'owner',
      }
    )

    this._wireNetworkEvents()
    await this._network.connect()

    this._ready = true
    this.emit('ready', { partial: false })
  }

  // ─── Teardown ────────────────────────────────────────────────────────────────

  async destroy () {
    if (this._destroyed) return
    this._destroyed = true

    if (this._network) {
      await this._network.destroy()
    }
    if (this._swarm) {
      // force: true skips Hyperswarm's own unannounce() which can hang
      await this._swarm.destroy({ force: true })
    }

    this.emit('destroyed')
    this.removeAllListeners()
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  /**
   * Read the site's bootstrap descriptor from the graph.
   * Returns null if not yet replicated.
   */
  async _readBootstrap (topicHex) {
    try {
      const results = await this._graph.query()
        .type(BOOTSTRAP_ENTITY_TYPE)
        .toArray()

      if (!results.length) return null

      // Find the bootstrap for this topic
      for (const entity of results) {
        const content = await this._graph.getContent(entity.id)
        if (!content?.body) continue
        let descriptor
        try { descriptor = JSON.parse(content.body) } catch { continue }
        if (descriptor.topic === topicHex) return descriptor
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Store the bootstrap descriptor in the graph as a site:bootstrap entity.
   * Called once by the owner on site creation.
   */
  async _writeBootstrap (bootstrap) {
    const entity = await this._graph.put({ type: BOOTSTRAP_ENTITY_TYPE })
    await this._graph.putContent(entity.id, JSON.stringify(bootstrap), 'application/json')
  }

  /**
   * Upgrade a raw-replication connection to a full HypergraphNetwork,
   * which handles writer-auth via protomux on the existing connection.
   */
  async _upgradeToNetwork (bootstrap) {
    // Destroy raw swarm connections and rebuild under HypergraphNetwork.
    // HypergraphNetwork takes ownership of the same swarm — no new
    // DHT join needed, just replaces the connection handler.
    this._network = await HypergraphNetwork.connectFromBootstrap(
      this._graph, this._store, this._swarm, bootstrap,
      { role: this._role }
    )
    this._wireNetworkEvents()
    await this._network.connect()
  }

  _wireNetworkEvents () {
    if (!this._network) return

    this._network.on('peer-join',       (info) => this.emit('peer-join', info))
    this._network.on('writer-granted',  (msg)  => this.emit('writer-granted', msg))
    this._network.on('writer-error',    (msg)  => this.emit('writer-error', msg))
    this._network.on('flush-timeout',   (info) => this.emit('flush-timeout', info))

    // Emit 'update' when new data arrives so the shell can re-render
    this._graph.on('change', () => this.emit('update'))
  }

  /**
   * If the bootstrap wasn't available on first connect (site data still
   * replicating), retry reading it every 2s until found or destroyed.
   */
  _scheduleBootstrapRetry (topicHex) {
    if (this._destroyed) return
    const interval = setInterval(async () => {
      if (this._destroyed || this._network) {
        clearInterval(interval)
        return
      }
      await this._graph.update()
      const bootstrap = await this._readBootstrap(topicHex)
      if (!bootstrap) return
      clearInterval(interval)
      await this._upgradeToNetwork(bootstrap)
      this._ready = true
      this.emit('ready', { partial: false })
    }, 2000)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withTimeout (promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(resolve, ms))
  ])
}

/**
 * Parse a hyper:// address into a topic hex string.
 * Returns null if the address is invalid.
 *
 * @param {string} address - e.g. "hyper://abc123..."
 * @returns {string|null} 64-char hex topic, or null
 */
export function parseHyperAddress (address) {
  if (!address) return null
  const stripped = address.replace(/^hyper:\/\//i, '').trim()
  if (!/^[0-9a-f]{64}$/i.test(stripped)) return null
  return stripped.toLowerCase()
}

/**
 * Format a topic hex string as a hyper:// address.
 *
 * @param {string} topicHex
 * @returns {string}
 */
export function formatHyperAddress (topicHex) {
  return `hyper://${topicHex}`
}
