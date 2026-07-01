/**
 * snapshot.js
 *
 * Converts a live HyperDOM tree (nodes with real _tuiRef OpenTUI
 * instances attached) into a structured-clone-safe snapshot that can
 * be sent to a worker thread via postMessage.
 *
 * The worker gets a flat id -> node mirror, not the actual tree
 * structure, since scripts primarily navigate by id
 * (getElementById) rather than by tree position. Type and props are
 * included so scripts can read node state; _tuiRef is explicitly
 * excluded since live OpenTUI objects cannot cross the thread
 * boundary and have no business being in the sandbox.
 *
 * The snapshot is sent once at script init time (in the INIT message).
 * After that, prop updates flow back from worker -> host via PATCH
 * messages, and the host sends DOM_EVENT messages to the worker when
 * real interactions happen. The snapshot itself is not kept in sync
 * continuously — it's a bootstrap, not a live mirror.
 */

/**
 * Build a serializable snapshot from a live HyperDOM tree.
 *
 * @param {object[]} nodes - the nodes array from parse()
 * @returns {Record<string, { type: string, props: object, children: string[] }>}
 *   A flat map of id -> node descriptor. Nodes without an id are
 *   excluded since scripts can only address elements by id.
 */
export function buildSnapshot(nodes) {
  const snapshot = {}
  walkNodes(nodes, (node) => {
    if (!node.id) return
    snapshot[node.id] = {
      type: node.type,
      props: sanitizeProps(node.props),
      // Include child ids so a script can enumerate a container's
      // addressable children if it needs to, without needing the full
      // tree structure.
      children: (node.children ?? [])
        .filter(c => c.id)
        .map(c => c.id),
    }
  })
  return snapshot
}

/**
 * Strip non-serializable values from a node's props before including
 * them in the snapshot. In practice this is mainly a safety net —
 * HyperDOM props are supposed to be plain values (strings, numbers,
 * booleans) — but _tuiRef is explicitly excluded here as a hard
 * guarantee, in case it ever ends up on props by accident.
 */
function sanitizeProps(props) {
  const out = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === '_tuiRef') continue
    if (k === '_loadError') continue
    if (typeof v === 'function') continue
    if (v instanceof Object && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) continue
    out[k] = v
  }
  return out
}

function walkNodes(nodes, fn) {
  for (const node of nodes) {
    fn(node)
    if (node.children?.length) walkNodes(node.children, fn)
  }
}