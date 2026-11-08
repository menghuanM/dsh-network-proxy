/**
 * dsh-network-proxy — host half.
 *
 * Owns the harness process's outbound egress in three modes:
 *
 * - `system` — follow the OS proxy: Windows reads the `Internet Settings`
 *   registry values, other platforms fall back to the inherited proxy
 *   environment; no system proxy means a direct agent;
 * - `manual` — one http(s) endpoint the user types into the settings row;
 * - `direct` — no proxy at all.
 *
 * Application happens two ways, both live without a restart:
 *
 * 1. the undici global dispatcher is replaced, which steers every
 *    `fetch`/undici request made inside the harness process (LLM calls, the
 *    web tools, anything the kernel routes through the global agent);
 * 2. the proxy environment variables are rewritten, so child processes the
 *    harness spawns inherit the same egress. In `system` mode this is an
 *    *export*, not an inherit: the endpoint the OS advertises is written out
 *    as `HTTP(S)_PROXY` + a loopback-safe `NO_PROXY`, so git, pnpm and
 *    package installers take the same egress as the harness itself.
 *
 * ## Network-safety model (v2.1.0)
 *
 * Registering this plugin must never take the harness offline. Four guards
 * enforce that, in order:
 *
 * 1. **probe before switching** — a system or manual endpoint is
 *    TCP-probed first; a stale registry entry left behind by an exited proxy
 *    client (v2rayN, Clash, …) is caught before it can become the global
 *    dispatcher;
 * 2. **failure means "no change"** — probe/config failures return an error
 *    view and touch neither the current dispatcher nor the environment, so
 *    the pre-plugin egress keeps working;
 * 3. **loopback never proxies** — `localhost`/`127.0.0.1`/`[::1]` are unioned
 *    into every no-proxy list, independent of what the system override says,
 *    so the harness's own local traffic cannot be steered into the proxy;
 * 4. **degraded means inert** — if undici cannot be resolved (see
 *    `src/undici-loader.js` for the fallback chain), the plugin changes
 *    nothing and reports why, instead of half-applying a setting.
 *
 * Disposal restores the dispatcher that was global before this plugin and
 * the inherited environment, so disabling/unloading the plugin returns the
 * process to its pre-plugin network state.
 *
 * The selection persists to `~/.dsh/network-proxy/settings.json` and the
 * settings row drives it over the plugin's own same-origin
 * `/api/network-proxy` routes, mounted through the `webServer` service in a
 * nested fiber so a composition without an HTTP server still gets the proxy —
 * only the dashboard goes away.
 *
 * Nothing is declared in `inject`: the egress is the plugin's reason to
 * exist and it needs no service the composition may omit; the
 * browser-facing API pends in its own fiber instead of dragging this one
 * down with it.
 *
 * @module index.js
 */

import path from 'node:path'
import {
  clearProxyEnvironment,
  captureProxyEnvironment,
  exportSystemProxyEnvironment,
  parseWindowsProxyServer,
  restoreProxyEnvironment,
  setManualProxyEnvironment,
  validateProxyUrl,
  withLoopbackNoProxy,
} from './src/parsers.js'
import { probeEndpoint } from './src/probe.js'
import { interpretInternetSettings, windowsRegistryReaders } from './src/discover.js'
import { loadUndici } from './src/undici-loader.js'
import { DATA_DIR_NAME, resolveDshHome, SettingsStore } from './src/store.js'

export const name = 'network-proxy'

/**
 * No hard services. The egress is the plugin's reason to exist and it needs
 * nothing but undici (resolved lazily with a fallback chain); the
 * browser-facing API pends in its own fiber instead of dragging this one
 * down with it.
 */
export const inject = []

const MODES = new Set(['system', 'manual', 'direct'])

