/**
 * shell.js
 *
 * Browser chrome wrapping the hypersite viewport.
 *
 * Layout (default — console on right):
 *
 *   ┌─ address bar ──────────────────────────────────────────────┐
 *   │ [←] [→]  hyper://…                            ○ offline   │
 *   ├─ content ──────────────────────────┬─ devtools ───────────┤
 *   │                                    │ ▸ console  [_] [×]   │
 *   │  hypersite viewport                │ [script:log] …       │
 *   │  (scrollable)                      │ …                    │
 *   │                                    │ …                    │
 *   └────────────────────────────────────┴──────────────────────┘
 *
 * Console panel can be docked right (default) or bottom, toggled
 * via the [_]/[|] icon in the devtools header, and shown/hidden
 * via F12.
 *
 * Address bar is focusable — F6 or Ctrl+L focuses it, Enter
 * navigates, Escape blurs it back to page content.
 *
 * Global keys are intercepted on renderer.stdin before they reach
 * focused renderables, resolved via keybindings.js.
 */

import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  parseKeypress,
} from '@opentui/core'

import { Reconciler }     from './reconciler.js'
import { SandboxHost }    from './sandbox/host.js'
import { createTuiPatcher } from './patcher.js'
import { createKeyResolver } from './keybindings.js'
import { readFileSync }   from 'node:fs'
import { resolve, dirname } from 'node:path'
import { parse, applyStyles, resolveExternals } from 'hypermd'
import { resolveQueries } from './query-resolver.js'
import { createQueryFetcher, createSandboxDbCallbacks } from './db.js'
import { createFsLoader } from './loader.js'

const ADDR_HEIGHT       = 1
const CONSOLE_WIDTH_PCT = 27   // % of total width when docked right
const CONSOLE_HEIGHT    = 8    // rows when docked bottom
const CONSOLE_MAX_LINES = 200

/**
 * Stub query fetcher — returns empty results until Hypergraph is wired.
 * Replace with a real db.query() call when integrating Hypergraph.
 */
async function stubQueryFetcher(filter) {
  if (process.env.HYPERBBS_DEBUG) {
    process.stderr.write(`[hyperbbs:query] stub: ${JSON.stringify(filter)}\n`)
  }
  return []
}

