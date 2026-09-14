// Offline smoke test for the DSH Desktop 2.0.10 compatibility build of
// dsh-network-proxy. Run: npm test
//
// The plugin's peers (@deepseek-ai/schemastery, @deepseek-ai/dsh-settings) and
// undici resolve from the surrounding installation when the plugin runs inside
// a DSH profile. In a bare checkout (CI) they may be absent, so a missing
// dependency reports SKIP instead of failing the suite; with the dependencies
// present every check below runs for real.
import assert from 'node:assert/strict'

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

let mod
let getGlobalDispatcher
let setGlobalDispatcher
try {
  mod = await import('./index.js')
  const undici = await import('undici')
  getGlobalDispatcher = undici.getGlobalDispatcher
  setGlobalDispatcher = undici.setGlobalDispatcher
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('SKIP - a dependency of the plugin is not installed in this checkout.')
    console.log(`       ${String(error.message).split('\n')[0]}`)
    console.log('       Run `npm install` (or test inside a DSH profile) to execute the full suite.')
    process.exit(0)
  }
  throw error
}

check('module exports the expected surface', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.parseWindowsProxyServer, 'function')
  assert.equal(typeof mod.readWindowsSystemProxy, 'function')
  assert.equal(typeof mod.validateSettings, 'function')
})

check('parseWindowsProxyServer: single host applies to both schemes', () => {
  assert.deepEqual(mod.parseWindowsProxyServer('proxy.lan:8080'), {
    httpProxy: 'http://proxy.lan:8080',
    httpsProxy: 'http://proxy.lan:8080',
  })
})

check('parseWindowsProxyServer: per-protocol entries', () => {
  assert.deepEqual(mod.parseWindowsProxyServer('http=10.0.0.2:8080;https=10.0.0.3:8443'), {
    httpProxy: 'http://10.0.0.2:8080',
    httpsProxy: 'http://10.0.0.3:8443',
  })
})

check('parseWindowsProxyServer: explicit schemes are preserved', () => {
  assert.deepEqual(mod.parseWindowsProxyServer('https://secure.lan:8443'), {
    httpProxy: 'https://secure.lan:8443',
    httpsProxy: 'https://secure.lan:8443',
  })
})

check('parseWindowsProxyServer: empty input', () => {
  assert.deepEqual(mod.parseWindowsProxyServer(''), {})
  assert.deepEqual(mod.parseWindowsProxyServer(undefined), {})
})

check('validateSettings: manual mode rejects non-http(s) URLs', () => {
  assert.throws(() => mod.validateSettings({ mode: 'manual', url: 'socks5://127.0.0.1:1080' }), /HTTP/)
  assert.throws(() => mod.validateSettings({ mode: 'manual', url: 'not a url' }), /HTTP/)
})

check('validateSettings: manual mode accepts http/https, system/direct pass', () => {
  mod.validateSettings({ mode: 'manual', url: 'http://127.0.0.1:7890' })
  mod.validateSettings({ mode: 'manual', url: 'https://proxy.lan:8443' })
  mod.validateSettings({ mode: 'system', url: '' })
  mod.validateSettings({ mode: 'direct', url: '' })
})

check('apply() registers the network-proxy namespace with live applies + validate hook', () => {
  let registered
  const effects = []
  const scope = {
    get: () => ({ mode: 'direct', url: '' }),
    watch: (fn) => {
      scope.watcher = fn
      return () => {}
    },
  }
  const settingsCtx = {
    settings: {
      register: (ns, schema, options) => {
        registered = { ns, schema, options }
        return scope
      },
    },
    effect: (fn, name) => effects.push({ fn, name }),
  }
  mod.apply({ inject: (names, fn) => { assert.deepEqual(names, ['settings']); fn(settingsCtx) } })
  assert.ok(registered, 'settings.register was called')
  assert.equal(String(registered.ns), 'network-proxy')
  assert.equal(registered.options.applies, 'live')
  assert.equal(typeof registered.options.validate, 'function')
  assert.equal(effects.length, 1)
  assert.equal(effects[0].name, 'network-proxy: live settings')
  // The initial activate() ran with mode "direct" from scope.get().
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    assert.equal(process.env[name], undefined, `${name} must be cleared in direct mode`)
  }
})

check('live settings watch drives dispatcher activation (global dispatcher flips)', () => {
  const original = getGlobalDispatcher()
  let watcher
  const scope = {
    get: () => ({ mode: 'system', url: '' }),
    watch: (fn) => { watcher = fn; return () => {} },
  }
  const settingsCtx = {
    settings: { register: () => scope },
    // cordis effect() runs the callback at registration time.
    effect: (fn) => fn(),
  }
  mod.apply({ inject: (_names, fn) => fn(settingsCtx) })
  try {
    assert.ok(watcher, 'scope.watch was wired')
    watcher({ mode: 'manual', url: 'http://127.0.0.1:7890' })
    const after = getGlobalDispatcher()
    assert.notEqual(after, original, 'global dispatcher must be replaced by the plugin')
    // The dispatcher must still be usable as a dispatcher (dispatch contract).
    assert.equal(typeof after.dispatch, 'function')
  } finally {
    setGlobalDispatcher(original)
  }
})

if (process.platform === 'win32') {
  check('readWindowsSystemProxy: real registry read succeeds on this machine', () => {
    // Must not throw: ProxyEnable on/off both return a config object.
    const config = mod.readWindowsSystemProxy()
    assert.equal(typeof config, 'object')
    if (config.httpProxy || config.httpsProxy) {
      assert.match(String(config.httpProxy ?? config.httpsProxy), /^[a-z][a-z\d+.-]*:\/\//i)
    }
  })
}

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - ${name}`)
    console.error(error?.stack ?? error)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
if (failed > 0) process.exit(1)