/**
 * Read the active Windows system proxy from the registry.
 *
 * PAC (`AutoConfigURL`) is not supported — a proxy auto-configuration script
 * cannot be honored from a dispatcher — and is reported as an error so the
 * settings row tells the user to switch to manual mode.
 *
 * Delegates the actual reading to `src/discover.js`, which walks a chain
 * (`reg.exe` → PowerShell) instead of betting the whole mode on one
 * interpreter being spawnable.
 *
 * @param {{logger?:object}} [options]
 * @returns {{httpProxy?:string, httpsProxy?:string, noProxy?:string}|null}
 *   `null` when Windows has proxying turned off entirely.
 */
function readWindowsSystemProxy({ logger } = {}) {
  const readers = windowsRegistryReaders()
  let lastError
  for (const reader of readers) {
    let raw
    try {
      raw = reader.read()
    } catch (error) {
      // A reader that cannot run is a reason to try the next one.
      lastError = error
      logger?.debug?.(`network-proxy: ${reader.source} could not read the system proxy (${error?.message ?? error})`)
      continue
    }
    // A successful read is the answer: interpretation failures (PAC in use,
    // proxy enabled with no server) are definitive, not "try another reader".
    return interpretInternetSettings(raw, parseWindowsProxyServer)
  }
  throw lastError ?? new Error('Windows system proxy could not be read')
}

/**
 * The "follow system" view on the current platform: the registry on Windows,
 * the inherited proxy environment elsewhere (or as a Windows fallback when
 * registry reading is unavailable).
 *
 * @param {Record<string, string|undefined>} inherited
 * @param {{logger?:object}} [options]
 * @returns {{httpProxy?:string, httpsProxy?:string, noProxy?:string}}
 */
function systemProxyOptions(inherited, { logger } = {}) {
  if (process.platform === 'win32') {
    try {
      const fromRegistry = readWindowsSystemProxy({ logger })
      if (fromRegistry !== null) return fromRegistry
      // Proxying switched off in the OS: straight to a direct agent.
      return {}
    } catch (error) {
      // An unreadable or PAC-locked registry is only fatal when the user
      // cannot fall back to the inherited environment at all.
      const fallback = {
        httpProxy: inherited.HTTP_PROXY ?? inherited.http_proxy,
        httpsProxy: inherited.HTTPS_PROXY ?? inherited.https_proxy,
        noProxy: inherited.NO_PROXY ?? inherited.no_proxy,
      }
      if (!fallback.httpProxy && !fallback.httpsProxy) throw error
      return fallback
    }
  }
  return {
    httpProxy: inherited.HTTP_PROXY ?? inherited.http_proxy,
    httpsProxy: inherited.HTTPS_PROXY ?? inherited.https_proxy,
    noProxy: inherited.NO_PROXY ?? inherited.no_proxy,
  }
}

/**
 * Build the undici dispatcher for a validated selection.
 *
 * Both proxying modes install an `EnvHttpProxyAgent` (never a bare
 * `ProxyAgent`) so the loopback union always applies: `ProxyAgent` has no
 * no-proxy concept and would happily send `127.0.0.1` traffic to the proxy.
 *
 * @param {{Agent:Function, EnvHttpProxyAgent:Function}} undici
 * @param {{mode:string, url:string}} value
 * @param {Record<string, string|undefined>} inherited
 * @param {{httpProxy?:string, httpsProxy?:string, noProxy?:string}|null} [systemOptions]
 *   pre-resolved system view — passed in by `activate` so the registry is
 *   read once per activation instead of twice (one spawn of PowerShell).
 */
function dispatcherFor(undici, value, inherited, systemOptions) {
  if (value.mode === 'direct') return new undici.Agent()
  if (value.mode === 'manual') {
    return new undici.EnvHttpProxyAgent({
      httpProxy: value.url,
      httpsProxy: value.url,
      noProxy: withLoopbackNoProxy(inherited.NO_PROXY ?? inherited.no_proxy),
    })
  }
  const options = systemOptions ?? {}
  if (!options.httpProxy && !options.httpsProxy) return new undici.Agent()
  return new undici.EnvHttpProxyAgent({
    httpProxy: options.httpProxy,
    httpsProxy: options.httpsProxy,
    noProxy: withLoopbackNoProxy(options.noProxy),
  })
}

