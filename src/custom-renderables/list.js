/**
 * custom-renderables/list.js
 *
 * HyperMD's `List`/`ListItem` (standard markdown - / * / 1. syntax) map to
 * a Box (vertical stack) of per-item Text rows, each prefixed with a
 * marker. OpenTUI has no native "list" primitive, so this hand-builds
 * the marker + content layout.
 *
 * Marker selection, in priority order:
 *   1. an explicit `marker` prop on the List node (HyperMD doesn't have
 *      directive syntax for plain markdown lists yet, so this is only
 *      reachable via a future ::list directive or a :::style override —
 *      see markerForStyle below)
 *   2. sane defaults: "•" for unordered, "N." for ordered
 *
 * This is intentionally a flat (non-recursive-marker) implementation for
 * now — nested lists render correctly as nested Boxes, but inherit the
 * same default marker character/style at every depth rather than
 * cycling through ◦/▪/etc like browsers do. Worth revisiting once we
 * have real-world nested lists to look at.
 */

import { BoxRenderable, TextRenderable, StyledText } from '@opentui/core'
import { flattenInline } from '../inline-text.js'

const DEFAULT_BULLET = '•'

/**
 * @param {import('@opentui/core').RenderContext} ctx
 * @param {object} node - the HyperDOM List node
 * @param {import('../reconciler.js').Reconciler} reconciler
 * @returns {BoxRenderable}
 */
export function mountList(ctx, node, reconciler) {
  const { props } = node

  const box = new BoxRenderable(ctx, {
    id: node.id ?? undefined,
    flexDirection: 'column',
    width: props.width ?? '100%',
  })

  const marker = resolveMarker(props)

  node.children.forEach((itemNode, index) => {
    const row = mountListItem(ctx, itemNode, marker, index, reconciler)
    box.add(row)
  })

  return box
}

/**
 * Determine the marker style for a list.
 *
 * @param {object} props - the List node's props (ordered, marker, start)
 * @returns {{ ordered: boolean, char?: string, start: number }}
 */
function resolveMarker(props) {
  return {
    ordered: Boolean(props.ordered),
    // `marker` prop lets a :::style rule (or future ::list directive)
    // override the bullet character for unordered lists, e.g.
    // { "List": { "marker": "→" } }
    char: typeof props.marker === 'string' ? props.marker : DEFAULT_BULLET,
    start: Number.isInteger(props.start) ? props.start : 1,
  }
}

function markerText(marker, index) {
  if (marker.ordered) return `${marker.start + index}. `
  return `${marker.char} `
}

/**
 * Mount a single ListItem as a row: [marker][flattened inline content].
 *
 * mdast wraps a ListItem's loose text in a Paragraph node (standard
 * commonmark behavior, not a hypermd quirk) — so itemNode.children is
 * typically [Paragraph], not the inline nodes directly. We unwrap any
 * Paragraph children before flattening; a ListItem containing a nested
 * List or other block content isn't handled yet (falls through to
 * empty content rather than crashing — see README known gaps).
 */
function mountListItem(ctx, itemNode, marker, index, reconciler) {
  const row = new BoxRenderable(ctx, {
    id: itemNode.id ?? undefined,
    flexDirection: 'row',
  })

  const markerCell = new TextRenderable(ctx, {
    content: markerText(marker, index),
    width: marker.ordered ? String(marker.start + index).length + 2 : 2,
  })

  const inlineChildren = unwrapParagraphs(itemNode.children ?? [])
  const chunks = flattenInline(inlineChildren)
  const contentCell = new TextRenderable(ctx, {})
  contentCell.content = new StyledText(chunks)

  row.add(markerCell)
  row.add(contentCell)

  return row
}

/**
 * Flatten away Paragraph wrapper nodes, keeping their inline children
 * in place. Non-Paragraph children (e.g. a future nested List) pass
 * through untouched — flattenInline will skip/warn on those for now.
 */
function unwrapParagraphs(nodes) {
  const out = []
  for (const n of nodes) {
    if (n.type === 'Paragraph') {
      out.push(...(n.children ?? []))
    } else {
      out.push(n)
    }
  }
  return out
}
