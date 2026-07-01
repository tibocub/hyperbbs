/**
 * shell.js
 *
 * The browser chrome that wraps the hypersite viewport. Owns:
 *
 *   ┌─ address bar ──────────────────────────────────────────────┐
 *   │ hyper://current-page-key-or-path                  [peers] │
 *   ├─ viewport (ScrollBoxRenderable) ──────────────────────────┤
 *   │                                                           │
 *   │  hypersite content                                        │
 *   │                                                           │
 *   ├─ console panel (collapsible) ─────────────────────────────┤
 *   │ [script:log] last log line                                │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Global keyboard handling (Tab/Shift+Tab focus cycling, Ctrl+L
 * address bar focus) is wired here via renderer.stdin interception
 * using OpenTUI's own parseKeypress — this is how we get shell-level
 * shortcuts before they reach the focused renderable's onKeyDown.
 *
 * The Reconciler and SandboxHost are created by the shell so they can
 * share the console routing and focus management cleanly.
 */

import { BoxRenderable, TextRenderable, ScrollBoxRenderable, parseKeypress } from '@opentui/core'
import { Reconciler } from './reconciler.js'
import { SandboxHost } from './sandbox/host.js'
import { createTuiPatcher } from './patcher.js'

const ADDRESS_BAR_HEIGHT   = 1   // single row
const CONSOLE_PANEL_HEIGHT = 4   // lines of console history shown
const CONSOLE_MAX_LINES    = 100 // ring buffer size

export class BrowserShell {
  /**
   * @param {import('@opentui/core').CliRenderer} renderer
   */
  constructor(renderer) {
    this.renderer = renderer
    this._consoleLogs = []       // ring buffer of { level, text } entries
    this._consoleLines = []      // TextRenderable refs for the console panel rows
    this._focusables = []        // ordered list of focusable _tuiRefs for Tab cycling
    this._focusIndex = -1
    this._consoleVisible = true

    this._buildLayout()
    this._wireKeyboard()
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Mount and render a parsed, styled HyperDOM document.
   * Replaces whatever was previously in the viewport.
   *
   * @param {object} doc      - from hypermd parse() + applyStyles()
   * @param {string} address  - the address to show in the address bar
   *                           (file path now, hyper:// key later)
   */
  load(doc, address) {
    this._clearViewport()
    this._setAddress(address)
    this._clearConsole()

    // Fresh reconciler per page load
    if (this._reconciler) this._reconciler = null
    this._reconciler = new Reconciler(this.renderer)
    this._reconciler.mountDocument(doc.nodes, this._viewport)

    // Collect focusable renderables in document order for Tab cycling
    this._buildFocusList()

    // Focus the first focusable element if any
    if (this._focusables.length > 0) {
      this._setFocus(0)
    }

    // Wire sandbox if the document has scripts
    if (this._sandbox) {
      this._sandbox.destroy()
      this._sandbox = null
    }

    if (doc.scripts.length > 0) {
      this._sandbox = new SandboxHost({
        reconciler: this._reconciler,
        identity: null,
        db: null,
        onPatch: createTuiPatcher(this.renderer),
        onConsole: (level, args) => this._appendConsole(level, args.join(' ')),
        onScriptError: (message) => this._appendConsole('error', message),
      })
      this._sandbox.runScripts(doc.scripts, doc.nodes)

      this._sandbox.on('navigate', (addr) => this.emit?.('navigate', addr))
      this._sandbox.on('notify',   (text, level) => this._appendConsole(level, `[notify] ${text}`))
    }
  }

  /**
   * Tear down everything cleanly (call before process exit or navigation).
   */
  destroy() {
    this._sandbox?.destroy()
    this._unwireKeyboard?.()
  }

  // ─── Layout construction ───────────────────────────────────────────────────

  _buildLayout() {
    const r = this.renderer

    // Root: full screen, column direction
    this._root = new BoxRenderable(r, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
    })
    r.root.add(this._root)

    // ── Address bar (top row) ──
    this._addressBar = new BoxRenderable(r, {
      width: '100%',
      height: ADDRESS_BAR_HEIGHT,
      flexDirection: 'row',
      backgroundColor: '#1a1a2e',
    })
    this._addressText = new TextRenderable(r, {
      content: ' hyper://…',
      fg: '#7f8c8d',
      width: '100%',
    })
    this._peerStatus = new TextRenderable(r, {
      content: '○ offline ',
      fg: '#e74c3c',
    })
    this._addressBar.add(this._addressText)
    this._addressBar.add(this._peerStatus)
    this._root.add(this._addressBar)

    // ── Viewport (middle, fills remaining space via flexGrow) ──
    // flexGrow: 1 is the correct Yoga prop for "fill remaining height
    // after fixed-height siblings" — calc() strings are not supported
    // by OpenTUI's Yoga layout engine.
    this._viewport = new ScrollBoxRenderable(r, {
      width: '100%',
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
      viewportCulling: false,
      contentOptions: {
        flexDirection: 'column',
        padding: 1,
        gap: 1,
      },
      verticalScrollbarOptions: { showArrows: true },
    })
    this._root.add(this._viewport)

    // ── Console panel (bottom) ──
    this._consolePanel = new BoxRenderable(r, {
      width: '100%',
      height: CONSOLE_PANEL_HEIGHT,
      flexDirection: 'column',
      backgroundColor: '#0d0d0d',
    })

    // Header row
    const consoleHeader = new TextRenderable(r, {
      content: ' ▸ console',
      fg: '#555',
    })
    this._consolePanel.add(consoleHeader)

    // Log lines (fixed slots — we overwrite content rather than
    // add/remove, keeping layout stable)
    this._consoleLines = []
    for (let i = 0; i < CONSOLE_PANEL_HEIGHT - 1; i++) {
      const line = new TextRenderable(r, {
        content: '',
        fg: '#666',
      })
      this._consolePanel.add(line)
      this._consoleLines.push(line)
    }
    this._root.add(this._consolePanel)
  }

  // ─── Address bar ───────────────────────────────────────────────────────────

  _setAddress(address) {
    this._addressText.content = ` ${address}`
  }

  // ─── Console panel ─────────────────────────────────────────────────────────

  _appendConsole(level, text) {
    const color = { log: '#aaa', warn: '#f39c12', error: '#e74c3c' }[level] ?? '#aaa'
    this._consoleLogs.push({ color, text: `[${level}] ${text}` })
    if (this._consoleLogs.length > CONSOLE_MAX_LINES) {
      this._consoleLogs.shift()
    }
    this._renderConsoleLines()
  }

  _renderConsoleLines() {
    const slots = this._consoleLines.length
    const logs  = this._consoleLogs
    const start = Math.max(0, logs.length - slots)
    for (let i = 0; i < slots; i++) {
      const entry = logs[start + i]
      if (entry) {
        this._consoleLines[i].content = ` ${entry.text}`
        this._consoleLines[i].fg      = entry.color
      } else {
        this._consoleLines[i].content = ''
      }
    }
  }

  _clearConsole() {
    this._consoleLogs = []
    for (const line of this._consoleLines) line.content = ''
  }

  // ─── Viewport management ───────────────────────────────────────────────────

  _clearViewport() {
    const children = this._viewport.getChildren()
    for (const child of children) {
      try { this._viewport.remove(child.id) } catch {}
    }
  }

  // ─── Tab focus cycling ─────────────────────────────────────────────────────

  /**
   * Collect all focusable _tuiRefs from the current reconciler's mounted
   * tree in document order. Called after each page load.
   */
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
    if (this._focusables.length === 0) return
    this._focusIndex = ((index % this._focusables.length) + this._focusables.length) % this._focusables.length
    const target = this._focusables[this._focusIndex]
    try { this.renderer.focusRenderable(target) } catch {}
  }

