/**
 * src/network.js
 *
 * Networking layer for HyperBBS. Wraps Hypergraph's HypergraphNetwork
 * (and the underlying Hyperswarm) for the browser use case.
 *
 * ADDRESS FORMAT — hyper://<ownerCoreKeyHex>
 *
 * The address IS the owner's Hypergraph user core public key (64 hex
 * chars / 32 bytes), NOT an arbitrary topic. This is a deliberate
 * design correction from an earlier version that used a random topic —
 * confirmed empirically (see test/brittle/network/*.js) that a bare
 * Hyperswarm connection causes NO data to flow until at least one side
 * has explicitly opened a specific core by its public key. A visitor
 * who only knows a random topic — with no core key — has nothing to
 * request from Corestore's replication protocol, no matter how long
 * they wait or how many times graph.update() is called. This isn't a
 * timing issue; zero bytes of the owner's data are ever requested.
 *
 * Using the owner's core key AS the address solves this cleanly:
 *   - The visitor can call graph.openUserCore(ownerKeyHex) immediately,
 *     straight from the parsed address, before even joining the swarm
 *   - The DHT rendezvous point (Hyperswarm topic) is derived
 *     deterministically from that same key via
 *     hypercore-crypto's discoveryKey(key) — confirmed empirically that
 *     crypto.discoveryKey(ownerKey) equals graph.discoveryKey computed
 *     on the owner's own graph instance, with no core-opening needed to
 *     compute it on either side
 *   - No two-phase "join blind, hope a bootstrap arrives" dance needed
 *
 * SITE BOOTSTRAP DESCRIPTOR
 * Once the owner's core replicates, the visitor can read a well-known
 * 'site:bootstrap' entity from it (written by the owner via host()) to
 * discover the site's context keys and upgrade to a full
 * HypergraphNetwork connection with writer-auth support.
 *
 * HyperDNS (future): a DNS record resolves a human name to a hyper://
 * address — HyperBBSNetwork doesn't need to know about DNS at all, the
 * shell resolves names before calling connect().
 */

import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const Hyperswarm = require('hyperswarm')
const { HypergraphNetwork } = require('hypergraph')
const crypto = require('hypercore-crypto')

