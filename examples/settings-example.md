# Settings example

本 fork 不再把选择注册进内核 settings 命名空间，而是持久化到插件自有的
`~/.dsh/network-proxy/settings.json`（`$DSH_HOME` 可重定向该位置）：

```json
{ "mode": "system", "url": "" }
```

| field | type | default | note |
|-------|------|---------|------|
| mode  | system \| manual \| direct | system | 出站模式 |
| url   | string | "" | 手动模式地址（须为 http(s)://） |

手动模式示例：

```json
{ "mode": "manual", "url": "http://127.0.0.1:7890" }
```

地址在保存前经两道校验：必须是合法 `http://` / `https://` 地址，**且端点必须
可达**（TCP 探测）——否则保存被拒并显示原因，当前出口保持不变。

> 该文件由插件自己维护，请通过设置行修改而不是手工编辑；手工编辑后需切一次
> 模式（或重启）才会被重新读取。
