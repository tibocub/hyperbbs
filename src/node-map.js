/**
 * node-map.js
 *
 * Defines how each HyperDOM node type maps to a real OpenTUI Renderable.
 *
 * Each entry is either:
 *   - a Renderable constructor (used directly: new Ctor(ctx, props))
 *   - a { ctor, mapProps } pair, where mapProps(node) transforms HyperDOM
 *     props into the prop shape that ctor's constructor expects
 *   - a custom mount function for node types with no 1:1 OpenTUI primitive
 *     (e.g. MarqueeNode, ColorSpan — see custom-renderables.js)
 *
 * This file is the single place that knows about OpenTUI's actual API
 * surface. Everything else in the reconciler works against this mapping
 * rather than referencing OpenTUI renderables directly, so adding a new
 * node type or changing how one renders is a local, contained edit.
 */

import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  ASCIIFontRenderable,
  TextAttributes,
} from '@opentui/core'

import { NodeTypes } from 'hypermd'

/**
 * HyperMD's `position` attribute is a friendly shorthand, NOT the same
 * thing as OpenTUI's own `position` prop (which is Yoga's CSS-style
 * static/relative/absolute box positioning — a different concept).
 * Confirmed via @opentui/core's lib/yoga.options.d.ts: AlignString
 * (which DOES include "center") is what actually controls this kind
 * of alignment, applied as `alignSelf` on the node itself so a single
 * leaf element can self-center without needing its parent's
 * alignItems/justifyContent set up specially.
 *
 *   position=center        -> alignSelf: "center"
 *   position=start|left    -> alignSelf: "flex-start"
 *   position=end|right     -> alignSelf: "flex-end"
 *   position=stretch       -> alignSelf: "stretch"
 *
 * Anything else passes through unrecognised (left for a future
 * absolute-positioning story, since Yoga's real `position: absolute`
 * + top/left/right/bottom is a different, more advanced feature we
 * haven't designed HyperMD syntax for yet).
 */
const POSITION_SHORTHAND = {
  center: 'center',
  start: 'flex-start',
  left: 'flex-start',
  end: 'flex-end',
  right: 'flex-end',
  stretch: 'stretch',
}

function applyPositionShorthand(props, out) {
  if (props.position && POSITION_SHORTHAND[props.position]) {
    out.alignSelf = POSITION_SHORTHAND[props.position]
  }
}

// ─── Color / style coercion helpers ──────────────────────────────────────────

/**
 * HyperMD style props use short keys (fg, bg, bold) borrowed from terminal
 * convention. OpenTUI renderables mostly already use these names directly,
 * but a few need remapping (border -> borderStyle/border, etc).
 */
function baseStyleProps(node) {
  const { props } = node
  const out = {}

  if (props.fg != null) out.fg = props.fg
  if (props.bg != null) out.bg = props.bg
  if (props.width != null) out.width = props.width
  if (props.height != null) out.height = props.height
  if (props.padding != null) out.padding = props.padding
  if (props.flexDirection != null) out.flexDirection = props.flexDirection
  if (props.gap != null) out.gap = props.gap

  applyPositionShorthand(props, out)

  return out
}

// ─── Per-type mappers ─────────────────────────────────────────────────────────

/**
 * ContainerPanel -> BoxRenderable
 * Handles border / borderStyle, since :::panel{border=rounded} uses the
 * shorthand `border` attribute to mean "borderStyle, with border on".
 */
function mapPanelProps(node) {
  const out = baseStyleProps(node)
  const { props } = node

  if (props.border) {
    out.border = true
    // border=rounded is shorthand for borderStyle: "rounded"
    if (typeof props.border === 'string') {
      out.borderStyle = props.border
    } else if (props.borderStyle) {
      out.borderStyle = props.borderStyle
    }
  }
  if (props.backgroundColor != null) out.backgroundColor = props.backgroundColor
  if (props.title != null) out.title = props.title

  return out
}

/**
 * ContainerForm / ContainerColumns -> BoxRenderable, layout-only.
 * Columns defaults to row direction unless overridden.
 */
function mapFormProps(node) {
  return baseStyleProps(node)
}

function mapColumnsProps(node) {
  const out = baseStyleProps(node)
  if (!out.flexDirection) out.flexDirection = 'row'
  return out
}

/**
 * Heading / Paragraph -> TextRenderable.
 * The actual text content comes from flattening inline children
 * (see inline-text.js); this just sets up base style (bold for h1/h2, etc).
 */
function mapHeadingProps(node) {
  const out = baseStyleProps(node)
  // Larger headings get bold; depth 1-2 also implies a brighter default fg
  // if the author hasn't overridden it via a :::style block.
  out.attributes = node.props.depth <= 2 ? TextAttributes.BOLD : TextAttributes.NONE
  return out
}