/** The endpoint a mode would proxy through, or `null` when it would not. */
function probeTargetFor(value, systemProxy) {
  if (value.mode === 'manual') return value.url
  if (value.mode === 'system') return systemProxy.httpProxy ?? systemProxy.httpsProxy ?? null
  return null
}

/**
 * Write the proxy environment for one mode (child-process channel).
 *
 * `system` is the interesting case: it does not inherit blindly, it *exports
 * what it discovered*. The registry / inherited environment already answered
 * "which proxy does the OS use"; that answer is written out as
 * `HTTP(S)_PROXY` (plus a loopback-safe `NO_PROXY`) so spawned tools — git,
 * pnpm, package installers — take the same egress as the harness itself.
 *
 * A system mode that discovered no endpoint exports nothing and leaves the
 * inherited environment in place: "the OS has no proxy" is not a reason to
 * overwrite variables the harness was launched with.
 *
 * @param {{mode:string, url:string}} value
 * @param {Record<string, string|undefined>} inherited
 * @param {{httpProxy?:string, httpsProxy?:string, noProxy?:string}|null} [systemProxy]
 * @returns {boolean} whether the environment was actually rewritten
 */
function applyEnvironment(value, inherited, systemProxy) {
  if (value.mode === 'system') {
    if (exportSystemProxyEnvironment(systemProxy)) return true
    // Nothing discovered: the OS has no proxy, which is not a reason to
    // overwrite variables the harness was launched with.
    restoreProxyEnvironment(inherited)
    return false
  }
  if (value.mode === 'manual') setManualProxyEnvironment(value.url, inherited)
  else clearProxyEnvironment()
  return true
}

/**
 * The trust fence for the plugin's HTTP surface.
 *
 * The plugin registers a prefix *longer* than the kernel's `/api`, and
 * `webServer` dispatch is longest-prefix-wins — so these routes run before the
 * connection service's own admission check. The kernel's decision is reused
 * verbatim when the composition mounts `connection`; otherwise a structural
 * replica applies: loopback host only, no cross-site fetches, and an
 * `Origin`/`Referer` that matches the `Host` authority.
 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

function structuralRejection(req) {
  const host = authorityOf(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return 403
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403
  }
  return undefined
}

/**
 * Per-request decision: the composition's own admission when present, else the
 * structural replica. Resolved lazily because `connection` is published after
 * plugins load.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection
 * @returns {number|undefined} an HTTP status to reject with, or `undefined`
 */
function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req)
      if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection
      return undefined
    } catch {
      // A throwing connection service is a composition bug; fall through to
      // the structural fence rather than answering 500 for every request.
    }
  }
  return structuralRejection(req)
}

/**
 * The live egress engine. Owns the installed dispatcher, the environment
 * variables, and the status view the API serves.
 *
 * Activation is serialized through one queue (startup and API applies share
 * it) so two switches can never interleave their probe → install → env
 * sequences and leave the process with a half-applied selection.
 *
 * @param {{logger:{info?:(msg:string)=>void, warn?:(msg:string)=>void, debug?:(msg:string)=>void}, store:SettingsStore}} options
 */
