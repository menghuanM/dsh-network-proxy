# Architecture

- `index.js` — server-side plugin: manages the global undici `Dispatcher`
  (ProxyAgent / EnvHttpProxyAgent) and injects proxy environment variables.
- `client.js` — web client: the settings UI and live state for the
  `network-proxy` namespace.
- `cordis.patch.yml` — declares the `network-proxy` loader entry that the
  Harness composes into its cordis tree.

Modes:
- `system` — read the OS proxy (Windows registry `Internet Settings`, else `HTTP(S)_PROXY`).
- `manual` — use a single `http(s)://` URL.
- `direct` — clear all proxy env vars.

## DSH Desktop compatibility

The client half reaches the settings document through the client `remote.settings`
service — declared together with `remote` in the plugin's `inject`, because
`ctx.remote.settings` is gated by the plugin's own declaration — and keeps a
local snapshot store for the UI. The server half intentionally leaves the
previous global dispatcher open when it swaps in a new one:
`@deepseek-ai/dsh-http-proxy` installs a boot-time policy dispatcher that
proxied `web fetch` routes keep referencing.

Version-specific details are recorded in [PATCHES.md](../PATCHES.md).
