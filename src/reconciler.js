/**
 * reconciler.js
 *
 * Walks a HyperDOM tree (produced by hypermd's parse()) and mounts it
 * into real OpenTUI Renderables under a given root.
 *
 * This is intentionally a "mount once" implementation for the static
 * renderer prototype — no diffing against a previous tree yet. patch()
 * exists for the small set of in-place prop updates we already need
 * (marquee tick, button label change) but full tree diffing (for
 * script-driven structural changes like list re-renders) is future work,
 * tracked in the README.
 *
 * Every mounted HyperDOM node gets its OpenTUI Renderable stashed in
 * node._tuiRef, and an id-indexed lookup table is kept on the
 * Reconciler instance so a future script sandbox can implement
 * `hypersite.getElementById()` against it directly.
 */

import { EventEmitter } from 'node:events'
import { StyledText, BoxRenderable } from '@opentui/core'
import { NodeTypes } from 'hypermd'

import { NODE_MAP, INLINE_TYPES } from './node-map.js'
import { flattenInline } from './inline-text.js'

import { mountButton, patchButton } from './custom-renderables/button.js'
import { mountMarquee, patchMarquee } from './custom-renderables/marquee.js'
import { mountSelect, patchSelect } from './custom-renderables/select.js'
import { mountDivider, patchDivider } from './custom-renderables/divider.js'
import { mountList } from './custom-renderables/list.js'

const CUSTOM_MOUNTERS = {
  button: { mount: mountButton, patch: patchButton },
  marquee: { mount: mountMarquee, patch: patchMarquee },
  select: { mount: mountSelect, patch: patchSelect },
  divider: { mount: mountDivider, patch: patchDivider },
  list: { mount: mountList, patch: null },
}

// HyperDOM node types whose children are inline text, flattened into a
// single TextRenderable.content rather than mounted as child Renderables.
const INLINE_CONTAINER_TYPES = new Set([NodeTypes.HEADING, NodeTypes.PARAGRAPH])

/**
 * Resolve which NODE_MAP entry to mount a node with, honoring a
 * `render` style override if a :::style rule set one (see hypermd's
 * applyStyles — this is how `{ "h1": { "render": "BigTextNode" } }`
 * makes every h1 render as ASCII bigtext instead of plain Text).
 *
 * Falls back to the node's default mapping if `render` names an
 * unknown type, rather than silently dropping the node.
 */
function resolveMapping(node) {
  const overrideType = node.props?.render
  if (overrideType && NODE_MAP[overrideType]) {
    return NODE_MAP[overrideType]
  }
  if (overrideType && process.env.HYPERBBS_DEBUG) {
    console.warn(`[hyperbbs] style override "render: ${overrideType}" on #${node.id ?? '(no id)'} does not match any known node type, ignoring`)
  }
  return NODE_MAP[node.type]
}

export class Reconciler extends EventEmitter {
  /**
   * @param {import('@opentui/core').RenderContext} ctx - typically the
   *   CliRenderer instance returned by createCliRenderer()
   */
  constructor(ctx) {
    super()
    this.ctx = ctx
    /** @type {Map<string, object>} id -> HyperDOM node, for getElementById */
    this.byId = new Map()
  }

  /**
   * Mount a full HyperDOM document (the `nodes` array from hypermd's
   * parse()) into a container Renderable.
   *
   * @param {object[]} nodes - top-level HyperDOM nodes
   * @param {import('@opentui/core').Renderable} container - where to mount
   *   (typically renderer.root, or a dedicated viewport Box)
   */
  mountDocument(nodes, container) {
    for (const node of nodes) {
      const renderable = this.mountNode(node)
      if (renderable) container.add(renderable)
    }
  }

