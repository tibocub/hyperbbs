/**
 * keybindings.js
 *
 * Maps key combinations to named actions. The shell and other components
 * dispatch on action names rather than raw key events, so:
 *   - Adding a new shortcut is one line in DEFAULT_BINDINGS
 *   - Remapping a key is one line in a user config override
 *   - Platform quirks (AZERTY, macOS vs Windows terminal differences)
 *     are handled by replacing bindings, not by scattering `key.name`
 *     checks throughout the codebase
 *
 * Action names are plain strings. Convention: "scope:verb" or just
 * "verb" for global actions. Examples:
 *   "devtools:toggle"   — F12, open/close the debug panel
 *   "focus:next"        — Tab
 *   "focus:prev"        — Shift+Tab
 *   "nav:confirm"       — Enter in the address bar
 *   "nav:escape"        — Escape, cancel/blur
 *   "page:scroll_up"    — handled by ScrollBoxRenderable natively,
 *                         listed here for documentation only
 *
 * Key combo syntax (matches ParsedKey fields):
 *   { name }                  — bare key, no modifiers
 *   { name, shift: true }     — Shift+key
 *   { name, ctrl: true }      — Ctrl+key
 *   { name, meta: true }      — Meta/Alt+key
 *   { name, ctrl, shift }     — multi-modifier
 *
 * Matching is order-independent for modifiers — { ctrl, shift } matches
 * whether ctrl or shift was physically pressed first.
 */

// ─── Default bindings ─────────────────────────────────────────────────────────

export const DEFAULT_BINDINGS = [
  // Debug panel
  { key: { name: 'f12' },                           action: 'devtools:toggle' },

  // Focus cycling — Tab works universally across keyboard layouts
  { key: { name: 'tab' },                           action: 'focus:next' },
  { key: { name: 'tab', shift: true },              action: 'focus:prev' },

  // Address bar
  { key: { name: 'f6' },                            action: 'nav:focus_address' },
  { key: { name: 'l', ctrl: true },                 action: 'nav:focus_address' },
  { key: { name: 'return' },                        action: 'nav:confirm' },
  { key: { name: 'escape' },                        action: 'nav:escape' },

  // Navigation history (future)
  { key: { name: 'left', meta: true },              action: 'nav:back' },
  { key: { name: 'right', meta: true },             action: 'nav:forward' },
  // Alt+Left also common on Windows terminals
  { key: { name: 'left', ctrl: true },              action: 'nav:back' },

  // Devtools focus — Ctrl+Shift+J mirrors Chrome's shortcut for the console
  { key: { name: 'j', ctrl: true, shift: true },    action: 'devtools:focus_console' },
]

// ─── Keybinding resolver ──────────────────────────────────────────────────────

/**
 * Build a resolver from a bindings array (DEFAULT_BINDINGS merged with
 * any user overrides). The resolver is a function:
 *   resolveAction(parsedKey) -> string | null
 *
 * User overrides completely replace a binding for a given key combo;
 * they don't stack. To remove a default binding entirely, set its
 * action to null in the user config.
 *
 * @param {object[]} [userBindings] - additional or replacement bindings
 * @returns {(key: object) => string | null}
 */
export function createKeyResolver(userBindings = []) {
  // Merge: user bindings override defaults for the same key combo
  const merged = mergeBindings(DEFAULT_BINDINGS, userBindings)
  return (key) => matchBinding(key, merged)
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function mergeBindings(defaults, overrides) {
  const result = [...defaults]
  for (const override of overrides) {
    const existingIdx = result.findIndex(b => comboMatches(override.key, b.key))
    if (existingIdx >= 0) {
      if (override.action == null) {
        result.splice(existingIdx, 1) // null action = remove binding
      } else {
        result[existingIdx] = override
      }
    } else {
      result.push(override)
    }
  }
  return result
}

function matchBinding(key, bindings) {
  for (const binding of bindings) {
    if (comboMatches(key, binding.key)) return binding.action
  }
  return null
}

/**
 * Check whether a ParsedKey matches a binding combo descriptor.
 * Unspecified modifier fields in the combo default to false, so
 * { name: 'tab' } only matches Tab with no modifiers.
 */
function comboMatches(key, combo) {
  if (key.name !== combo.name) return false
  if (!!key.shift  !== !!(combo.shift))  return false
  if (!!key.ctrl   !== !!(combo.ctrl))   return false
  if (!!key.meta   !== !!(combo.meta))   return false
  if (!!key.option !== !!(combo.option)) return false
  return true
}