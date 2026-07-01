/**
 * loader.js
 *
 * HyperBBS's implementation of hypermd's ExternalLoader callback (see
 * hypermd's resolve.js for the contract). This is the seam where
 * "fetching an external script/style file" becomes a real operation.
 *
 * CURRENT (prototype): filesystem-relative reads, since we're not yet
 * wired up to a live Hypergraph instance. A `src` like "theme.hcss"
 * resolves relative to the directory of the .hmd file being rendered.
 *
 * FUTURE (real HyperBBS): this should instead resolve `src` against
 * the current page's Hypergraph key and read through db.get(), since
 * an "external file" on a hypersite isn't really a separate file at
 * all — it's another key in the same Hypergraph space. Swapping this
 * implementation is the entire integration point; nothing in hypermd
 * or the reconciler needs to change when that happens, since both only
 * see the resolved source/rules, never the loading mechanism.
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'

/**
 * Build a loader function scoped to a base .hmd file's directory, so
 * relative `src` references resolve the way you'd expect (same
 * directory as the page referencing them, not the process's cwd).
 *
 * @param {string} baseFilePath - path to the .hmd file currently being rendered
 * @returns {import('hypermd').ExternalLoader}
 */
export function createFsLoader(baseFilePath) {
  const baseDir = dirname(baseFilePath)

  return async function fsLoader(src, kind) {
    if (isExternalUrl(src)) {
      // hyper://... references aren't resolvable yet — no live
      // Hypergraph instance exists in this prototype. Surfacing this
      // as a clear error (caught by resolveExternals and logged, per
      // its documented failure behavior) rather than silently no-op'ing.
      throw new Error(`hyper:// references not supported yet (got "${src}") — Hypergraph integration is future work`)
    }

    const path = isAbsolute(src) ? src : resolve(baseDir, src)
    return await readFile(path, 'utf8')
  }
}

function isExternalUrl(src) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(src)
}