  _focusNext()  { this._setFocus(this._focusIndex + 1) }
  _focusPrev()  { this._setFocus(this._focusIndex - 1) }

  // ─── Global keyboard interception ──────────────────────────────────────────

  /**
   * Listen on renderer.stdin using OpenTUI's own parseKeypress so we
   * parse the same way OpenTUI does. Shell-level shortcuts are handled
   * here; everything else is left for the focused renderable's onKeyDown.
   *
   * Shell shortcuts:
   *   Tab          → focus next element
   *   Shift+Tab    → focus previous element
   *   Ctrl+L       → (future) focus address bar
   *   Ctrl+`       → toggle console panel visibility
   */
  _wireKeyboard() {
    const handler = (buf) => {
      const key = parseKeypress(buf)
      if (!key) return

      if (key.name === 'tab' && !key.shift) { this._focusNext(); return }
      if (key.name === 'tab' &&  key.shift) { this._focusPrev(); return }
      // Ctrl+` — toggle console
      if (key.ctrl && key.name === '`') { this._toggleConsole(); return }
    }

    this.renderer.stdin.on('data', handler)
    // Store cleanup function for destroy()
    this._unwireKeyboard = () => this.renderer.stdin.off('data', handler)
  }

  _toggleConsole() {
    this._consoleVisible = !this._consoleVisible
    // Collapse the panel to 1 row (header only) or restore it
    // OpenTUI doesn't have a visibility toggle, but height=1 hides all
    // log lines since they're overflow, and the header label changes.
    const h = this._consoleVisible ? CONSOLE_PANEL_HEIGHT : 1
    try { this._consolePanel.height = h } catch {}
  }
}