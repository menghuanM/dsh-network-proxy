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

## v2.2.1：修复「点手动代理即报错并弹回」

症状：设置行点「手动代理」，没有出现地址输入口，而是立刻显示
`应用失败: Manual proxy requires a URL`，模式又跳回「跟随系统」。

根因（客户端交互缺陷，非服务端校验问题）：`choose(mode)` 对所有模式一律
`controller.save(mode)`。手动模式需要用户先填地址，此时 body 只是
`{"mode":"manual"}`，服务端的 `validateProxyUrl('')` 必然抛出
`Manual proxy requires a URL`，整个 `/apply` 返回 400 → 行进入 `error` 态
→ 服务端 view 仍报告 `system`，于是表现为「报错 + 弹回」。输入框本身
依赖 `state.mode === 'manual'`，模式被弹回后自然也不会出现。

修复：把「选模式」与「提交」拆开。

1. **`manual` 是暂存态**（新增 `stageManual()`）：点「手动代理」只切本地
   编辑态（`mode: 'manual'`、`pending: true`、记下 `appliedMode`），**不发
   任何请求**。这样输入框会出现，用户得以填写地址。
2. **只有填了地址才提交**：`save('manual', url)` 仍由「应用」触发；提交前
   `draft.trim() === ''` 直接 return，因此不会再产生无 url 的 POST。
3. **可放弃编辑**（新增「取消」按钮 + `stageCancel()`）：回到
   `appliedMode`（服务端真正生效的那个模式），不会卡在未提交的手动态。
4. **切到别的模式仍立即生效**：暂存态下点「直连/跟随系统」照常
   `save(mode)` 提交，不被 `state.mode === 'manual'` 挡住。
5. **状态文案**：暂存态显示「填写地址后点击「应用」生效」，而不是谎报
   「已生效」；`load()` 读到服务端权威状态时清空 `pending`。
6. **测试**：新增客户端交互模拟（stub fetch + stub react，复刻服务端校验
   规则），断言「点手动代理零请求」「带 url 的 POST 成功且无 error」
   「取消回到 appliedMode」「暂存态切直连能提交」。smoke 仍 38 项通过。



针对「跟随系统模式下子进程拿不到代理」的修复：

1. **导出发现的地址**（`src/parsers.js` 新增 `exportSystemProxyEnvironment`）：
   旧版 system 分支的 `applyEnvironment` 只做 `restoreProxyEnvironment(inherited)`
   ——把环境变量还原成启动时的样子，也就是「什么都不导出」。于是宿主进程内的
   undici 走了代理，而 Harness 派生的 git / pnpm / 包安装器全部直连，在被墙的
   主机上表现为「插件装不上、git 拉不动」。现在 system 模式把发现到的
   `httpProxy`/`httpsProxy` 写成 `HTTP_PROXY`/`HTTPS_PROXY`（大小写都写），
   `NO_PROXY` 一律以环回集合开头（`withLoopbackNoProxy`）再并上 `ProxyOverride`，
   并清空 `ALL_PROXY`（它会把未经校验的协议也一并劫持）。
2. **没发现 = 不动环境**：`exportSystemProxyEnvironment` 返回 `false` 时回退到
   `restoreProxyEnvironment(inherited)`。「系统没开代理」不能成为覆盖 Harness
   启动环境的理由。
3. **发现链而非单一读取器**（新增 `src/discover.js`）：旧版只 spawn `powershell.exe`
   一次，它一旦失败（被拦、超时、PATH 缺失）整个 system 模式直接 `fail()`，
   导出自然无从谈起。现在先 `reg.exe query`（无 PowerShell、无 COM、无 profile
   脚本），失败再退 PowerShell；两路都读不到才用继承环境兜底。读取失败才换
   下一个读取器——读成功后「解释」出的错误（PAC 在用、开了代理却没填服务器）
   是确定答案，不再重试。
4. **`spawnSync` 加超时**（`reg.exe` 5s / PowerShell 8s）：旧版没有超时，一个
   卡住的子进程会永久吊住插件激活队列。
5. **`NO_PROXY` 去重**（`src/parsers.js` 新增 `dedupeNoProxy`）：Windows 自带的
   `ProxyOverride` 本身就重复列出 `localhost`，与强制并入的环回集合叠加后
   `NO_PROXY` 里会出现重复项。对 undici 无害，但对用户可读、也被其它工具解析。
   现按大小写不敏感去重并保留首次出现位置，环回集合仍排在最前。
