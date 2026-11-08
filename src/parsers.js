/**
 * dsh-network-proxy — pure proxy helpers.
 *
 * Dependency-free on purpose: the smoke test imports this module directly so a
 * bare checkout (no `pnpm install`, no host kernel) still verifies the parsing
 * and validation logic that the engine builds on.
 *
 * @module src/parsers.js
 */

/** Every proxy environment variable name the engine manages (upper + lower). */
export const PROXY_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]

/**
 * Fill in the scheme when a user typed a bare `host:port` in the settings row.
 * `http://127.0.0.1:7890` survives untouched; `socks5://...` is not normalised
 * away either — validation decides what is acceptable.
 *
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
export function normalizeProxyUrl(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * Validate a manual proxy URL. Throws with a human-readable reason when the
 * value is empty or not a plain HTTP(S) endpoint — SOCKS and friends are not
 * supported by the undici agents this plugin installs.
 *
 * @param {string|undefined} value - raw user input, normalisation allowed
 * @returns {string} the normalised URL
 */
export function validateProxyUrl(value) {
  const url = normalizeProxyUrl(value)
  if (url === undefined) throw new Error('Manual proxy requires a URL')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Manual proxy must be a valid URL, e.g. http://127.0.0.1:7890')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Manual proxy supports only http:// and https:// URLs')
  }
  if (parsed.hostname === '') throw new Error('Manual proxy URL has no host')
  return url
}

/**
 * Parse a Windows `ProxyServer` registry value.
 *
 * Windows writes the setting either as a bare `host:port` or in the multi-
 * protocol form `http=host:port;https=host:port`, with optional
 * `socks=` entries this plugin does not use.
 *
 * @param {string|undefined} value - the raw registry string
 * @returns {{httpProxy?:string, httpsProxy?:string}}
 */
export function parseWindowsProxyServer(value) {
  const entries = String(value ?? '').split(';').map((entry) => entry.trim()).filter(Boolean)
  if (entries.length === 0) return {}
  const named = Object.fromEntries(entries.flatMap((entry) => {
    const separator = entry.indexOf('=')
    return separator < 0 ? [] : [[entry.slice(0, separator).toLowerCase(), entry.slice(separator + 1)]]
  }))
  const fallback = entries.find((entry) => !entry.includes('='))
  return {
    httpProxy: normalizeProxyUrl(named.http ?? fallback),
    httpsProxy: normalizeProxyUrl(named.https ?? named.http ?? fallback),
  }
}

/**
 * Snapshot the proxy environment as the harness process inherited it, so a
 * later "restore" puts the process back exactly where it started — including
 * deleting variables that were never set at all.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string|undefined>}
 */
export function captureProxyEnvironment(env = process.env) {
  const snapshot = {}
  for (const name of PROXY_ENV_NAMES) snapshot[name] = env[name]
  return snapshot
}

/**
 * Restore `process.env` to the captured proxy shape (in-place; the engine owns
 * these variables for the life of the process).
 *
 * @param {Record<string, string|undefined>} inherited
 */
export function restoreProxyEnvironment(inherited, env = process.env) {
  for (const name of PROXY_ENV_NAMES) {
    const value = inherited[name]
    if (value === undefined) delete env[name]
    else env[name] = value
  }
}

/**
 * Point the proxy environment at one manual endpoint, keeping whatever
 * `NO_PROXY` the harness inherited so bypass rules survive the switch.
 *
 * @param {string} url
 * @param {Record<string, string|undefined>} inherited
 * @param {NodeJS.ProcessEnv} [env]
 */
export function setManualProxyEnvironment(url, inherited, env = process.env) {
  for (const name of PROXY_ENV_NAMES) delete env[name]
  env.HTTP_PROXY = url
  env.HTTPS_PROXY = url
  env.http_proxy = url
  env.https_proxy = url
  const noProxy = inherited.NO_PROXY ?? inherited.no_proxy
  if (noProxy !== undefined) {
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }
}

