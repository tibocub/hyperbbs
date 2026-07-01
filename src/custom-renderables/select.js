/**
 * custom-renderables/select.js
 *
 * HyperMD's ::select maps onto OpenTUI's native SelectRenderable
 * directly — no composition needed, just prop translation. Kept in the
 * "custom" bucket alongside Button/Marquee for consistency, since
 * SelectOption's shape ({ name, description, value }) doesn't match
 * HyperMD's attribute-string-based directive syntax 1:1 and needs a
 * small parsing step.
 */

import { SelectRenderable } from '@opentui/core'

/**
 * HyperMD doesn't yet have a sub-syntax for declaring option lists
 * inline (a ::select leaf directive only carries flat attributes, no
 * structured children). For now, options are expected as a JSON string
 * in the `options` attribute:
 *
 *   ::select{id=color options="[{\"name\":\"Red\"},{\"name\":\"Blue\"}]"}
 *
 * This is intentionally clunky — see README known gaps. A future
 * HyperMD revision should probably support :::select as a *container*
 * directive with ::option leaf children instead, which would also let
 * each option carry richer formatting. Flagging rather than solving
 * here, since changing this is a hypermd-package decision, not a
 * renderer one.
 */
function parseOptions(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    console.warn('[hyperbbs] ::select options attribute is not valid JSON, ignoring')
    return []
  }
}

export function mountSelect(ctx, node, reconciler) {
  const { props } = node

  const select = new SelectRenderable(ctx, {
    id: node.id ?? undefined,
    options: parseOptions(props.options),
    selectedIndex: props.selectedIndex ?? 0,
    width: props.width ?? '100%',
    showDescription: Boolean(props.showDescription),
  })

  select.on('itemSelected', (index, option) => {
    reconciler.emit('change', node, { index, option })
  })

  return select
}

export function patchSelect(select, node) {
  if (node.props.options != null) {
    select.options = parseOptions(node.props.options)
  }
}