function mapParagraphProps(node) {
  return baseStyleProps(node)
}

/**
 * InputNode -> InputRenderable (single-line only, per OpenTUI's Input).
 */
function mapInputProps(node) {
  const out = baseStyleProps(node)
  const { props } = node

  if (props.placeholder != null) out.placeholder = props.placeholder
  if (props.value != null) out.value = props.value
  if (props.maxlength != null) out.maxLength = props.maxlength
  if (props.minlength != null) out.minLength = props.minlength
  if (out.width == null) out.width = 30 // sane default; OpenTUI requires explicit sizing for Input

  return out
}

/**
 * ButtonNode -> BoxRenderable wrapping a TextRenderable label.
 * OpenTUI has no native "Button" primitive; a focusable Box with a
 * single Text child and a press handler is the standard pattern.
 * See custom-renderables/button.js for the composite mount logic.
 */

/**
 * BigTextNode -> ASCIIFontRenderable.
 */
function mapBigTextProps(node) {
  const out = {}
  const { props } = node

  out.text = props.label ?? ''
  out.font = props.font ?? 'tiny' // tiny | block | shade | slick | huge | grid | pallet
  if (props.fg != null) out.color = props.fg
  if (props.bg != null) out.backgroundColor = props.bg

  applyPositionShorthand(props, out)

  return out
}

/**
 * CodeBlock -> TextRenderable, no-wrap, dim background.
 * Not syntax-highlighted yet — OpenTUI's CodeRenderable supports real
 * tree-sitter highlighting but requires a SyntaxStyle/theme setup we
 * haven't wired in. This is the plain fallback; upgrading to
 * CodeRenderable later is a local change to this function only.
 */
function mapCodeBlockProps(node) {
  const out = baseStyleProps(node)
  out.content = node.props.value ?? ''
  out.wrapMode = 'none'
  if (out.bg == null) out.bg = '#1a1a1a'
  return out
}

// ─── The mapping table ────────────────────────────────────────────────────────

/**
 * Each entry: { ctor, mapProps } for direct OpenTUI primitives,
 * or { custom: mountFn } for node types without a 1:1 native equivalent.
 *
 * mountFn(ctx, node, reconciler) -> Renderable
 * is responsible for constructing AND mounting children itself when the
 * composite shape doesn't match HyperDOM's child structure 1:1 (e.g. Button
 * wraps its label as an internal Text child, not a HyperDOM child).
 */
export const NODE_MAP = {
  [NodeTypes.CONTAINER_PANEL]:   { ctor: BoxRenderable,   mapProps: mapPanelProps },
  [NodeTypes.CONTAINER_FORM]:    { ctor: BoxRenderable,   mapProps: mapFormProps },
  [NodeTypes.CONTAINER_COLUMNS]: { ctor: BoxRenderable,   mapProps: mapColumnsProps },

  [NodeTypes.HEADING]:           { ctor: TextRenderable,  mapProps: mapHeadingProps },
  [NodeTypes.PARAGRAPH]:         { ctor: TextRenderable,  mapProps: mapParagraphProps },

  [NodeTypes.INPUT_NODE]:        { ctor: InputRenderable, mapProps: mapInputProps },
  [NodeTypes.BIGTEXT_NODE]:      { ctor: ASCIIFontRenderable, mapProps: mapBigTextProps },
  [NodeTypes.CODE_BLOCK]:        { ctor: TextRenderable,  mapProps: mapCodeBlockProps },

  // Custom composite/behavioral renderables — see custom-renderables/
  [NodeTypes.BUTTON_NODE]:       { custom: 'button' },
  [NodeTypes.MARQUEE_NODE]:      { custom: 'marquee' },
  [NodeTypes.SELECT_NODE]:       { custom: 'select' },
  [NodeTypes.DIVIDER_NODE]:      { custom: 'divider' },
  [NodeTypes.LIST]:              { custom: 'list' },

  // Inline/text-only nodes are flattened into their parent TextRenderable's
  // content rather than mounted as standalone Renderables — see inline-text.js
  // for TEXT, STRONG, EMPHASIS, INLINE_CODE, LINK, COLOR_SPAN, BREAK.

  // LIST_ITEM is mounted internally by the List custom renderable, never
  // reached directly via the standard mountNode/mountChildren path.
}

/**
 * Node types whose content is inline text, flattened into the parent's
 * TextRenderable rather than mounted as independent Renderables.
 */
export const INLINE_TYPES = new Set([
  NodeTypes.TEXT,
  NodeTypes.STRONG,
  NodeTypes.EMPHASIS,
  NodeTypes.INLINE_CODE,
  NodeTypes.LINK,
  NodeTypes.COLOR_SPAN,
  NodeTypes.BREAK,
])
