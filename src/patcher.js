/**
 * patcher.js
 *
 * The TUI renderer's implementation of SandboxHost's onPatch callback.
 * All OpenTUI-specific logic for applying script-driven mutations to
 * the live render tree lives here.
 *
 * createTuiPatcher(ctx) returns a function matching the onPatch signature:
 *   (nodeId, props, getElementById) => void
 *
 * `ctx` is the CliRenderer instance, needed to construct new Renderables
 * when setData() adds dynamic children to a container.
 */

import { TextRenderable } from '@opentui/core'

export function createTuiPatcher(ctx) {
  return function onPatch(nodeId, props, getElementById) {
    const node = getElementById(nodeId)
    if (!node) {
      if (process.env.HYPERBBS_DEBUG) {
        console.warn(`[patcher] PATCH targeting unknown node id: "${nodeId}"`)
      }
      return
    }

    const { _data, content, ...propUpdates } = props

    // Merge plain prop updates onto the HyperDOM node and attempt to
    // set matching properties on the live _tuiRef via its setters.
    Object.assign(node.props, propUpdates)
    if (node._tuiRef) {
      for (const [k, v] of Object.entries(propUpdates)) {
        try { node._tuiRef[k] = v } catch { /* no setter for this prop */ }
      }
    }

    // `content`: update a text node's visible string.
    // Walks into the first child TextRenderable if the node itself is a
    // container (BoxRenderable has no .content setter — confirmed via
    // prototype probe in an earlier session).
    if (content != null && node._tuiRef) {
      const target = findTextTarget(node._tuiRef)
      if (target) {
        try { target.content = content } catch { /* setter rejected */ }
      } else if (process.env.HYPERBBS_DEBUG) {
        console.warn(`[patcher] setText on #${nodeId}: no TextRenderable found`)
      }
    }

    // `_data`: replace a container's content with a list of strings.
    // Tracks previously-added dynamic children by their auto-generated
    // OpenTUI id so they can be removed on the next setData() call
    // without touching the node's original statically-mounted children.
    if (_data != null && node._tuiRef) {
      applyDataList(ctx, node, _data)
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyDataList(ctx, node, items) {
  const box = node._tuiRef
  if (!box?.getChildren || !box?.remove || !box?.add) return

  if (node._dynamicChildren) {
    for (const childId of node._dynamicChildren) {
      try { box.remove(childId) } catch { /* already gone */ }
    }
  }
  node._dynamicChildren = []

  for (const item of items) {
    const text = new TextRenderable(ctx, { content: String(item) })
    box.add(text)
    node._dynamicChildren.push(text.id)
  }
}

/**
 * Find the first renderable in a subtree that has a writable .content
 * property. Checks own properties first (covers test stubs defined as
 * plain objects), then walks the prototype chain (covers real OpenTUI
 * class instances where the setter lives on the class prototype).
 */
function findTextTarget(renderable) {
  if (!renderable) return null
  if (hasContentSetter(renderable)) return renderable
  if (renderable.getChildren) {
    for (const child of renderable.getChildren()) {
      const found = findTextTarget(child)
      if (found) return found
    }
  }
  return null
}

function hasContentSetter(obj) {
  const own = Object.getOwnPropertyDescriptor(obj, 'content')
  if (own?.set) return true
  let proto = Object.getPrototypeOf(obj)
  while (proto && proto !== Object.prototype) {
    const d = Object.getOwnPropertyDescriptor(proto, 'content')
    if (d?.set) return true
    proto = Object.getPrototypeOf(proto)
  }
  return false
}