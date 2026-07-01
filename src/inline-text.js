/**
 * inline-text.js
 *
 * Flattens a HyperDOM inline subtree (the children of a Heading,
 * Paragraph, or ListItem) into an array of OpenTUI TextChunk objects,
 * suitable for assigning to a TextRenderable's `.content`.
 *
 * HyperDOM inline nodes (Text, Strong, Emphasis, InlineCode, Link,
 * ColorSpan, Break) have no 1:1 standalone Renderable — OpenTUI expects
 * a single TextRenderable per paragraph/heading, with styling carried
 * per-chunk rather than per-element. This module bridges that gap.
 */

import { createTextAttributes } from '@opentui/core'
import { NodeTypes } from 'hypermd'

/**
 * Walk a HyperDOM inline node tree and produce a flat TextChunk[] array.
 *
 * @param {object[]} nodes - HyperDOM inline children (e.g. node.children
 *                            of a Heading or Paragraph node)
 * @param {object} [inherited] - style attrs inherited from an ancestor
 *                                 inline node (e.g. Strong wrapping a
 *                                 ColorSpan should still be bold)
 * @returns {import('@opentui/core').TextChunk[]}
 */
export function flattenInline(nodes, inherited = {}) {
  const chunks = []
  for (const node of nodes) {
    chunks.push(...flattenNode(node, inherited))
  }
  return chunks
}

function flattenNode(node, inherited) {
  switch (node.type) {
    case NodeTypes.TEXT:
      return [makeChunk(node.props.value, inherited)]

    case NodeTypes.BREAK:
      return [makeChunk('\n', inherited)]

    case NodeTypes.INLINE_CODE:
      return [makeChunk(node.props.value, {
        ...inherited,
        // Inline code gets a dim/reverse treatment by default so it reads
        // distinctly from surrounding prose, unless a :::style block
        // overrides fg/bg for InlineCode specifically (future work — see
        // README known gaps; style resolution currently only applies to
        // block-level nodes, not inline runs).
        dim: true,
      })]

    case NodeTypes.STRONG:
      return flattenInline(node.children, { ...inherited, bold: true })

    case NodeTypes.EMPHASIS:
      return flattenInline(node.children, { ...inherited, italic: true })

    case NodeTypes.COLOR_SPAN: {
      const next = { ...inherited }
      if (node.props.fg != null) next.fg = node.props.fg
      if (node.props.bg != null) next.bg = node.props.bg
      return flattenInline(node.children, next)
    }

    case NodeTypes.LINK: {
      const linkChunks = flattenInline(node.children, { ...inherited, underline: true })
      // Attach the link URL to every chunk produced by this link's label,
      // since TextChunk.link is per-chunk, not per-run.
      return linkChunks.map(c => ({ ...c, link: { url: node.props.url } }))
    }

    default:
      // Unknown/unsupported inline node — render nothing rather than crash.
      // (Block-level nodes should never appear here; if one does, it's a
      // transformer bug upstream, not something this module should mask.)
      if (process.env.HYPERBBS_DEBUG) {
        console.warn(`[hyperbbs] flattenInline: unexpected node type "${node.type}"`)
      }
      return []
  }
}

/**
 * Build a single TextChunk from a text run and an inherited style.
 */
function makeChunk(text, style) {
  const chunk = { __isChunk: true, text }

  if (style.fg != null) chunk.fg = style.fg
  if (style.bg != null) chunk.bg = style.bg

  const attrs = createTextAttributes({
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    dim: style.dim,
    strikethrough: style.strikethrough,
  })
  if (attrs) chunk.attributes = attrs

  return chunk
}
