/**
 * dsh-network-proxy — undici resolution with an offline fallback chain.
 *
 * The plugin needs exactly three things from undici: `Agent`,
 * `EnvHttpProxyAgent`, and `setGlobalDispatcher`. Whether a usable copy is
 * reachable depends on how the harness was installed, so resolution walks a
 * fixed chain instead of a static `import 'undici'` (which would make the
 * whole plugin fail to load whenever the profile has no installed dependency
 * — the state of a hand-copied plugin).
 *
 * Order:
 *
 *   1. `DSH_NETWORK_PROXY_UNDICI` — an explicit directory override, for
 *      debugging or pinning a specific copy;
 *   2. bare `import('undici')` — a dependency actually installed beside the
 *      plugin (the declared `undici` in package.json, resolved by the
 *      profile's module graph when present);
 *   3. the runtime copies the harness itself ships (pnpm's vendored undici),
 *      located relative to `$DSH_HOME` and `process.execPath` — present on a
 *      stock installation, no network and no package install involved;
 *   4. `null` — nothing found. The engine then refuses every switch (inert):
 *      host requests keep the current egress, nothing is installed, and the
 *      settings row reports why.
 *
 * Every candidate must expose the three functions above; a partial copy is
 * skipped rather than half-used. `setGlobalDispatcher` must come from the
 * same copy as the agents it installs (the global symbol is versioned
 * `Symbol.for('undici.globalDispatcher.1')`, shared across copies, but mixing
 * constructors from two copies would still be asking for trouble).
 *
 * @module src/undici-loader.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED = ['Agent', 'EnvHttpProxyAgent', 'setGlobalDispatcher']

/** `$DSH_HOME` else `~/.dsh` — same rule the settings store uses. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * The candidate directories in resolution order (the env override is applied
 * by the caller before this list is consulted).
 *
 * @returns {Array<{source:string, dir:string}>}
 */
export function undiciCandidates() {
  const execDir = path.dirname(process.execPath)
  return [
    {
      source: 'dsh-home-runtime',
      dir: path.join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'dist', 'node_modules', 'undici'),
    },
    {
      source: 'app-runtime',
      dir: path.join(execDir, 'resources', 'runtime', 'pnpm', 'dist', 'node_modules', 'undici'),
    },
    {
      source: 'app-primary-runtime',
      dir: path.join(execDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'dist', 'node_modules', 'undici'),
    },
  ]
}

/**
 * Project a loaded namespace (ESM or CJS interop) onto the three functions
 * the engine needs, or `null` when any is missing.
 *
 * @param {object|undefined} namespace
 * @returns {{Agent:Function, EnvHttpProxyAgent:Function, setGlobalDispatcher:Function}|null}
 */
function shapeOf(namespace) {
  const cjs = namespace?.default ?? namespace
  const pick = (key) => {
    const value = typeof namespace?.[key] === 'function' ? namespace[key] : typeof cjs?.[key] === 'function' ? cjs[key] : undefined
    return value
  }
  const shape = {
    Agent: pick('Agent'),
    EnvHttpProxyAgent: pick('EnvHttpProxyAgent'),
    setGlobalDispatcher: pick('setGlobalDispatcher'),
    // Optional: exported by every undici release so far; lets the engine put
    // the pre-plugin dispatcher back on dispose. Absence degrades to "keep
    // whatever is global" rather than failing the shape check.
    getGlobalDispatcher: pick('getGlobalDispatcher'),
  }
  return REQUIRED.every((key) => typeof shape[key] === 'function') ? shape : null
}

/**
 * Resolve undici through the fallback chain.
 *
 * Never rejects: "not found" is a supported outcome (`null`) that keeps the
 * engine inert instead of crashing the plugin.
 *
 * @param {{logger?:{info?:(m:string)=>void, warn?:(m:string)=>void, debug?:(m:string)=>void}}} [options]
 * @returns {Promise<({Agent:Function, EnvHttpProxyAgent:Function, setGlobalDispatcher:Function, source:string})|null>}
 */
export async function loadUndici({ logger } = {}) {
  const override = process.env.DSH_NETWORK_PROXY_UNDICI
  const candidates = []
  if (typeof override === 'string' && override.trim() !== '') {
    candidates.push({ source: 'env-override', dir: override.trim() })
  }
  candidates.push(...undiciCandidates())

  // 2. the declared dependency, when the profile's module graph resolves it.
  try {
    const shape = shapeOf(await import('undici'))
    if (shape !== null) {
      logger?.info?.('network-proxy: undici resolved from the package dependency')
      return { ...shape, source: 'package' }
    }
  } catch (error) {
    logger?.debug?.(`network-proxy: bare undici unavailable (${error?.message ?? error})`)
  }

  // 3. runtime copies the harness ships (offline: no network, no install).
  for (const { source, dir } of candidates) {
    try {
      const entry = path.join(dir, 'index.js')
      if (!fs.statSync(entry).isFile()) continue
      const shape = shapeOf(await import(pathToFileURL(entry).href))
      if (shape === null) {
        logger?.warn?.(`network-proxy: candidate ${source} lacks the required exports, skipping`)
        continue
      }
      logger?.info?.(`network-proxy: undici resolved from ${source} (${dir})`)
      return { ...shape, source }
    } catch {
      // Missing/unreadable candidate: try the next one.
    }
  }

  // 4. nothing found — the engine stays inert instead of half-applying.
  logger?.warn?.('network-proxy: no usable undici found — proxy settings will be refused (host egress unchanged)')
  return null
}
