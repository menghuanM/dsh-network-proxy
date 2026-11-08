/**
 * dsh-network-proxy — Windows system-proxy discovery.
 *
 * The engine's `system` mode must answer one question: *which proxy does the
 * OS advertise right now?* It must answer it without taking the harness
 * offline when the answer is unavailable, so discovery walks a chain instead
 * of trusting a single reader:
 *
 *   1. **`reg.exe query`** — the registry, read directly. No PowerShell, no
 *      COM, no profile script; it is a tiny console program that works
 *      everywhere the harness runs, including sandboxes that refuse to spawn
 *      an interpreter;
 *   2. **PowerShell** — the same `Internet Settings` values via
 *      `Get-ItemProperty`, kept as a fallback for environments where
 *      `reg.exe` is missing or blocked.
 *
 * Only when *both* readers fail is the platform's inherited proxy
 * environment used instead, and only when that is empty too does the caller
 * have to report an error. That ordering matters: each reader costs a
 * process, so the cheap and dependency-free one runs first, and a single
 * failing reader is no longer enough to make `system` mode inert.
 *
 * PAC (`AutoConfigURL`) is not supported — a proxy auto-configuration script
 * cannot be honored from a dispatcher — and is reported as a distinct error
 * so the settings row can tell the user to switch to manual mode.
 *
 * @module src/discover.js
 */

import { execFileSync } from 'node:child_process'

/** The registry key Windows stores its proxy configuration in. */
export const INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/**
 * Parse the output of `reg.exe query <key>` on the Internet Settings key.
 *
 * `reg.exe` prints one indented `    Name    TYPE    Data` line per value;
 * `(Default)` and values this module does not use are ignored.
 *
 * @param {string} stdout
 * @returns {{ProxyEnable?:string, ProxyServer?:string, ProxyOverride?:string, AutoConfigURL?:string}}
 */
export function parseRegQueryOutput(stdout) {
  const values = {}
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s]+/, '')
    if (line === '') continue
    const match = /^(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL)\s+(REG_SZ|REG_DWORD)\s+(.*)$/i.exec(line)
    if (match === null) continue
    const [, name, type, data] = match
    values[name] = type.toUpperCase() === 'REG_DWORD'
      // `reg.exe` prints DWORDs in hex: `0x1`, `0x0`.
      ? String(Number.parseInt(String(data).trim(), 16))
      : String(data)
  }
  return values
}

/**
 * Decode `reg.exe`'s console output to readable text.
 *
 * The values are plain ASCII in practice (proxy hosts and a bypass list), so
 * a UTF-8 decode is right; a mojibake result would still only cost the
 * bypass list, never the endpoint itself.
 *
 * @param {Buffer|string} raw
 * @returns {string}
 */
function decodeRegOutput(raw) {
  if (typeof raw === 'string') return raw
  return Buffer.from(raw).toString('utf8')
}

/**
 * The shared interpretation of raw Internet Settings values.
 *
 * Split out from the readers so both discovery paths answer identically.
 *
 * @param {{ProxyEnable?:string, ProxyServer?:string, ProxyOverride?:string, AutoConfigURL?:string}} raw
 * @param {(value:string)=>ReturnType<import('./parsers.js').parseWindowsProxyServer>} parseProxyServer
 * @returns {{httpProxy?:string, httpsProxy?:string, noProxy?:string}|null}
 *   `null` = Windows proxying is off; an exception carries the reason.
 */
export function interpretInternetSettings(raw, parseProxyServer) {
  const proxyEnable = Number.parseInt(String(raw?.ProxyEnable ?? '0').trim(), 10)
  const autoConfig = String(raw?.AutoConfigURL ?? '').trim()
  if (!Number.isFinite(proxyEnable) || proxyEnable === 0) {
    if (autoConfig !== '') {
      throw new Error('Windows PAC proxy is not supported; use Manual proxy instead')
    }
    return null
  }
  const proxies = parseProxyServer(String(raw?.ProxyServer ?? ''))
  if (!proxies.httpProxy && !proxies.httpsProxy) {
    throw new Error('Windows system proxy is enabled but no proxy server is configured')
  }
  return {
    ...proxies,
    noProxy: String(raw?.ProxyOverride ?? '')
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && entry !== '<local>')
      .join(','),
  }
}

/**
 * Discovery readers in order of preference. Each returns the raw Internet
 * Settings values, or throws when it cannot answer.
 *
 * @returns {Array<{source:string, read:() => object}>}
 */
export function windowsRegistryReaders() {
  return [
    {
      source: 'reg.exe',
      read: () => {
        const output = execFileSync('reg.exe', ['query', INTERNET_SETTINGS_KEY], {
          encoding: 'buffer',
          windowsHide: true,
          timeout: 5000,
        })
        const values = parseRegQueryOutput(decodeRegOutput(output))
        if (Object.keys(values).length === 0) {
          throw new Error('reg.exe returned no proxy values')
        }
        return values
      },
    },
    {
      source: 'powershell',
      read: () => {
        const script = [
          "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';",
          '[pscustomobject]@{',
          'ProxyEnable=[string][int]$p.ProxyEnable;',
          'ProxyServer=[string]$p.ProxyServer;',
          'ProxyOverride=[string]$p.ProxyOverride;',
          'AutoConfigURL=[string]$p.AutoConfigURL',
          '}|ConvertTo-Json -Compress',
        ].join('')
        const output = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { encoding: 'utf8', windowsHide: true, timeout: 8000 },
        )
        const parsed = JSON.parse(output)
        return {
          ProxyEnable: String(parsed?.ProxyEnable ?? '0'),
          ProxyServer: String(parsed?.ProxyServer ?? ''),
          ProxyOverride: String(parsed?.ProxyOverride ?? ''),
          AutoConfigURL: String(parsed?.AutoConfigURL ?? ''),
        }
      },
    },
  ]
}
