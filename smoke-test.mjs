/**
 * dsh-network-proxy smoke test.
 *
 * Two layers, both fully offline (loopback only, no external network, no
 * package install):
 *
 * 1. the pure helper layer (URL normalisation, Windows registry string
 *    parsing, validation, environment management, loopback no-proxy union,
 *    endpoint parsing, TCP probe) — runs on a bare checkout;
 * 2. the engine safety layer — exercises the real global-dispatcher switch
 *    against a local fake proxy with Node's own `fetch`: requests must flow
 *    through a live proxy, must bypass it for loopback, a dead endpoint must
 *    be refused with the previous egress surviving untouched, and dispose
 *    must put the pre-plugin dispatcher back. Skipped (with a printed note)
 *    when no undici copy is resolvable on the machine, which is itself a
 *    supported configuration the engine reports as inert.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  clearProxyEnvironment,
  captureProxyEnvironment,
  exportSystemProxyEnvironment,
  normalizeProxyUrl,
  parseWindowsProxyServer,
  restoreProxyEnvironment,
  setManualProxyEnvironment,
  validateProxyUrl,
  withLoopbackNoProxy,
  LOOPBACK_NO_PROXY,
} from './src/parsers.js'
import { endpointOf, probeEndpoint } from './src/probe.js'
import { interpretInternetSettings, parseRegQueryOutput } from './src/discover.js'
import { loadUndici } from './src/undici-loader.js'
import { SettingsStore } from './src/store.js'
import { createEngine } from './index.js'

let passed = 0
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok - ${label}`)
  } catch (error) {
    console.error(`  FAIL - ${label}`)
    console.error(`    ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok - ${label}`)
  } catch (error) {
    console.error(`  FAIL - ${label}`)
    console.error(`    ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
function throws(fn, pattern) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== undefined, 'expected an error')
  if (pattern !== undefined) assert.match(String(caught.message), pattern)
}

console.log('normalizeProxyUrl:')
check('adds http:// to a bare host:port', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
})
check('keeps an explicit scheme untouched', () => {
  assert.equal(normalizeProxyUrl('https://proxy.example:8080'), 'https://proxy.example:8080')
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
})
check('trims and rejects empty input', () => {
  assert.equal(normalizeProxyUrl('  10.0.0.2:3128  '), 'http://10.0.0.2:3128')
  assert.equal(normalizeProxyUrl('   '), undefined)
  assert.equal(normalizeProxyUrl(undefined), undefined)
})

console.log('parseWindowsProxyServer:')
check('parses the bare form', () => {
  assert.deepEqual(parseWindowsProxyServer('127.0.0.1:7890'), {
    httpProxy: 'http://127.0.0.1:7890',
    httpsProxy: 'http://127.0.0.1:7890',
  })
})
check('parses the http=/https= multi-protocol form', () => {
  assert.deepEqual(parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891'), {
    httpProxy: 'http://127.0.0.1:7890',
    httpsProxy: 'http://127.0.0.1:7891',
  })
})
check('ignores socks= entries, falls back to http= for https', () => {
  assert.deepEqual(parseWindowsProxyServer('socks=127.0.0.1:1080;http=127.0.0.1:7890'), {
    httpProxy: 'http://127.0.0.1:7890',
    httpsProxy: 'http://127.0.0.1:7890',
  })
})
check('answers an empty object for empty input', () => {
  assert.deepEqual(parseWindowsProxyServer(''), {})
  assert.deepEqual(parseWindowsProxyServer(undefined), {})
})

console.log('validateProxyUrl:')
check('accepts http and https endpoints', () => {
  assert.equal(validateProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(validateProxyUrl('  10.0.0.2:3128 '), 'http://10.0.0.2:3128')
})
check('rejects empty, malformed, and non-http(s) values', () => {
  throws(() => validateProxyUrl(''), /requires a URL/)
  throws(() => validateProxyUrl('socks5://127.0.0.1:1080'), /only http:\/\/ and https:\/\//)
  throws(() => validateProxyUrl('not a url at all'), /valid URL/)
})

console.log('environment management:')
check('restore puts the inherited shape back exactly', () => {
  const env = { HTTP_PROXY: 'http://a:1', http_proxy: 'http://a:1', NO_PROXY: 'local' }
  const inherited = captureProxyEnvironment(env)
  setManualProxyEnvironment('http://b:2', inherited, env)
  assert.equal(env.HTTP_PROXY, 'http://b:2')
  assert.equal(env.https_proxy, 'http://b:2')
  assert.equal(env.NO_PROXY, 'local')
  assert.equal(env.ALL_PROXY, undefined)
  restoreProxyEnvironment(inherited, env)
  assert.equal(env.HTTP_PROXY, 'http://a:1')
  assert.equal(env.ALL_PROXY, undefined)
})
check('manual mode keeps an inherited NO_PROXY, direct mode clears everything', () => {
  const env = {}
  const inherited = captureProxyEnvironment({ NO_PROXY: 'corp.example' })
  setManualProxyEnvironment('http://b:2', inherited, env)
  assert.equal(env.no_proxy, 'corp.example')
  clearProxyEnvironment(env)
  for (const key of Object.keys(env)) assert.equal(env[key], undefined, `expected ${key} cleared`)
})

console.log('loopback no-proxy union:')
check('always leads with the loopback set', () => {
  assert.equal(withLoopbackNoProxy(undefined), LOOPBACK_NO_PROXY)
  assert.equal(withLoopbackNoProxy(''), LOOPBACK_NO_PROXY)
})
check('unions an inherited list without touching it', () => {
  assert.equal(withLoopbackNoProxy('corp.example, .internal'), `${LOOPBACK_NO_PROXY},corp.example,.internal`)
})
check('drops case-insensitive duplicates, keeping the first occurrence', () => {
  assert.equal(withLoopbackNoProxy('localhost,127.*,10.*'), `${LOOPBACK_NO_PROXY},127.*,10.*`)
  assert.equal(LOOPBACK_NO_PROXY.split(',').length, 3)
})
check('keeps IPv6 bracketed (bare ::1 would be parsed as host:port)', () => {
  assert.match(LOOPBACK_NO_PROXY, /\[::1\]/)
  assert.doesNotMatch(LOOPBACK_NO_PROXY, /(^|,):1(,|$)/)
})

console.log('system proxy export (the discovery → environment step):')
check('exports the discovered endpoint to the child-process variables', () => {
  const env = {}
  const exported = exportSystemProxyEnvironment({ httpProxy: 'http://127.0.0.1:10808', httpsProxy: 'http://127.0.0.1:10808', noProxy: 'corp.example' }, env)
  assert.equal(exported, true)
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:10808')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:10808')
  assert.equal(env.http_proxy, 'http://127.0.0.1:10808')
  assert.equal(env.https_proxy, 'http://127.0.0.1:10808')
  assert.equal(env.NO_PROXY, `${LOOPBACK_NO_PROXY},corp.example`)
  assert.equal(env.ALL_PROXY, undefined, 'ALL_PROXY must stay clear')
})
check('normalises a bare host:port and mirrors https from http', () => {
  const env = {}
  exportSystemProxyEnvironment({ httpProxy: '127.0.0.1:7890' }, env)
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890', 'https follows http when only http is advertised')
})
check('exports nothing when the OS advertised no proxy', () => {
  const env = {}
  assert.equal(exportSystemProxyEnvironment(null, env), false)
  assert.equal(exportSystemProxyEnvironment({}, env), false)
  assert.deepEqual(env, {}, 'no discovered endpoint must not touch the environment')
})
check('keeps loopback bypass even with no OS override list', () => {
  const env = {}
  exportSystemProxyEnvironment({ httpsProxy: 'http://127.0.0.1:10808' }, env)
  assert.equal(env.NO_PROXY, LOOPBACK_NO_PROXY)
  assert.equal(env.no_proxy, LOOPBACK_NO_PROXY)
})

console.log('registry discovery (reg.exe → PowerShell chain):')
check('parses a reg.exe query listing', () => {
  const sample = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    ProxyEnable    REG_DWORD    0x1',
    '    ProxyServer    REG_SZ    127.0.0.1:10808',
    '    ProxyOverride    REG_SZ    <local>;localhost;127.*',
    '    AutoConfigURL    REG_SZ    ',
    '',
  ].join('\r\n')
  assert.deepEqual(parseRegQueryOutput(sample), {
    ProxyEnable: '1',
    ProxyServer: '127.0.0.1:10808',
    ProxyOverride: '<local>;localhost;127.*',
    AutoConfigURL: '',
  })
})
check('a complete read is interpreted the same on both discovery paths', () => {
  const values = { ProxyEnable: '1', ProxyServer: '127.0.0.1:10808', ProxyOverride: '<local>;localhost;127.*' }
  assert.deepEqual(interpretInternetSettings(values, parseWindowsProxyServer), {
    httpProxy: 'http://127.0.0.1:10808',
    httpsProxy: 'http://127.0.0.1:10808',
    noProxy: 'localhost,127.*',
  })
})
check('proxying switched off reads as "no proxy" (not an error)', () => {
  assert.equal(interpretInternetSettings({ ProxyEnable: '0' }, parseWindowsProxyServer), null)
})
check('PAC in use is a definitive error, not a reader failure', () => {
  throws(() => interpretInternetSettings({ ProxyEnable: '0', AutoConfigURL: 'http://pac/x.pac' }, parseWindowsProxyServer), /PAC proxy is not supported/)
})
check('proxy enabled with no server is a definitive error', () => {
  throws(() => interpretInternetSettings({ ProxyEnable: '1', ProxyServer: '' }, parseWindowsProxyServer), /no proxy server is configured/)
})

console.log('endpoint parsing:')
check('splits host and port from a full URL', () => {
  assert.deepEqual(endpointOf('http://127.0.0.1:10808'), { host: '127.0.0.1', port: 10808 })
})
check('defaults ports and unbrackets IPv6', () => {
  assert.deepEqual(endpointOf('http://proxy.example'), { host: 'proxy.example', port: 80 })
  assert.deepEqual(endpointOf('https://proxy.example'), { host: 'proxy.example', port: 443 })
  assert.deepEqual(endpointOf('http://[::1]:10808'), { host: '::1', port: 10808 })
})
check('rejects junk', () => {
  assert.equal(endpointOf(''), null)
  assert.equal(endpointOf(undefined), null)
  assert.equal(endpointOf('ftp://x:1'), null)
  assert.equal(endpointOf('http://'), null)
})

await (async () => {
  // --- probe: loopback only -------------------------------------------
  // One server, two roles: undici's ProxyAgent tunnels by default
  // (proxyTunnel: true), so the proxy path arrives as an HTTP CONNECT
  // ('connect' event) even for plain http: targets; origin-form GETs
  // ('request' event) are the direct loopback path.
  const live = http.createServer((req, res) => {
    res.end('direct-body')
  })
  live.on('connect', (req, socket, head) => {
    const answer = (buffer) => {
      if (!buffer.includes('\r\n\r\n')) return false
      const body = 'via-proxy'
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      return true
    }
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let pending = Buffer.isBuffer(head) ? head : Buffer.alloc(0)
    if (answer(pending)) return
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk])
      if (answer(pending)) socket.removeListener('data', onData)
    }
    socket.on('data', onData)
  })
  await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve))
  const livePort = live.address().port

  const closed = net.createServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const closedPort = closed.address().port
  await new Promise((resolve) => closed.close(resolve))

  console.log('probe (loopback only):')
  await checkAsync('accepts an open endpoint', async () => {
    assert.deepEqual(await probeEndpoint(`http://127.0.0.1:${livePort}`), { ok: true })
  })
  await checkAsync('refuses a closed endpoint', async () => {
    const result = await probeEndpoint(`http://127.0.0.1:${closedPort}`)
    assert.equal(result.ok, false)
    assert.ok(typeof result.error === 'string' && result.error !== '')
  })
  await checkAsync('refuses an invalid endpoint without dialing', async () => {
    assert.equal((await probeEndpoint('socks5://x:1')).ok, false)
  })

  // --- engine safety layer --------------------------------------------
  console.log('engine safety (needs a resolvable undici):')
  const shape = await loadUndici()
  if (shape === null) {
    console.log('  note - no undici resolvable on this machine; engine layer skipped (the engine reports this state as inert)')
    return
  }
  console.log(`  info - undici source: ${shape.source}`)
  const before = typeof shape.getGlobalDispatcher === 'function' ? shape.getGlobalDispatcher() : undefined
  assert.ok(before !== undefined, 'getGlobalDispatcher must be exported to assert restoration')

  const file = path.join(os.tmpdir(), `dsh-network-proxy-smoke-${process.pid}.json`)
  fs.writeFileSync(file, JSON.stringify({ mode: 'direct', url: '' }))
  const store = new SettingsStore(file)
  // Captured before the engine exists: `createEngine` snapshots the
  // environment it inherits, and dispose must put exactly that back.
  const inheritedProxyEnv = captureProxyEnvironment()
  const engine = createEngine({ logger: { info() {}, warn() {}, debug() {} }, store })

  await checkAsync('startup activates the saved selection (direct)', async () => {
    await engine.ready()
    const view = engine.view()
    assert.equal(view.status, 'active')
    assert.equal(view.mode, 'direct')
  })

  const proxyUrl = `http://127.0.0.1:${livePort}`
  await checkAsync('manual proxy over a live endpoint applies', async () => {
    const result = await engine.apply({ mode: 'manual', url: proxyUrl })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(engine.view().status, 'active')
    assert.equal(engine.view().url, proxyUrl)
  })

  await checkAsync('host requests now flow through the proxy (global dispatcher honored)', async () => {
    // `.invalid` is never resolved by the client: the fake proxy answers the
    // absolute-form request, so this stays fully offline.
    const response = await fetch('http://through-proxy.invalid/')
    assert.equal(await response.text(), 'via-proxy')
  })

  await checkAsync('loopback traffic bypasses the proxy', async () => {
    const response = await fetch(`http://127.0.0.1:${livePort}/`)
    assert.equal(await response.text(), 'direct-body')
  })

  await checkAsync('a dead endpoint is refused and the working egress survives', async () => {
    const result = await engine.apply({ mode: 'manual', url: `http://127.0.0.1:${closedPort}` })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /unreachable/)
    // The previous selection is intact: dispatcher, persisted state, env.
    const response = await fetch('http://still-through-proxy.invalid/')
    assert.equal(await response.text(), 'via-proxy')
    assert.equal(engine.view().url, proxyUrl)
    assert.equal(process.env.HTTP_PROXY, proxyUrl)
    assert.equal(store.get().url, proxyUrl)
  })

  await checkAsync('an invalid URL is rejected before any probing', async () => {
    const result = await engine.apply({ mode: 'manual', url: 'socks5://x:1' })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /only http:\/\/ and https:\/\//)
  })

  await checkAsync('re-selecting the already-active mode is a no-op', async () => {
    const result = await engine.apply({ mode: 'manual', url: proxyUrl })
    assert.equal(result.ok, true)
    assert.equal(engine.view().status, 'active')
  })

  await checkAsync('dispose restores the pre-plugin dispatcher and environment', async () => {
    engine.dispose()
    if (typeof shape.getGlobalDispatcher !== 'function') return
    assert.equal(shape.getGlobalDispatcher(), before, 'global dispatcher must be the pre-plugin one')
    // Restore means "back to what this process inherited", not "back to
    // empty": the harness now exports the discovered system proxy, so a
    // smoke run launched from it inherits a real value.
    assert.equal(process.env.HTTP_PROXY, inheritedProxyEnv.HTTP_PROXY, 'proxy env must be back to the inherited shape')
    assert.equal(process.env.HTTPS_PROXY, inheritedProxyEnv.HTTPS_PROXY, 'https env must be back to the inherited shape')
  })

  store.dispose()
  fs.rmSync(file, { force: true })
  // Fire-and-forget teardown: a lingering half-closed tunnel socket can
  // stall `server.close()`'s callback indefinitely, and by this point every
  // assertion has already run.
  try {
    live.closeAllConnections?.()
  } catch { /* nothing to close */ }
  live.close()
})()

console.log(process.exitCode === 1 ? 'smoke test FAILED' : `smoke test passed (${passed} checks)`)
process.exit(process.exitCode ?? 0)