export class BrowserShell {
  /**
   * @param {import('@opentui/core').CliRenderer} renderer
   * @param {object} [opts]
   * @param {object[]} [opts.userBindings] - keybinding overrides
   * @param {object|null} [opts.graph] - Hypergraph instance; when provided,
   *   :::query blocks and script db.* calls use real graph data instead of stubs
   */
  constructor(renderer, opts = {}) {
    // Accept either (renderer, userBindings[]) for backward compat or (renderer, opts{})
    const userBindings = Array.isArray(opts) ? opts : (opts.userBindings ?? [])
    this._graph = Array.isArray(opts) ? null : (opts.graph ?? null)

    this.renderer    = renderer
    this._resolveKey = createKeyResolver(userBindings)

    this._consoleLines   = []    // TextRenderable refs, one per log entry
    this._focusables     = []
    this._focusIndex     = -1
    this._devtoolsOpen   = true
    this._devtoolsDock   = 'right'  // 'right' | 'bottom'
    this._addressFocused = false
    this._reconciler     = null
    this._sandbox        = null
    this._currentPath    = null

    this._buildLayout()
    this._wireKeyboard()
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Load and render a .hmd file by path.
   * Can be called repeatedly to navigate between pages.
   */
  async loadFile(filePath) {
    const absPath = resolve(filePath)
    this._setAddressText(absPath)
    this._addressInput.value = absPath
    this._currentPath = absPath

    let doc
    try {
      const source = readFileSync(absPath, 'utf8')
      doc = parse(source, { baseKey: absPath })
      await resolveExternals(doc, createFsLoader(absPath))
      const queryFetcher = this._graph
        ? createQueryFetcher(this._graph)
        : stubQueryFetcher
      await resolveQueries(doc, queryFetcher)
      applyStyles(doc.nodes, doc.styles)
    } catch (e) {
      this._appendConsole('error', `Failed to load "${absPath}": ${e.message}`)
      return
    }

    this._mountDoc(doc)
  }

  destroy() {
    this._sandbox?.destroy()
    this._unwireKeyboard?.()
  }

  // ─── Layout ────────────────────────────────────────────────────────────────

  _buildLayout() {
    const r = this.renderer

    // ── Root: full screen column ──
    this._root = new BoxRenderable(r, {
      width: '100%', height: '100%', flexDirection: 'column',
    })
    r.root.add(this._root)

    // ── Address bar ──
    this._buildAddressBar()

    // ── Body: content + devtools side by side (or stacked) ──
    this._body = new BoxRenderable(r, {
      width: '100%', flexGrow: 1, flexDirection: 'row',
    })
    this._root.add(this._body)

    // Viewport
    this._viewport = new ScrollBoxRenderable(r, {
      flexGrow: 1, height: '100%',
      scrollY: true, scrollX: false,
      stickyScroll: false, viewportCulling: false,
      contentOptions: { flexDirection: 'column', padding: 1, gap: 1 },
      verticalScrollbarOptions: { showArrows: true },
    })
    this._body.add(this._viewport)

    // Devtools panel (right dock by default)
    this._buildDevtools()
  }

  _buildAddressBar() {
    const r = this.renderer

    this._addrBar = new BoxRenderable(r, {
      width: '100%', height: ADDR_HEIGHT,
      flexDirection: 'row', backgroundColor: '#111827',
    })

    // Back/forward placeholders (future nav history)
    const navBtns = new TextRenderable(r, { content: ' ← → ', fg: '#4b5563' })
    this._addrBar.add(navBtns)

    // Address input — the main interactive element
    this._addressInput = new InputRenderable(r, {
      flexGrow: 1,
      value: '',
      placeholder: 'hyper:// or file path…',
      fg: '#d1d5db',
      backgroundColor: '#1f2937',
      focusedBackgroundColor: '#374151',
    })
    // Enter in address bar → navigate
    this._addressInput.on('enter', () => {
      const path = this._addressInput.value.trim()
      if (path) this.loadFile(path)
      this._blurAddressBar()
    })
    this._addrBar.add(this._addressInput)

    // Peer status (placeholder until Hypergraph)
    this._peerStatus = new TextRenderable(r, {
      content: ' ○ offline ', fg: '#ef4444',
    })
    this._addrBar.add(this._peerStatus)

    this._root.add(this._addrBar)
  }

  _buildDevtools() {
    const r = this.renderer

    this._devtools = new BoxRenderable(r, {
      width: `${CONSOLE_WIDTH_PCT}%`,
      height: '100%',
      flexDirection: 'column',
      backgroundColor: '#0f172a',
    })

    // ── Devtools header bar ──
    this._devHeader = new BoxRenderable(r, {
      width: '100%', height: 1, flexDirection: 'row',
      backgroundColor: '#1e293b',
    })

    // Active tab label (just "console" for now — "elements" etc later)
    const tabLabel = new TextRenderable(r, {
      content: ' ▸ console', fg: '#94a3b8', flexGrow: 1,
    })
    this._devHeader.add(tabLabel)

    // Dock-toggle button: shows "|" when docked right, "_" when docked bottom
    this._dockToggleBtn = new BoxRenderable(r, {
      width: 3, height: 1, focusable: true,
      backgroundColor: '#1e293b', focusedBackgroundColor: '#334155',
    })
    this._dockToggleLabel = new TextRenderable(r, { content: '_', fg: '#64748b' })
    this._dockToggleBtn.add(this._dockToggleLabel)
    this._dockToggleBtn.onMouseDown = () => this._toggleDock()
    this._dockToggleBtn.onKeyDown = (key) => {
      if (key.name === 'return' || key.name === 'space') this._toggleDock()
    }
    this._devHeader.add(this._dockToggleBtn)

    // Close button
    const closeBtn = new BoxRenderable(r, {
      width: 3, height: 1, focusable: true,
      backgroundColor: '#1e293b', focusedBackgroundColor: '#334155',
    })
    closeBtn.add(new TextRenderable(r, { content: ' ×', fg: '#64748b' }))
    closeBtn.onMouseDown = () => this._setDevtoolsOpen(false)
    closeBtn.onKeyDown = (key) => {
      if (key.name === 'return' || key.name === 'space') this._setDevtoolsOpen(false)
    }
    this._devHeader.add(closeBtn)

    this._devtools.add(this._devHeader)

    // ── Console scroll area ──
    // A ScrollBoxRenderable containing one TextRenderable per log entry,
    // added dynamically. stickyScroll: true auto-scrolls to newest entry
    // (like a terminal), but the user can scroll up to read history and
    // it won't snap back until a new entry arrives.
    this._consoleScroll = new ScrollBoxRenderable(r, {
      flexGrow: 1,
      width: '100%',
      scrollY: true,
      scrollX: false,
      stickyScroll: true,
      stickyStart: 'bottom',    // auto-scroll to newest entry on content change,
                                 // but respects manual scroll (user scrolled up to
                                 // inspect history → new entries don't jump it back
                                 // until user scrolls back to the bottom)
      viewportCulling: false,
      focusable: true,
      contentOptions: { flexDirection: 'column' },
      verticalScrollbarOptions: { showArrows: false },
    })
    this._devtools.add(this._consoleScroll)
    // Keep a reference to the content box for adding/removing log TextRenderables
    this._consoleLines = []   // TextRenderable refs, one per log entry

    this._body.add(this._devtools)
  }

  // ─── Document mounting ─────────────────────────────────────────────────────

  _mountDoc(doc) {
    this._clearViewport()
    this._clearConsole()
    this._sandbox?.destroy()
    this._sandbox = null
    this._reconciler = null

    this._reconciler = new Reconciler(this.renderer)
    this._reconciler.mountDocument(doc.nodes, this._viewport)
    this._buildFocusList()
    if (this._focusables.length > 0) this._setFocus(0)

    if (doc.scripts.length > 0) {
      const dbCallbacks = this._graph
        ? createSandboxDbCallbacks(this._graph)
        : {}

      this._sandbox = new SandboxHost({
        reconciler: this._reconciler,
        identity: this._graph?.identity?.identityPublicKey?.toString('hex') ?? null,
        db: null,
        onPatch: createTuiPatcher(this.renderer),
        onConsole: (level, args) => this._appendConsole(level, args.join(' ')),
        onScriptError: (msg) => this._appendConsole('error', msg),
        ...dbCallbacks,
      })
      this._sandbox.runScripts(doc.scripts, doc.nodes)
      this._sandbox.on('navigate', (addr) => this.loadFile(addr))
      this._sandbox.on('notify',   (text, lvl) => this._appendConsole(lvl ?? 'log', `[notify] ${text}`))
    }
  }

  _clearViewport() {
    for (const child of this._viewport.getChildren()) {
      try { this._viewport.remove(child.id) } catch {}
    }
  }

  // ─── Address bar ───────────────────────────────────────────────────────────

  _setAddressText(text) {
    this._addressInput.value = text
  }

  _focusAddressBar() {
    this._addressFocused = true
    this._focusRenderable(this._addressInput)
  }

  _blurAddressBar() {
    this._addressFocused = false
    try { this._addressInput.blur?.() } catch {}
    if (this._focusables.length > 0) {
      this._focusRenderable(this._focusables[Math.max(0, this._focusIndex)])
    }
  }

  // ─── Devtools panel ────────────────────────────────────────────────────────

  _setDevtoolsOpen(open) {
    this._devtoolsOpen = open
    try {
      if (open) {
        // Re-add to body if not already there
        const children = this._body.getChildren()
        if (!children.includes(this._devtools)) {
          this._body.add(this._devtools)
        }
      } else {
        this._body.remove(this._devtools.id)
      }
    } catch {}
  }

  _toggleDevtools() {
    this._setDevtoolsOpen(!this._devtoolsOpen)
  }

  _toggleDock() {
    this._devtoolsDock = this._devtoolsDock === 'right' ? 'bottom' : 'right'
    this._dockToggleLabel.content = this._devtoolsDock === 'right' ? '_' : '|'
    this._applyDockLayout()
  }

  _applyDockLayout() {
    if (this._devtoolsDock === 'right') {
      // Devtools panel: fixed width column alongside viewport
      try {
        this._body.flexDirection    = 'row'
        this._devtools.width        = `${CONSOLE_WIDTH_PCT}%`
        this._devtools.height       = '100%'
        this._viewport.height       = '100%'
      } catch {}
    } else {
      // Devtools panel: fixed height row below viewport
      try {
        this._body.flexDirection    = 'column'
        this._devtools.width        = '100%'
        this._devtools.height       = CONSOLE_HEIGHT
        this._viewport.flexGrow     = 1
        this._viewport.height       = undefined
      } catch {}
    }
  }

  // ─── Console output ────────────────────────────────────────────────────────

  _appendConsole(level, text) {
    const color = { log: '#94a3b8', warn: '#fbbf24', error: '#f87171' }[level] ?? '#94a3b8'
    const clean = text.replace(/[\r\n]+/g, ' ').slice(0, 300)

    // Add a new TextRenderable child for this log entry
    const line = new TextRenderable(this.renderer, {
      content: ` ${clean}`,
      fg: color,
      width: '100%',
    })
    this._consoleScroll.add(line)
    this._consoleLines.push(line)

    // Trim the oldest entries when we exceed the ring buffer limit,
    // removing their renderables from the scroll box too
    if (this._consoleLines.length > CONSOLE_MAX_LINES) {
      const oldest = this._consoleLines.shift()
      try { this._consoleScroll.remove(oldest.id) } catch {}
    }

    // Auto-open devtools when a script logs something
    if (!this._devtoolsOpen) this._setDevtoolsOpen(true)
  }

  _clearConsole() {
    for (const line of this._consoleLines) {
      try { this._consoleScroll.remove(line.id) } catch {}
    }
    this._consoleLines = []
  }

  // ─── Tab focus cycling ─────────────────────────────────────────────────────

  _buildFocusList() {
    this._focusables = []
    if (!this._reconciler) return
    const walk = (renderable) => {
      if (renderable.focusable) this._focusables.push(renderable)
      if (renderable.getChildren) {
        for (const child of renderable.getChildren()) walk(child)
      }
    }
    walk(this._viewport)
  }

  _setFocus(index) {
    if (!this._focusables.length) return
    this._focusIndex = ((index % this._focusables.length) + this._focusables.length) % this._focusables.length
    this._focusRenderable(this._focusables[this._focusIndex])
  }

  _focusNext() { this._setFocus(this._focusIndex + 1) }
  _focusPrev() { this._setFocus(this._focusIndex - 1) }

  /**
   * Transfer focus using renderable.focus()/blur() rather than
   * renderer.focusRenderable(). The renderer method only sets the visual
   * highlight — it does NOT wire up the keypress handler. That happens
   * inside renderable.focus() which subscribes to renderer._internalKeyInput.
   * Without calling .focus(), the renderable never receives keystrokes.
   */
  _focusRenderable(target) {
    if (!target) return
    try {
      const current = this.renderer.currentFocusedRenderable
      if (current && current !== target) current.blur?.()
      target.focus?.()
    } catch {}
  }

  // ─── Keyboard handling ─────────────────────────────────────────────────────

  _wireKeyboard() {
    const handler = (buf) => {
      const key = parseKeypress(buf)
      if (!key) return

      const action = this._resolveKey(key)
      if (!action) return

      switch (action) {
        case 'devtools:toggle':        this._toggleDevtools();    break
        case 'devtools:focus_console':
          if (!this._devtoolsOpen) this._setDevtoolsOpen(true)
          this._focusRenderable(this._consoleScroll)
          break
        case 'focus:next':
          if (!this._addressFocused) { this._focusNext(); break }
          return  // let the address input handle Tab
        case 'focus:prev':
          if (!this._addressFocused) { this._focusPrev(); break }
          return
        case 'nav:focus_address': this._focusAddressBar(); break
        case 'nav:escape':
          if (this._addressFocused) this._blurAddressBar()
          break
        // nav:confirm is handled by the InputRenderable 'enter' event directly
        // nav:back / nav:forward — future history implementation
      }
    }

    this.renderer.stdin.on('data', handler)
    this._unwireKeyboard = () => this.renderer.stdin.off('data', handler)
  }
}