6. **测试**：smoke 从 28 项扩到 38 项，新增导出语义（大小写变量、https 跟随
   http、无发现时零改动、环回 bypass 恒在、去重）与发现层（`reg.exe` 输出解析、
   两条路径解释一致、关闭代理读作 null、PAC 与「无服务器」为确定错误）。



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

## v2.1.0：网络安全加固（防断网）

针对硬约束「注册插件不得导致 harness 断网」的逐条改动与验证方式
（验证全部为本机回环流量，不出网）：

1. **切换前 TCP 探测**（新增 `src/probe.js`）：system/manual 模式先探测代理端点；
   不可达 → 拒绝切换，dispatcher 与环境变量一字不动（消息注明
   `kept the current egress`）。覆盖「v2rayN 退出后注册表残留
   `ProxyEnable=1, ProxyServer=127.0.0.1:10808`」的死代理场景——v2.0.0 会把
   死端口装成全局 dispatcher 直接断网。
2. **回环永不走代理**（`src/parsers.js` 新增 `LOOPBACK_NO_PROXY` /
   `withLoopbackNoProxy`）：`localhost,127.0.0.1,[::1]` 强制并入每个 no-proxy。
   `[::1]` 必须带方括号：undici 的 `#parseNoProxy` 把 `a:123` 形状解析成
   host:port，裸 `::1` 会被拆成 host `:` + port 1 而失效。手动模式从
   `ProxyAgent` 换成 `EnvHttpProxyAgent`——前者没有 no-proxy 概念，会把
   `127.0.0.1` 上的内核本地流量也送进代理。
3. **undici 三级解析**（新增 `src/undici-loader.js`，替代 index.js 的静态
   `import 'undici'`）：已装依赖 → harness 运行时自带副本
   （`$DSH_HOME/dsh-runtimes/…` 与 `<execPath>/resources/runtime/…`，本机实测
   命中 pnpm 附带的 undici 6.26.0）→ `DSH_NETWORK_PROXY_UNDICI` 覆盖。全失败
   则拒绝一切切换（惰性降级），插件不再因裸依赖缺失整体
   `ERR_MODULE_NOT_FOUND`。形状校验要求 `Agent`/`EnvHttpProxyAgent`/
   `setGlobalDispatcher` 三者齐全，缺一换下一个候选。
4. **符号桥实测**：undici 6.26.0 的 `setGlobalDispatcher` 写
   `Symbol.for('undici.globalDispatcher.1')`；Node 24.21.0 内建 fetch 实测经该
   dispatcher 发请求（装死代理后 fetch 回 ECONNREFUSED 而非直连）。
5. **卸载恢复**：dispose 恢复插件安装前的全局 dispatcher（`getGlobalDispatcher`
   快照）与继承环境变量；v2.0.0 的 dispose 之后全局符号仍指向已 close 的
   dispatcher，进程内 fetch 会直接坏掉。
6. **失败语义修正**：`fail()` 不再把**尝试值**写入 view——失败时 view 如实呈现
   当前生效出口（与 `kept the current egress` 文案一致）。apply 响应改平铺
   `{ok, mode, url, status, error, …}`（浏览器半身 `save()` 直读顶层字段；
   旧版 `{ok, view}` 嵌套导致手动保存后 url 字段被读成空串）。浏览器半身
   `load()` 新增 status/error 映射，服务端拒绝不再伪装成「已生效」。
7. **激活串行化**：启动与 API 切换走同一条 Promise 队列，杜绝
   probe → install → env 交错产生的半应用状态。
8. **测试**：smoke 从 11 项扩到 28 项，新增引擎安全层（本机假代理 + 真实全局
   fetch：走代理 / 回环绕过 / 死端点拒绝且出口存活 / 非法 URL 先拒 / 卸载
   还原）。调查中确认 undici 6 `ProxyAgent` 默认 `proxyTunnel: true`，对 http
   目标也发 CONNECT——假代理需处理 `connect` 事件；真实代理（v2rayN mixed
   端口）原生支持 CONNECT，生产路径不受影响。
9. **冗余清理（v2.1.0 定稿）**：system 模式从每次切换读两遍注册表（`dispatcherFor`
   与 `activate` 各自同步 spawn 一次 PowerShell）改为只读一遍——探测用的解析结果
   直接透传给 `dispatcherFor`；删除只写不读的 `updatedAt`（index / client / README
   共 7 处）与从未渲染的 `manual.hint` 双语词条；删除前逐一 grep 核对
   `PROXY_ENV_NAMES` / `SETTINGS_INITIAL` / `DEFAULT_PROBE_TIMEOUT_MS` /
   `undiciCandidates` / 全部 CSS 类与其余词条，均有消费者，保留。
