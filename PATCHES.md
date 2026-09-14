# dsh-network-proxy — DSH Desktop 2.0.10 兼容性补丁记录

上游：https://github.com/kriskite/dsh-network-proxy
锁定上游 commit：`4cc265a2115cffdcfbf4f74257243b12a98ac9e0`（2026-08-19, "docs: add FAQ"）
适配目标：DSH Desktop 2.0.10（`dsh-plugin-desktop`，`@deepseek-ai/dsh` / `@deepseek-ai/dsh-settings` 0.1.5-rc.2，`@deepseek-ai/schemastery` 3.18.2，undici：应用 8.10.0 / profile 7.29.1，Node 24.15.0）

## 为什么必须改

上游 peerDependencies 声明 `@deepseek-ai/dsh-settings 0.1.0-rc.7`，与本机 0.1.5-rc.2 存在版本差。
逐项核对后，服务端 API 全部兼容，客户端有 5 处不兼容（见下）。不改的后果：

- 客户端 `require('@deepseek-ai/dsh-client-runtime/client')` 在本构建的客户端模块图中**不存在**该模块，
  materialization 时会 loud throw → 设置页插件行无法渲染。
- `response.result.*` 响应封包、`mutate({ns,...})` 对象参数形式均为上游虚构的旧 API，
  在本构建下 describe/mutate 全部失败。
- 服务端关闭上一个 global dispatcher 会破坏本机 `@deepseek-ai/dsh-http-proxy` 的启动期策略
  （web-fetch 工具的 proxied 路由仍引用那个 dispatcher 对象）。

## 服务端 index.js

1. **不再关闭被替换的 global dispatcher**。Desktop 启动时 `dsh-http-proxy` 会按环境安装一次
   代理策略 dispatcher；`proxyRouteFor()` 持有该对象引用并交给 web-fetch 的 proxied 路由。
   插件切换模式时 `previous.close()` 会把这个仍在使用的 dispatcher 关掉。跳过 close，
   代价是每次切换泄漏一个 dispatcher（可忽略）。

## 客户端 client.js

2. **内联 `createSnapshotStore`**：本构建客户端模块图里没有 `@deepseek-ai/dsh-client-runtime`
   （已枚举全部 `dsh.client.platform=web` 包核实）。内联实现保持 clone-on-update 快照语义，
   与 `React.useSyncExternalStore` 配合。`package.json` 的 `dsh.client.inject` 同步移除该模块。
3. **响应封包**：`response.result.ok/value/error` → `response.ok/value/error`（typert remote
   client 直接解包，对齐 `dsh-client-ui-settings` 官方调用）。
4. **调用签名**：`settings.describe({})` → `settings.describe()`；
   `settings.mutate({ns, ops, expectedRevision})` → `settings.mutate(ns, ops, revision)`（位置参数）。
5. **事件**：`settings/document-updated` 在本构建无 payload，处理器改为无条件刷新（对齐官方 UI）。
6. **远程来源**：控制器改用 `ctx.remote` 服务（官方设置 UI 同款），不再经 `connection.api`。
9. **嵌套服务名 `remote.settings`（首装后实测补上的关键补丁）**：本构建客户端 cordis 的服务支持
   点分嵌套名，settings 的远程门面是一个名为 `remote.settings` 的**独立服务**：`ctx.remote.settings`
   只有在插件 inject 同时声明 `remote` 与 `remote.settings` 时才可访问（`dsh-client-ui-settings`
   导出的 inject 就是 `["remote", "remote.settings"]`）。上游只声明了 `remote`，首装后实际运行抛
   `cannot get property "remote.settings" without inject`。修复：插件导出的 inject 改为
   `['slots', 'locale', 'remote', 'remote.settings']`（并去掉已不再使用的 `connection`）；
   `package.json` 的模块图 `dsh.client.inject` 补上服务提供方 `@deepseek-ai/dsh-api-remotes`，
   去掉未使用的 `@deepseek-ai/dsh-client-connection`。

## package.json

7. `dsh.client.inject` 移除 `@deepseek-ai/dsh-client-runtime`（见 9 的最终形态：api-remotes /
   locale / ui-settings）。
8. peerDependencies 放宽为 `@deepseek-ai/dsh-settings >=0.1.0-rc.7`（覆盖 0.1.5-rc.2）、
   `@deepseek-ai/schemastery ^3.18.1`（3.18.2 满足）。`autoInstallPeers: false` 下 peer 不安装，
   运行时经 `$DSH_HOME/profiles/node_modules` 安装闭包回退链接解析，与 dsh-enter-customizer 先例一致。

## 核对过、无需修改的项

- 服务端：`settingsNamespace` / `settings.register(ns, schema, {applies:'live', validate})` /
  `scope.get()` / `scope.watch()` —— dsh-settings 0.1.5-rc.2 全部支持；
  `ctx.inject(['settings'], ...)` 模式与内置 dsh-client-ui-theme 完全一致。
- `z.const` / `z.union` / `.default` —— schemastery 3.18.2 支持。
- undici 符号桥：插件解析到 profile 内 undici 7.29.1，其 `setGlobalDispatcher` 同时写
  `undici.globalDispatcher.2` 与 legacy `.1`；Node 24 内建 fetch 读 `.1` → 生效。
  全部 @deepseek-ai 包中仅 dsh-http-proxy 与 dsh-web-fetch-http 导入 undici，且后者每次 fetch
  都显式传 dispatcher，不依赖全局 → 无 v1/v2 dispatcher 协议冲突。
- 客户端：`settings.general.item` 插槽存在于 dsh-client-ui-settings-general（语言设置行同插槽）；
  `slots.register({name,id,order,locale,inject}, Component)`、`locale.register/bind`、
  `slots.inject` 调用形状与 dshmarket / dsh-enter-customizer 两个已验证可用的插件完全一致。
