# Changelog

## 1.0.1 (2026-09-14)
- DSH Desktop 2.0.10 compatibility (targets `@deepseek-ai/dsh` 0.1.5-rc.2); see
  [PATCHES.md](./PATCHES.md) for the full list and rationale.
- Client: declare the nested `remote.settings` service alongside `remote` —
  `ctx.remote.settings` is gated by the plugin's own inject declaration, so
  declaring `remote` alone threw `cannot get property "remote.settings" without inject`.
- Client: read the settings remotes through `ctx.remote` with this build's
  envelope (`response.ok` / `response.value`) and positional `mutate(ns, ops, revision)`.
- Client: inline a `createSnapshotStore` equivalent (`@deepseek-ai/dsh-client-runtime`
  is not part of the client-module graph in this build).
- Client: refresh on `settings/document-updated` unconditionally (the event
  carries no payload on this build).
- Server: keep the replaced global dispatcher open — `@deepseek-ai/dsh-http-proxy`
  installs a boot-time policy dispatcher that proxied `web fetch` routes still
  reference, so closing it broke those requests.
- package.json: `dsh.client.inject` now lists `@deepseek-ai/dsh-api-remotes`
  (provider of the settings remotes), `@deepseek-ai/dsh-client-locale` and
  `@deepseek-ai/dsh-client-ui-settings`.
- Tests: `npm test` runs `smoke-test.mjs` (the previously referenced
  `index.test.js` is not in the repository); it skips instead of failing when
  the plugin's peers are absent from a bare checkout.

## 1.0.0 (2026-08-19)
- Initial release: network proxy management plugin for DeepSeek Harness.
- Three modes: system / manual / direct, applied live via settings UI.
- Windows system proxy parsing (ProxyServer / ProxyOverride).
- Bilingual (zh/en) settings UI.
