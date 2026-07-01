/**
 * custom-renderables/button.js
 *
 * HyperMD's ::button has no 1:1 OpenTUI primitive. OpenTUI's own
 * convention for buttons (per their examples) is a focusable Box with
 * a Text label and mouse/key handlers — this mirrors that pattern.
 *
 * Mounting returns the BoxRenderable (stored as the HyperDOM node's
 * _tuiRef). The "press" interaction is wired here and re-emitted as a
 * HyperDOM-level event so the script sandbox can do:
 *   hypersite.getElementById('submit').on('press', handler)
 */

import { BoxRenderable, TextRenderable, createTextAttributes } from '@opentui/core'

/**
 * @param {import('@opentui/core').RenderContext} ctx
 * @param {object} node - the HyperDOM ButtonNode
 * @param {{ emit: (eventName: string, node: object) => void }} reconciler
 *   - reconciler.emit is called when the button is activated, so the
 *     reconciler can forward this as a HyperDOM-level "press" event.
 * @returns {BoxRenderable}
 */
export function mountButton(ctx, node, reconciler) {
  const { props } = node

  const box = new BoxRenderable(ctx, {
    id: node.id ?? undefined,
    border: true,
    borderStyle: props.borderStyle ?? 'rounded',
    borderColor: props.borderColor,
    focusable: true,
    padding: 0,
    width: props.width ?? 'auto',
    height: props.height ?? 3,
  })

  const label = new TextRenderable(ctx, {
    content: props.label ?? '',
    fg: props.fg,
    attributes: props.bold ? createTextAttributes({ bold: true }) : undefined,
  })

  box.add(label)

  const activate = () => reconciler.emit('press', node)

  box.onMouseDown = () => activate()
  box.onKeyDown = (key) => {
    if (key.name === 'return' || key.name === 'space') activate()
  }

  return box
}

/**
 * Update an already-mounted button in place (label/style changes only —
 * activation handlers don't need rebinding since `node` is captured by
 * reference and the reconciler always emits against the current node).
 */
export function patchButton(box, node) {
  const label = box.getChildren()[0]
  if (label && node.props.label != null) {
    label.content = node.props.label
  }
  if (node.props.fg != null && label) label.fg = node.props.fg
}
