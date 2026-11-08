# Changelog

本仓库是 [kriskite/dsh-network-proxy](https://github.com/kriskite/dsh-network-proxy)
的 fork。v2.x 面向 DSH 0.2.x 内核重写，架构与上游 v1.0.1 不同，逐条差异见
[PATCHES.md](./PATCHES.md)。

## 2.2.1 (2026-11-08)

- **客户端：修复「点手动代理即报错并弹回」**。`choose(mode)` 曾对手动模式
  立即 `save()`，此时 body 只有 `{"mode":"manual"}`，服务端
  `validateProxyUrl('')` 必然拒绝 → 行进入 error 态并回到上一模式，地址
  输入框从不出现。现改为「选模式」与「提交」分离：`manual` 只进入暂存编辑
  态（`stageManual()`，不发请求），填入地址后点「应用」才提交；新增「取消」
  按钮回到 `appliedMode`；暂存态下切其它模式仍立即生效。
- 测试：新增客户端交互模拟，断言「点手动代理零请求」「带 url 的 POST 成功」
  「取消回到 appliedMode」「暂存态切直连能提交」。

## 2.2.0 (2026-11-08)

- **跟随系统 = 发现 + 导出**。旧版 system 模式只装 undici dispatcher，环境
  变量走 `restoreProxyEnvironment(inherited)`（等于不导出），于是宿主走代理
  而 git / pnpm / 包安装器全部直连，在被墙主机上表现为「插件装不上」。
  现把发现到的地址写成 `HTTP_PROXY` / `HTTPS_PROXY`，`NO_PROXY` 一律以环回
  集合开头并并上 `ProxyOverride`，同时清空 `ALL_PROXY`。
- **没发现 = 不动环境**：系统未开代理时不覆盖启动时继承的环境变量。
- **发现链而非单一读取器**（新增 `src/discover.js`）：先 `reg.exe query`，
  失败再退 PowerShell，两路都不可用才用继承环境兜底；`spawnSync` 加超时
  （`reg.exe` 5s / PowerShell 8s）。
- **`NO_PROXY` 去重**（`dedupeNoProxy`）：Windows 的 `ProxyOverride` 常重复
  列出 `localhost`，与环回集合叠加后会产生重复项。
- 测试：28 → 38 项。

## 2.1.0

- **网络安全加固**：切换前 TCP 探测；失败即不变；回环永不走代理；undici
  三级解析失败则惰性降级；卸载恢复原 dispatcher 与环境变量。
- 激活串行化，杜绝 probe → install → env 交错产生的半应用状态。
- 测试：11 → 28 项。

## 2.0.0

- 面向 DSH 0.2.0-rc.2 内核重写：不再依赖旧内核的
  `settings.register` / `remote.settings`，改为「自有设置文件 + 自有
  `/api/network-proxy` 路由 + 设置行 UI」的自包含形态。

## 1.0.1 (2026-09-14, upstream)

- DSH Desktop 2.0.10 compatibility (targets `@deepseek-ai/dsh` 0.1.5-rc.2);
  see [PATCHES.md](./PATCHES.md) for the full list and rationale.
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

## 1.0.0 (2026-08-19, upstream)

- Initial release: network proxy management plugin for DeepSeek Harness.
- Three modes: system / manual / direct, applied live via settings UI.
- Windows system proxy parsing (ProxyServer / ProxyOverride).
- Bilingual (zh/en) settings UI.