/**
 * Export a *discovered* system proxy into the environment (system mode).
 *
 * The system mode's job is not just to install a dispatcher: a proxy the OS
 * already advertises must also reach the child processes the harness spawns
 * (git, pnpm, package installers, shell tools), otherwise those bypass the
 * very egress the harness itself uses and silently fail on hosts that need
 * the proxy. So the discovered endpoint is written out as `HTTP(S)_PROXY`.
 *
 * Three rules keep this safe:
 *
 * 1. **Only a complete pair is exported.** Windows may advertise only
 *    `http=`; the https variable then follows the http one (matching
 *    `parseWindowsProxyServer`'s fallback), but a mode that discovered no
 *    endpoint at all exports nothing rather than clearing the environment.
 * 2. **`ALL_PROXY` is cleared.** It is a catch-all that would also capture
 *    protocols this plugin never validated.
 * 3. **The bypass list always leads with loopback** (`withLoopbackNoProxy`),
 *    so the discovered value can never steer the harness's own local traffic
 *    into a proxy, and the OS override list is carried alongside it.
 *
 * @param {{httpProxy?:string, httpsProxy?:string, noProxy?:string}|null} discovered
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} `true` when something was exported
 */
export function exportSystemProxyEnvironment(discovered, env = process.env) {
  const httpProxy = discovered?.httpProxy
  const httpsProxy = discovered?.httpsProxy
  if (typeof httpProxy !== 'string' && typeof httpsProxy !== 'string') return false
  const http = normalizeProxyUrl(httpProxy) ?? undefined
  const https = normalizeProxyUrl(httpsProxy) ?? http
  if (http === undefined && https === undefined) return false
  for (const name of PROXY_ENV_NAMES) delete env[name]
  if (http !== undefined) {
    env.HTTP_PROXY = http
    env.http_proxy = http
  }
  if (https !== undefined) {
    env.HTTPS_PROXY = https
    env.https_proxy = https
  }
  const noProxy = withLoopbackNoProxy(discovered?.noProxy)
  env.NO_PROXY = noProxy
  env.no_proxy = noProxy
  return true
}

/** Clear every managed proxy variable (direct mode). */
export function clearProxyEnvironment(env = process.env) {
  for (const name of PROXY_ENV_NAMES) delete env[name]
}

/**
 * Loopback destinations that must never be routed through a proxy.
 *
 * The harness talks to its own web server and other local services over
 * 127.0.0.1; a system-proxy override list that forgot `<local>` (or is empty)
 * would otherwise hand that loopback traffic to whatever proxy the registry
 * happens to name. `[::1]` stays bracketed on purpose: undici's no-proxy
 * parser treats `a:123` as host:port, so a bare `::1` would be mangled into
 * host `:` + port 1 and stop matching.
 */
export const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,[::1]'

/**
 * Union the loopback bypass into a caller-supplied no-proxy list.
 * Duplicates are harmless (undici matches per entry) and an empty/absent
 * value still yields the loopback protection.
 *
 * @param {string|null|undefined} value - inherited NO_PROXY / system override list
 * @returns {string}
 */
export function withLoopbackNoProxy(value) {
  const parts = [LOOPBACK_NO_PROXY]
  if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim())
  return dedupeNoProxy(parts.join(','))
}

/**
 * Drop case-insensitive duplicates from a no-proxy list while keeping the
 * first occurrence (so the loopback set stays where it was placed).
 *
 * Windows' own `ProxyOverride` routinely repeats `localhost`, which used to
 * leave the exported `NO_PROXY` listing it twice — harmless to undici, but
 * noise in a value the user reads and other tools parse.
 *
 * @param {string} list
 * @returns {string}
 */
function dedupeNoProxy(list) {
  const seen = new Set()
  const kept = []
  for (const entry of String(list ?? '').split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(trimmed)
  }
  return kept.join(',')
}