  /**
   * Mount a single HyperDOM node (and its subtree) into a real
   * OpenTUI Renderable. Returns null for nodes that don't produce
   * a standalone Renderable (inline text nodes, script/style blocks
   * which are never passed here since hypermd already extracts them
   * out of the render tree).
   *
   * @param {object} node - a HyperDOM node
   * @returns {import('@opentui/core').Renderable | null}
   */
  mountNode(node) {
    if (INLINE_TYPES.has(node.type)) {
      // Inline nodes should only ever be reached via mountInlineContainer;
      // if mountNode is called on one directly, something upstream is
      // walking the tree incorrectly.
      if (process.env.HYPERBBS_DEBUG) {
        console.warn(`[hyperbbs] mountNode called directly on inline type "${node.type}"`)
      }
      return null
    }

    const mapping = resolveMapping(node)

    // A node normally routed through mountInlineContainer (Heading,
    // Paragraph) takes a different mount path if a :::style rule
    // overrode it to render via a non-text node type — e.g.
    // { "h1": { "render": "BigTextNode" } }. BigTextNode expects a
    // flat `text` prop, not flattened inline children, so it can't go
    // through the inline-flattening path at all. We detect this by
    // checking whether the *resolved* mapping still targets a node
    // type that's in INLINE_CONTAINER_TYPES's prop-mapping set — in
    // practice: only take the inline path if no override fired, or
    // the override still names Heading/Paragraph itself.
    const overrodeToNonInlineType = node.props?.render && node.props.render !== node.type
      && !INLINE_CONTAINER_TYPES.has(node.props.render)

    if (INLINE_CONTAINER_TYPES.has(node.type) && !overrodeToNonInlineType) {
      return this.mountInlineContainer(node)
    }

    if (!mapping) {
      if (process.env.HYPERBBS_DEBUG) {
        console.warn(`[hyperbbs] no renderer mapping for node type "${node.type}"`)
      }
      return null
    }

    let renderable

    if (mapping.custom) {
      const { mount } = CUSTOM_MOUNTERS[mapping.custom]
      renderable = mount(this.ctx, node, this)
    } else {
      const { ctor, mapProps } = mapping
      // Headings/Paragraphs overridden to a flat-text renderer (e.g.
      // BigTextNode) carry their text in inline children, not a `label`
      // prop. Synthesize one here via the same flattener used for the
      // normal inline-container path, so mapBigTextProps (etc) sees a
      // plain string regardless of which path got it there.
      if (overrodeToNonInlineType && node.props.label == null) {
        const plainText = flattenInline(node.children ?? [])
          .map(c => c.text)
          .join('')
        node.props.label = plainText
      }
      renderable = new ctor(this.ctx, mapProps(node))
      // Safe even for an overridden Heading: its children are inline
      // types (Text, Strong...) which mountNode no-ops on directly,
      // since their content was already folded into props.label above.
      this.mountChildren(node, renderable)
    }

    node._tuiRef = renderable
    if (node.id) this.byId.set(node.id, node)

    return renderable
  }

  /**
   * Mount a node's HyperDOM children into an already-constructed parent
   * Renderable. Skipped for inline-container types (Heading/Paragraph,
   * handled by mountInlineContainer) and for custom composites that
   * manage their own children internally (Button's label, etc).
   */
  mountChildren(node, parentRenderable) {
    if (!node.children?.length) return
    for (const child of node.children) {
      const childRenderable = this.mountNode(child)
      if (childRenderable) parentRenderable.add(childRenderable)
    }
  }

  /**
   * Heading/Paragraph: flatten inline children into TextChunks and
   * build a single TextRenderable rather than mounting each inline
   * child as a separate Renderable.
   */
  mountInlineContainer(node) {
    const mapping = NODE_MAP[node.type]
    const chunks = flattenInline(node.children ?? [])
    const props = mapping.mapProps(node)

    const TextRenderableCtor = mapping.ctor
    const text = new TextRenderableCtor(this.ctx, props)
    text.content = new StyledText(chunks)

    node._tuiRef = text
    if (node.id) this.byId.set(node.id, node)

    return text
  }

  /**
   * Apply an in-place update to an already-mounted node. Currently
   * supports the handful of node types with a patch function defined
   * (custom composites). Plain OpenTUI primitives can usually be
   * patched by setting properties directly on node._tuiRef from
   * calling code; a more general patch() covering arbitrary prop
   * diffs is future work once the script sandbox needs it.
   *
   * @param {object} node - a previously-mounted HyperDOM node
   */
  patchNode(node) {
    if (!node._tuiRef) return
    const mapping = NODE_MAP[node.type]
    if (mapping?.custom) {
      const { patch } = CUSTOM_MOUNTERS[mapping.custom]
      patch?.(node._tuiRef, node)
    }
  }

  /**
   * Look up a previously-mounted node by its HyperMD id attribute.
   * The foundation for the future hypersite.getElementById() script API.
   */
  getElementById(id) {
    return this.byId.get(id) ?? null
  }

  /**
   * Re-emit a custom renderable's interaction (button press, select
   * change, etc) as a reconciler-level event, namespaced by node id
   * so a future script sandbox can subscribe per-element.
   */
  emit(eventName, node, detail) {
    super.emit(eventName, node, detail)
    if (node.id) super.emit(`${eventName}:${node.id}`, node, detail)
  }
}