export function createEngine({ logger, store }) {
  const inherited = captureProxyEnvironment()
  /** `undefined` until the loader settles, `null` when undici is unavailable. */
  let undici = undefined
  /** The dispatcher this generation installed; the pre-plugin global is restored on dispose. */
  let ownDispatcher = undefined
  /** Whatever was global before this engine ran, captured before the first activation. */
  let originalDispatcher = undefined
  let view = {
    mode: 'system',
    url: '',
    status: 'idle',
    error: '',
    systemProxy: null,
  }

  const loaded = loadUndici({ logger }).then((shape) => {
    undici = shape
    if (shape !== null && typeof shape.getGlobalDispatcher === 'function') {
      try {
        originalDispatcher = shape.getGlobalDispatcher()
      } catch {
        originalDispatcher = undefined
      }
    }
    return shape
  })

  let tail = Promise.resolve()
  /** Run `task` strictly after the previous exclusive task settles. */
  function exclusive(task) {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Refuse an activation. The view keeps reporting the CURRENT selection: a
   * failed attempt must not masquerade as the active one — the message says
   * "kept the current egress", so the view has to say it too.
   *
   * @param {string} message
   */
  function fail(message) {
    view = { ...view, status: 'error', error: message }
    logger.warn?.(`network-proxy: activation refused (${message})`)
    return view
  }

  /**
   * Install the selection — but only after the target endpoint proves
   * reachable and undici is available. Every refusal path leaves the current
   * dispatcher and environment exactly as they were.
   *
   * @param {{mode:string, url:string}} value - already validated
   * @returns {Promise<typeof view>}
   */
  async function activate(value) {
    let systemProxy = null
    if (value.mode === 'system') {
      try {
        systemProxy = systemProxyOptions(inherited, { logger })
      } catch (error) {
        return fail(`${error?.message ?? error} — kept the current egress`)
      }
    }

    // Guard 1: a dead endpoint must never replace a working egress.
    const target = probeTargetFor(value, systemProxy ?? {})
    if (target !== null) {
      const probe = await probeEndpoint(target)
      if (!probe.ok) {
        return fail(`proxy endpoint ${target} is unreachable (${probe.error ?? 'unknown error'}) — kept the current egress`)
      }
    }

    // Guard 4: degraded backend is inert, never half-applied.
    if (!undici) {
      return fail('undici could not be resolved — nothing was changed (host egress unchanged); check the plugin log for the resolution candidates')
    }

    let dispatcher
    try {
      dispatcher = dispatcherFor(undici, value, inherited, systemProxy)
    } catch (error) {
      return fail(`${error?.message ?? error} — kept the current egress`)
    }
    try {
      undici.setGlobalDispatcher(dispatcher)
    } catch (error) {
      return fail(`could not install the proxy dispatcher (${error?.message ?? error}) — kept the current egress`)
    }
    if (ownDispatcher !== undefined) {
      // Only the dispatcher this generation installed: the pre-plugin global
      // is retired on dispose, not here — and never closed while a later
      // generation may have replaced it already.
      try {
        void ownDispatcher.close().catch?.(() => {})
      } catch { /* already gone */ }
    }
    ownDispatcher = dispatcher
    let exported = false
    try {
      exported = applyEnvironment(value, inherited, systemProxy)
    } catch (error) {
      // The dispatcher is already in place; environment failure is surfaced
      // but not fatal.
      logger.warn?.(`network-proxy: environment update failed (${error?.message ?? error})`)
    }
    view = {
      mode: value.mode,
      url: value.mode === 'manual' ? value.url : '',
      status: 'active',
      error: '',
      systemProxy: value.mode === 'system' ? systemProxy : null,
    }
    const endpoint = value.mode === 'manual'
      ? value.url
      : (systemProxy?.httpsProxy ?? systemProxy?.httpProxy ?? '')
    logger.info?.(
      value.mode === 'system' && exported
        ? `network-proxy: system proxy discovered and exported (${endpoint})`
        : value.mode === 'manual'
          ? `network-proxy: manual proxy active (${value.url})`
          : value.mode === 'system'
            ? 'network-proxy: system egress active (no system proxy discovered; environment left as inherited)'
            : `network-proxy: ${value.mode} egress active`,
    )
    return view
  }

  /** Startup: resolve undici once, then apply the saved selection. */
  const startup = exclusive(async () => {
    await loaded
    return activate(store.get())
  })

  /**
   * Validate and apply one API selection.
   *
   * @param {{mode?:unknown, url?:unknown}} patch
   * @returns {Promise<{ok:true} & typeof view | {ok:false, error:string}>}
   */
  function apply(patch) {
    return exclusive(async () => {
      await loaded
      const current = store.get()
      let next = { ...current }
      if (patch.mode !== undefined) {
        if (typeof patch.mode !== 'string' || !MODES.has(patch.mode)) {
          return { ok: false, error: `unknown proxy mode "${String(patch.mode)}"` }
        }
        next.mode = patch.mode
      }
      if (patch.url !== undefined) next.url = typeof patch.url === 'string' ? patch.url.trim() : ''
      if (next.mode === 'manual') {
        let validated
        try {
          validated = validateProxyUrl(next.url)
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) }
        }
        next.url = validated
      } else {
        next.url = ''
      }
      if (next.mode === current.mode && next.url === current.url && view.status === 'active') {
        return { ok: true, ...view }
      }
      const applied = await activate(next)
      if (applied.status !== 'active') return { ok: false, error: applied.error }
      store.update(next)
      return { ok: true, ...view }
    })
  }

  function dispose() {
    // Return the process to its pre-plugin network state.
    try {
      restoreProxyEnvironment(inherited)
    } catch { /* env we never could write is not ours to restore */ }
    if (ownDispatcher !== undefined) {
      try {
        const current = undici && typeof undici.getGlobalDispatcher === 'function' ? undici.getGlobalDispatcher() : undefined
        if (current === ownDispatcher && originalDispatcher !== undefined) {
          undici.setGlobalDispatcher(originalDispatcher)
        }
      } catch { /* keep whatever is global; closing ours below is enough */ }
      try {
        void ownDispatcher.close().catch?.(() => {})
      } catch { /* already gone */ }
      ownDispatcher = undefined
    }
  }

  return {
    apply,
    dispose,
    /** Resolves once startup activation has settled (the API awaits this). */
    ready: () => startup,
    /** @returns {typeof view} a copy safe to serialize */
    view: () => ({ ...view }),
  }
}