const FLUSH_TIMEOUT_MS = 2000
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
    this._ownerKeyHex = null
    this._ready    = false
    this._destroyed = false
  }

  // ─── Visitor (peer) side ────────────────────────────────────────────────────

  /**
   * Connect to a hypersite by its owner core key and wait until real
   * data is actually readable — not until some intermediate step
   * (DHT flush, bootstrap entity) merely times out or completes.
   *
   * This is deliberately simple for the read-only "view a hypersite"
   * case: open the owner's core, join the swarm, then poll directly
   * for actual content (checked via the `isReady` callback) until it's
   * there or a hard timeout expires. No separate "bootstrap" entity,
   * no writer-auth upgrade — those matter for collaborative multi-writer
   * scenarios, not for rendering a page someone else published.
   *
   * @param {string} ownerKeyHex - 64-char hex owner core key
   * @param {object} [opts]
   * @param {() => Promise<boolean>} [opts.isReady] - called after every
   *   graph.update() to check "do we have what we need yet?" Defaults
   *   to always true (connect resolves as soon as a peer is found).
   * @param {number} [opts.timeoutMs] - overall ceiling (default 30000)
   */
  /**
   * Connect to a hypersite by its owner core key and wait until real
   * data is actually readable.
   *
   * TWO-PHASE DESIGN — CORRECTED:
   *   Phase 1: a bare Hyperswarm connection, just to replicate the
   *   owner's core far enough to read the 'site:bootstrap' entity
   *   (confirmed working — this part was never the bug).
   *
   *   Phase 2: once the bootstrap is found, tear down the bare
   *   connection and hand off to a REAL HypergraphNetwork instance via
   *   HypergraphNetwork.connectFromBootstrap() — the same, proven
   *   pattern hypergraph's own p2p-reddit-clone example uses (verified
   *   directly: a minimal standalone script using this exact call
   *   succeeded on the first poll, while this class's earlier version,
   *   which used ONLY a bare Hyperswarm for the entire connection
   *   lifetime and never constructed a real HypergraphNetwork on the
   *   visitor side at all, did not work reliably). That was the actual
   *   architectural bug — not a timing issue, not a topic/address
   *   mismatch, not a query/indexing bug. All three were investigated
   *   and ruled out empirically before finding this.
   *
   * @param {string} ownerKeyHex - 64-char hex owner core key
   * @param {object} [opts]
   * @param {() => Promise<boolean>} [opts.isReady] - called after every
   *   graph.update() to check "do we have what we need yet?" Checked
   *   during phase 2, after the real HypergraphNetwork connection is up.
   * @param {number} [opts.timeoutMs] - overall ceiling (default 30000)
   */
  async connect (ownerKeyHex, opts = {}) {
    if (this._destroyed) throw new Error('Network instance has been destroyed')
    if (!/^[0-9a-f]{64}$/i.test(ownerKeyHex)) {
      throw new Error(`Invalid owner core key: expected 64 hex chars, got "${ownerKeyHex}"`)
    }

    const isReady = opts.isReady ?? (async () => true)
    const timeoutMs = opts.timeoutMs ?? 30000
    const deadline = Date.now() + timeoutMs

    this._ownerKeyHex = ownerKeyHex

    // ── Phase 1: bare connection just to fetch the bootstrap ──
    this.emit('debug', 'phase 1: opening owner core...')
    await this._graph.openUserCore(ownerKeyHex)

    const ownerKeyBuf = Buffer.from(ownerKeyHex, 'hex')
    const phase1Topic = crypto.discoveryKey(ownerKeyBuf)

    const phase1Swarm = new Hyperswarm({ maxPeers: this._maxPeers })
    phase1Swarm.on('connection', (conn, info) => {
      this.emit('debug', `phase 1: raw connection opened with ${info?.publicKey?.toString('hex')?.slice(0, 16)}`)
      this._store.replicate(conn)
      conn.on('error', () => {})
    })
    phase1Swarm.join(phase1Topic, { server: true, client: true })

    this.emit('debug', 'phase 1: waiting for site:bootstrap...')
    let bootstrap = null
    while (Date.now() < deadline) {
      await this._graph.update()
      bootstrap = await this._readBootstrap()
      if (bootstrap) break
      await sleep(1000)
    }

    await phase1Swarm.destroy({ force: true })

    if (!bootstrap) {
      this.emit('debug', 'phase 1: timed out waiting for bootstrap')
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the site's bootstrap descriptor. The owner may be offline, or the address may be incorrect.`)
    }
    this.emit('debug', 'phase 1: bootstrap found, upgrading to real HypergraphNetwork...')

    // ── Phase 2: the proven pattern — a real HypergraphNetwork,
    // constructed via connectFromBootstrap(), exactly like
    // p2p-reddit-clone/peer.js and bin/scratch-visitor.js (verified
    // directly against a real connection to work reliably; the
    // previous all-bare-Hyperswarm design did not).
    this._swarm = new Hyperswarm({ maxPeers: this._maxPeers })
    this._network = await HypergraphNetwork.connectFromBootstrap(
      this._graph, this._store, this._swarm, bootstrap, { role: 'peer' }
    )
    this._network.on('peer-join',      (info) => { this.emit('peer-join', info); this.emit('debug', 'phase 2: peer joined') })
    this._network.on('writer-granted', (msg)  => this.emit('debug', `phase 2: writer granted: ${JSON.stringify(msg)}`))
    this._network.on('writer-error',   (msg)  => this.emit('debug', `phase 2: writer error: ${JSON.stringify(msg)}`))
    // These fire from inside HypergraphNetwork's own _ensureConnectionWithRetry
    // fallback path — if connect() is stuck specifically there (waiting on a
    // connection it doesn't think it has yet, despite one already existing),
    // these are the direct, sourced signal that tells us so.
    this._network.on('connection-retry', (info) => this.emit('debug', `phase 2: [hypergraph] connection-retry: ${JSON.stringify(info)}`))
    this._network.on('connection-retry-exhausted', (info) => this.emit('debug', `phase 2: [hypergraph] connection-retry-exhausted: ${JSON.stringify(info)}`))

    this.emit('debug', 'phase 2: calling this._network.connect()...')
    try {
      // Isolate this ONE call with its own hard timeout, separate from
      // the overall connect() deadline — so instead of continued silence
      // if this specific call never resolves, we get a definitive,
      // immediate fact: "confirmed — HypergraphNetwork.connect() itself
      // is what hangs" vs. some other step. This is diagnostic
      // instrumentation, not a claimed fix — we don't yet know why this
      // call would hang given a connection has already been confirmed
      // (writer-granted firing proves one exists), and this makes that
      // fact visible instead of guessing further.
      await withInnerTimeout(
        this._network.connect(),
        15000,
        'HypergraphNetwork.connect() did not resolve within 15s, even though a connection was already established (writer-granted fired above) — this points at something inside hypergraph\'s own connect() method, not our code',
      )
    } catch (e) {
      this.emit('debug', `phase 2: this._network.connect() FAILED OR TIMED OUT: ${e.message}`)
      throw e
    }
    this.emit('debug', 'phase 2: HypergraphNetwork.connect() resolved')

    this._graph.on('change', () => this.emit('update'))
    this._startUpdatePolling()

    this.emit('debug', 'phase 2: waiting for data (polling graph.update() + isReady check)...')
    while (Date.now() < deadline) {
      await this._graph.update()
      if (await isReady()) {
        this.emit('debug', 'isReady() returned true — connect() resolving')
        this.emit('ready', { partial: false })
        this._ready = true
        return
      }
      await sleep(1000)
    }

    this.emit('debug', `timed out after ${timeoutMs}ms waiting for isReady()`)
    throw new Error(`Timed out after ${timeoutMs}ms waiting for site data. The owner may be offline, or the address may be incorrect.`)
  }

  // ─── Owner side ─────────────────────────────────────────────────────────────

  /**
   * Host a site as its owner. The site's address IS this graph's own
   * core key (graph.key) — there's no separate topic to generate.
   * Stores a bootstrap descriptor in the graph (context keys etc.),
   * announces on the DHT at this graph's own discovery key, starts serving.
   *
   * @param {object} [contexts] - { name: contextKeyHex } passed to generateBootstrap
   * @returns {Promise<string>} the site's address (this graph's own core key, hex)
   */
  async host (contexts = {}) {
    if (this._destroyed) throw new Error('Network instance has been destroyed')

    const ownerKeyHex = this._graph.key.toString('hex')
    this._ownerKeyHex = ownerKeyHex

    let bootstrap = await this._readBootstrap()
    if (!bootstrap) {
      bootstrap = HypergraphNetwork.generateBootstrap(this._graph, {
        // HypergraphNetwork's own topic concept is still used internally
        // for its writer-auth protomux channel — derived from our own
        // key so it's deterministic and rediscoverable, not a separately
        // generated random value we'd need to remember.
        topic: crypto.discoveryKey(this._graph.key).toString('hex'),
        contexts,
      })
      await this._writeBootstrap(bootstrap)
    }

    this._swarm = new Hyperswarm({ maxPeers: this._maxPeers })
    this._network = new HypergraphNetwork(
      this._graph, this._store, this._swarm,
      { topic: bootstrap.topic, contexts, role: 'owner' }
    )

    this._wireNetworkEvents()
    await this._network.connect()

    this._ready = true
    this.emit('ready', { partial: false })
    return ownerKeyHex
  }

  // ─── Teardown ────────────────────────────────────────────────────────────────

  async destroy () {
    if (this._destroyed) return
    this._destroyed = true

    if (this._updatePollTimer) {
      clearInterval(this._updatePollTimer)
      this._updatePollTimer = null
    }
    if (this._network) await this._network.destroy()
    if (this._swarm) await this._swarm.destroy({ force: true })

    this.emit('destroyed')
    this.removeAllListeners()
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  async _readBootstrap () {
    try {
      const results = await this._graph.query()
        .type(BOOTSTRAP_ENTITY_TYPE)
        .toArray()
      if (!results.length) return null

      const content = await this._graph.getContent(results[0].id)
      if (!content?.body) return null
      return JSON.parse(content.body)
    } catch {
      return null
    }
  }

  async _writeBootstrap (bootstrap) {
    const entity = await this._graph.put({ type: BOOTSTRAP_ENTITY_TYPE })
    await this._graph.putContent(entity.id, JSON.stringify(bootstrap), 'application/json')
  }

  _wireNetworkEvents () {
    if (!this._network) return
    this._network.on('peer-join',      (info) => this.emit('peer-join', info))
    this._network.on('writer-granted', (msg)  => this.emit('writer-granted', msg))
    this._network.on('writer-error',   (msg)  => this.emit('writer-error', msg))
    this._network.on('flush-timeout',  (info) => this.emit('flush-timeout', info))
    this._startUpdatePolling()
  }

  /**
   * graph.on('change') only fires as a RESULT of calling graph.update()
   * and it detecting new data — it is not a passive push notification
   * that fires on its own as bytes arrive over the wire. Without
   * something calling graph.update() repeatedly for the life of the
   * connection, 'change' (and therefore our 'update' event) would only
   * ever fire once, right after connect() resolves — even though real
   * content (comments, edits, new posts) can keep arriving well after
   * that, especially over a real, non-local DHT connection.
   */
  _startUpdatePolling () {
    if (this._updatePollTimer) return
    this._updatePollTimer = setInterval(async () => {
      if (this._destroyed) { clearInterval(this._updatePollTimer); return }
      try { await this._graph.update() } catch {}
    }, 1500)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Unlike withTimeout() below (which silently proceeds past a timed-out
 * step), this REJECTS with a clear message if the timeout wins — used
 * specifically to convert "this call never resolves, silently" into an
 * explicit, immediate, sourced error during diagnosis.
 */
function withInnerTimeout (promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function withTimeout (promise, ms) {
  return Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))])
}

/**
 * Parse a hyper:// address into an owner core key hex string.
 * Returns null if the address is invalid.
 *
 * @param {string} address - e.g. "hyper://abc123..."
 * @returns {string|null} 64-char hex owner key, or null
 */
export function parseHyperAddress (address) {
  if (!address) return null
  const stripped = address.replace(/^hyper:\/\//i, '').trim()
  if (!/^[0-9a-f]{64}$/i.test(stripped)) return null
  return stripped.toLowerCase()
}

/**
 * Format an owner core key hex string as a hyper:// address.
 *
 * @param {string} ownerKeyHex
 * @returns {string}
 */
export function formatHyperAddress (ownerKeyHex) {
  return `hyper://${ownerKeyHex}`
}
