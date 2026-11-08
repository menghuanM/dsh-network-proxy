# @menghuanm/dsh-network-proxy

DeepSeek Harness（DSH）的网络代理插件。在「设置 → 通用」里提供一行「网络代理」，
可随时切换 **跟随系统 / 手动代理 / 直连** 三种出站模式，修改后立即生效，无需重启。

> A proxy plugin for DeepSeek Harness: one settings row to switch between
> **follow system / manual proxy / direct** egress, applied live without a restart.

> **这是 [kriskite/dsh-network-proxy](https://github.com/kriskite/dsh-network-proxy)
> 的 fork。** 上游 v1.0.1 面向 DSH 0.1.5-rc.2；本 fork 从 v2.0.0 起针对
> DSH 0.2.x 内核重写，依赖接口与文件结构均已不同（上游 `index.js` 单文件 →
> 本 fork `src/` 五模块）。**请勿把本 fork 的版本当作上游的兼容更新**，
> 也不要在同一 profile 里同时安装上游包，两者会注册同一 loader 行
> `network-proxy` 而报 `duplicate loader entry id`。逐条差异见
> [PATCHES.md](./PATCHES.md)，版本历史见 [CHANGELOG.md](./CHANGELOG.md)。
>
> 原项目版权归 Kirskite 所有，依 MIT 许可再分发；见 [LICENSE](./LICENSE)。

## 安装（本 fork）

```bash
# profile 目录内（$DSH_HOME/profiles/<name>）
pnpm add github:menghuanM/dsh-network-proxy
```

然后在该 profile 的 `package.json` 的 `dsh.profile.bundles` 里加入
`@menghuanm/dsh-network-proxy`，重启或启停插件以生效。

> 注意：`dsh.profile.bundles` 里这一行必须写成**完整包名**（scoped 名），
> 而 `cordis.patch.yml` 里的 `name` 也必须是同一完整包名——两者不一致会导致
> 浏览器半身找不到宿主行。

**v2.0.0 面向 DSH 0.2.0-rc.2 内核重写**：不再依赖旧内核的
`settings.register` / `remote.settings` 接口，改为「自有设置文件 + 自有
`/api/network-proxy` 路由 + 设置行 UI」的自包含形态（与本发行版中已验证可用的
插件形态一致）。逐条差异见 [PATCHES.md](./PATCHES.md)。

**v2.1.0 网络安全模型（防断网）**：注册本插件不得导致 harness 失去网络——

1. **切换前先探测**（`src/probe.js`）：system/manual 都要先对代理端点做 TCP 探测；
2. **失败 = 不变**：探测/配置失败时 dispatcher 与环境变量一字不动，保持原出口；
3. **回环永不走代理**：`localhost` / `127.0.0.1` / `[::1]` 强制并入 no-proxy；
4. **降级 = 惰性**：undici 三级解析（已装依赖 → harness 运行时自带副本 →
   `DSH_NETWORK_PROXY_UNDICI` 覆盖）全部失败时拒绝一切切换并说明原因；
5. **卸载即还原**：停用/卸载恢复插件安装前的全局 dispatcher 与环境变量。

## 功能

- **三种模式**
  - `跟随系统`：Windows 读取注册表 `Internet Settings`（先用 `reg.exe query`
    直接读，读不到再退回 PowerShell；两路都读不到才用继承的环境变量作为兜底。
    支持 `http=…;https=…` 多协议写法与 `ProxyOverride` 绕过列表；PAC 自动配置
    脚本不支持，会提示改用手动）；其他平台读取继承的 `HTTP(S)_PROXY` 环境变量。
    发现到的地址会被**导出**为环境变量（见下）。
  - `手动代理`：填写一个 `http://` 或 `https://` 代理地址（如
    `http://127.0.0.1:7890`）。点「手动代理」只是打开地址输入口，**不会立刻
    提交**；填入地址再点「应用」才生效，点「取消」可放弃编辑回到当前模式。
  - `直连`：清空所有代理设置。
- **跟随系统 = 发现 + 导出**：`跟随系统` 不只装宿主进程内的 dispatcher，
  还会把注册表/环境里发现的代理地址写成 `HTTP_PROXY` / `HTTPS_PROXY`
  （以及带环回保护的 `NO_PROXY`），让 git、pnpm、包安装器等**子进程**和
  Harness 本体走同一条出口。没发现到地址时不导出、也不改动继承的环境变量；
  「系统没开代理」不是覆盖启动环境的理由。
- **即时生效**：切换立即替换 undici 全局 dispatcher，并同步改写代理环境变量；
  无需重启，当前会话的后续请求即走新出口。
- **双通道接管**
  - 宿主进程内：所有基于 undici / 全局 `fetch` 的出站请求（LLM 调用、web 工具等）；
  - 子进程：Harness 派生的 shell / 工具进程通过 `HTTP_PROXY` 等环境变量继承同一出口；
    `跟随系统` 模式下这些变量由插件按发现结果写出，无需在 `.gitconfig` 等处另配代理。
- **双语文案**：内置中 / 英文案，跟随 DSH 语言环境自动切换。
- **安全边界**：API 路由带信任围栏——优先复用内核 `connection` 服务的准入判定，
  缺失时回退到结构复刻（仅回环地址、拒绝跨站请求、`Origin`/`Referer` 与
  `Host` 权威必须一致）。

## 系统要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | >= 20.18.1 |
| undici | 无需预装：按「已装依赖 → harness 运行时自带副本 → `DSH_NETWORK_PROXY_UNDICI` 覆盖」解析（本机实测命中运行时副本 6.26.0，符号桥 `globalDispatcher.1` 与 Node 内建 fetch 实测互通） |
| DeepSeek Harness | 0.2.0-rc.2 内核（实测于 DSH Desktop 对应构建） |

## 安装

本插件是标准的 DSH bundle 插件（`dsh.bundle.patch` + `dsh.client`），任一方式：

1. **插件管理器安装**：在 GUI 的「设置 → 插件」中安装本包
   （从 Git 仓库或 npm 包路径），然后启用。
2. **手工安装到当前 profile**（`$DSH_HOME/profiles/<name>`）：
   把本目录加入 `package.json` 的 `dependencies`（或复制进
   `node_modules`），并在 `dsh.profile.bundles` 中加入
   `"dsh-network-proxy"`，随后重启应用。
3. **本地开发**：无需安装依赖——运行时按「已装依赖 → harness 运行时副本 →
   `DSH_NETWORK_PROXY_UNDICI`」解析 undici。如需固定某个版本可在 checkout 内
   `pnpm install --node-linker=hoisted`（**桌面端启动闸门拒绝符号链接**，
   用默认链接器装出 `node_modules` 再整目录复制进 profile 会导致应用拒启）。

安装后重启应用：宿主半身在启动时即按已保存的选择应用出口，浏览器半身在
「设置 → 通用」顶部（语言设置上方）出现「网络代理」行。

## 配置

选择持久化在 `~/.dsh/network-proxy/settings.json`（`$DSH_HOME` 可重定向该位置）：

```json
{ "mode": "system", "url": "" }
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mode` | `system` \| `manual` \| `direct` | `system` | 代理模式 |
| `url` | `string` | `""` | 手动模式下的代理地址（须为 `http(s)://` URL） |

手动地址在保存前经过两道校验：必须是合法的 `http://` 或 `https://` 地址，
**且端点必须可达**（TCP 探测）——否则保存被拒绝并显示原因，当前出口保持
不变（不会因为填错地址或代理没开而断网）。例：v2rayN 走系统代理 mixed
端口时手动填写 `http://127.0.0.1:10808`。

## API

宿主半身在 `webServer` 上挂载以下同源路由（供设置行使用，也可自行调用）：

- `GET /api/network-proxy`
  → `{ ok, mode, url, status: 'active'|'idle'|'error', error, systemProxy }`
- `POST /api/network-proxy/apply`，请求体
  `{ "mode": "manual", "url": "http://127.0.0.1:7890" }`
  → 成功 `{ ok: true, …新状态 }`；参数错误 `{ ok: false, error }`（HTTP 400）

## 开发 & 测试

```bash
pnpm install   # 或 npm install（安装 undici）
npm test       # node smoke-test.mjs
```

冒烟测试两层，**全程仅回环流量、不出网**：纯函数层（URL 归一化、注册表
字符串解析、校验、环境变量、回环 no-proxy 合并、端点解析、TCP 探测），
以及引擎安全层（本机假代理实测：请求真走代理、回环绕过代理、死端点被拒
且原出口存活、非法 URL 先拒、卸载恢复原 dispatcher 与环境变量；本机无
undici 可解析时该层自动跳过并打印说明）。裸 checkout 即可运行。

## 目录结构

```
dsh-network-proxy/
├── index.js            # 宿主半身：undici dispatcher 管理、环境变量、API 路由
├── client.js           # 浏览器半身：设置行 UI、locale、样式（ModuleLoader 包）
├── src/parsers.js      # 纯函数：URL 归一化/解析/校验、环境变量读写（无依赖）
├── src/discover.js     # Windows 系统代理发现（reg.exe → PowerShell 链）
├── src/probe.js        # 代理端点 TCP 可达性探测（切换前置守卫）
├── src/undici-loader.js # undici 三级解析与形状校验
├── src/store.js        # ~/.dsh/network-proxy/settings.json 读写（temp+rename）
├── cordis.patch.yml    # bundle 补丁：挂载宿主半身条目
├── smoke-test.mjs      # 冒烟测试
├── PATCHES.md          # v1.0.1 → v2.0.0 兼容性改动说明
├── package.json
└── LICENSE
```

## 限制

- **PAC 不支持**：Windows 检测到自动配置脚本时会报错并提示改用手动代理。
- **仅 HTTP/HTTPS 代理**：SOCKS 等协议不接受（undici `ProxyAgent` 的边界）。
- **作用范围**：接管宿主进程内的 undici/`fetch` 出站与子进程环境变量；
  使用自有 TCP 栈的进程不在其内。
- **不要再在别处另配代理**：`跟随系统` 已把发现的地址导出为
  `HTTP_PROXY`/`HTTPS_PROXY`，git 等工具直接继承即可。此前在
  `~/.gitconfig` 里另写的 `http.proxy`/`https.proxy` 属于重复配置，
  且会在代理未运行时把 git 拖死——已移除。
- **dispatcher 生命周期**：切换模式时关闭上一代自行安装的 dispatcher；
  插件安装前的全局 dispatcher 只在卸载/停用时恢复，绝不误伤其它 undici 使用者。
- **代理需支持 CONNECT 隧道**：undici `ProxyAgent` 默认 `proxyTunnel`，对 http 与
  https 目标都建 CONNECT（v2rayN 的 mixed 端口原生支持；只做绝对形式转发的老式
  代理不适用）。
- **跟随系统 = 系统代理真的在运行**：代理客户端退出后注册表可能残留
  `ProxyEnable=1`，此时探测拒绝切换并保持原出口（设置行显示原因），
  不会出现「跟着死代理断网」。

## License

[MIT](./LICENSE)