/** Read the (small) JSON body of a POST. */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * The settings row's HTTP surface: one view route and one apply route.
 *
 * Both responses are flat (`{ok, mode, url, status, error, …}`) — the shape
 * the browser half reads directly.
 *
 * @param {{engine:ReturnType<typeof createEngine>, connection:object, logger:object}} options
 */
function createApiHandler({ engine, connection, logger }) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/network-proxy\/?/, '').replace(/\/+$/, '')
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    }
    const rejection = rejectionFor(req, connection)
    if (rejection !== undefined) {
      return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    }
    try {
      if (method === 'GET' && routePath === '') {
        await engine.ready()
        return send(200, { ok: true, ...engine.view() })
      }
      if (method === 'POST' && routePath === 'apply') {
        const body = await readJson(req)
        const result = await engine.apply({ mode: body?.mode, url: body?.url })
        return send(result.ok ? 200 : 400, result)
      }
      return send(404, { ok: false, error: 'not found' })
    } catch (error) {
      logger.warn?.(`network-proxy: api request failed (${error?.message ?? error})`)
      return send(500, { ok: false, error: 'internal error' })
    }
  }
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const store = new SettingsStore(path.join(resolveDshHome(), DATA_DIR_NAME, 'settings.json'))
  const engine = createEngine({ logger, store })

  // The egress applies on startup regardless of which surface this composition
  // serves — the settings UI only makes it reachable later. Activation runs
  // through the engine's own queue (undici resolution → probe → install), so
  // nothing here can block the plugin's registration.
  void engine.ready()

  // Resolved per request: `connection` is published after plugins load, so a
  // snapshot read at apply time would freeze the fence in "absent".
  const connection = {
    get admit() {
      const current = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      return current === undefined ? undefined : (req) => current.admit(req)
    },
  }

  // The dashboard half runs in its own fiber so a composition without an HTTP
  // server cannot take the egress down with it: the callback pends while
  // `webServer` is absent, and never blocks the lane above.
  ctx.inject(['webServer'], (scoped) => {
    const handler = createApiHandler({ engine, connection, logger })
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: '/api/network-proxy', handler }),
      'network-proxy: api routes',
    )
  })

  ctx.effect(() => () => {
    engine.dispose()
    store.dispose()
  }, 'network-proxy: teardown')
}
