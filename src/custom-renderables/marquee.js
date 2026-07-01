/**
 * custom-renderables/marquee.js
 *
 * HyperMD's ::marquee has no OpenTUI equivalent (confirmed: no native
 * scrolling-text primitive exists in @opentui/core as of 0.4.2). This
 * implements it as a TextRenderable whose content is re-sliced each
 * frame, driven by OpenTUI's own `renderBefore(buffer, deltaTime)` hook
 * — gated by `live: true` so it only ticks while actually mounted and
 * visible, rather than running a separate setInterval that would need
 * manual cleanup on unmount.
 */

import { TextRenderable } from '@opentui/core'

const DEFAULT_SPEED = 1 // characters per second-ish; tunable via speed prop
const GAP = '   ·   '   // separator when the text wraps around

/**
 * @param {import('@opentui/core').RenderContext} ctx
 * @param {object} node - the HyperDOM MarqueeNode
 * @returns {TextRenderable}
 */
export function mountMarquee(ctx, node) {
  const { props } = node
  const fullText = (props.label ?? '') + GAP
  const speed = Number(props.speed) > 0 ? Number(props.speed) : DEFAULT_SPEED

  const text = new TextRenderable(ctx, {
    id: node.id ?? undefined,
    content: fullText,
    fg: props.fg,
    width: props.width ?? '100%',
    wrapMode: 'none',
    truncate: true,
  })

  // Internal scroll state, stored on the renderable itself so patchMarquee
  // can adjust speed/text without resetting position.
  text._marqueeOffset = 0
  text._marqueeFullText = fullText
  text._marqueeSpeed = speed

  text.live = true
  text.renderBefore = function (buffer, deltaTime) {
    if (!this._marqueeFullText) return
    this._marqueeOffset += this._marqueeSpeed * (deltaTime / 1000)
    const len = this._marqueeFullText.length
    const offset = Math.floor(this._marqueeOffset) % len
    this.content = this._marqueeFullText.slice(offset) + this._marqueeFullText.slice(0, offset)
  }

  return text
}

/**
 * Update an already-mounted marquee's text/speed without resetting
 * scroll position (a content swap mid-scroll shouldn't jump/flicker).
 */
export function patchMarquee(text, node) {
  const { props } = node
  if (props.label != null) {
    text._marqueeFullText = props.label + GAP
  }
  if (props.speed != null && Number(props.speed) > 0) {
    text._marqueeSpeed = Number(props.speed)
  }
  if (props.fg != null) text.fg = props.fg
}
