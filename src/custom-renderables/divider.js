/**
 * custom-renderables/divider.js
 *
 * ::hr and standard markdown thematic breaks both become a DividerNode.
 * No native OpenTUI "rule" primitive exists; a 1-cell-tall Box with a
 * bottom border is the simplest way to draw a horizontal line that
 * still participates correctly in flexbox layout (full-width, fixed
 * height), rather than us hand-building a string of "─" characters
 * and getting width/wrapping wrong ourselves.
 */

import { BoxRenderable } from '@opentui/core'

export function mountDivider(ctx, node) {
  const { props } = node
  return new BoxRenderable(ctx, {
    id: node.id ?? undefined,
    width: '100%',
    height: 1,
    border: ['bottom'],
    borderColor: props.fg ?? undefined,
  })
}

export function patchDivider(box, node) {
  if (node.props.fg != null) box.borderColor = node.props.fg
}
