/**
 * dsh-network-proxy — proxy endpoint reachability probe.
 *
 * The egress switch must never replace a working connection with a dead one:
 * a stale system proxy left behind by an exited client (v2rayN, Clash, …) or a
 * saved manual endpoint whose process is no longer running would otherwise be
 * installed as the global dispatcher and take the whole harness offline.
 *
 * The probe is a plain TCP connect to the proxy endpoint — refused/reset is
 * instant, a black hole fails after `timeoutMs`. It never opens an outbound
 * connection to any third party, so probing is safe even when the network is
 * otherwise untrusted.
 *
 * @module src/probe.js
 */

import net from 'node:net'

/** Connect timeout; loopback refuses instantly, so this only bounds black holes. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1200

/**
 * Split a proxy endpoint string into `{host, port}` for `net.connect`.
 *
 * Accepts what the rest of the plugin already normalises: a full `http(s)://`
 * URL or a bare `host:port`. IPv6 literals arrive bracketed from WHATWG URL
 * and are unbracketed here because `net` wants the bare form.
 *
 * @param {string|undefined} value
 * @returns {{host:string, port:number}|null} `null` when no endpoint can be derived
 */
export function endpointOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `http://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (host === '') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

/**
 * Can a TCP connection be established to this proxy endpoint?
 *
 * Resolves (never rejects) so callers can treat "unknown" as "unreachable".
 *
 * @param {string} value - proxy endpoint, URL or bare `host:port`
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
export function probeEndpoint(value, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const endpoint = endpointOf(value)
  if (endpoint === null) return Promise.resolve({ ok: false, error: 'invalid proxy endpoint' })
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok, error) => {
      if (settled) return
      settled = true
      resolve(error === undefined ? { ok } : { ok, error })
    }
    let socket
    try {
      socket = net.createConnection({ host: endpoint.host, port: endpoint.port })
    } catch (error) {
      finish(false, error?.message ?? String(error))
      return
    }
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      finish(false, `timeout after ${timeoutMs}ms`)
    })
    socket.once('connect', () => {
      socket.destroy()
      finish(true)
    })
    socket.once('error', (error) => {
      socket.destroy()
      finish(false, error?.code ?? error?.message ?? String(error))
    })
  })
}
