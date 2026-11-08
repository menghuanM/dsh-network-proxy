# Architecture

> 本 fork 自 v2.0.0 起面向 DSH 0.2.x 内核重写，与上游 v1.0.1 的实现不同。
> 上游该文件描述的 `remote.settings` services 形态已不再适用。

- `index.js` — Host 半身：解析出站模式、安装 undici 全局 dispatcher、
  导出代理环境变量、挂载 `/api/network-proxy` 路由、提供引擎与 API。
- `client.js` — 浏览器半身：`settings.general.item` 里的一行设置 UI
  （三模式切换 + 手动地址编辑 + 状态行），经自有 `/api/network-proxy` 取写。
- `cordis.patch.yml` — 声明 `network-proxy` loader 行，挂载 Host 半身。
- `src/` — 无内核依赖的纯逻辑：
  - `discover.js` — Windows 系统代理发现（`reg.exe query` → PowerShell 链）
  - `probe.js` — 代理端点 TCP 可达性探测（切换前置守卫）
  - `parsers.js` — URL 归一化/校验、Windows `ProxyServer` 解析、
    环境变量读写、环回 no-proxy 合并与去重
  - `store.js` — `~/.dsh/network-proxy/settings.json` 读写（temp + rename）
  - `undici-loader.js` — undici 三级解析与形状校验

## 模式

- `system` — 读取系统代理（Windows 注册表 `Internet Settings`，先 `reg.exe`
  再 PowerShell；其他平台读继承的 `HTTP(S)_PROXY`），并**导出**为环境变量。
- `manual` — 使用用户填写的单个 `http(s)://` URL。
- `direct` — 清除全部受管代理环境变量。

## 为什么不再依赖内核 settings 服务

旧内核的 `settings.register` / `remote.settings` 在 0.2.x 线里形态变更过，
而插件排版又必须适配不同构建。本 fork 改为自包含形态：

- 选择持久化在插件自有的 `~/.dsh/network-proxy/settings.json`；
- 浏览器半身经同源 `/api/network-proxy` 读写，该路由挂在 `webServer`
  的嵌套 fiber 上——没有 HTTP 服务器的组合仍能拿到代理，只是没有面板；
- 不把插件选择塞进内核 settings 文档，避免与内核线变更多次耦合。

## 网络安全模型

注册本插件不得导致 harness 失去网络，四道守卫：

1. **切换前探测** — system/manual 先做 TCP 探测；
2. **失败即不变** — 探测/配置失败不动 dispatcher 与环境变量；
3. **回环永不代理** — `localhost` / `127.0.0.1` / `[::1]` 强制并入 no-proxy；
4. **降级即惰性** — undici 解析失败时拒绝一切切换并说明原因。

卸载/停用恢复插件安装前的全局 dispatcher 与继承环境。

版本细节见 [PATCHES.md](../PATCHES.md)。
