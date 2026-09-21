# dsh-redis

`dsh-redis` 是 DeepSeek Harness 的 Redis Host 插件，让 Agent 通过模型工具安全地连接 Redis，执行常用的增删改查操作。

## 功能

插件注册以下工具：

- `redis_list`：列出连接并执行 `PING`。
- `redis_health`：检查连接状态与插件限制。
- `redis_get`：读取 key，支持 string、hash、list、set、zset，并返回 TTL。
- `redis_set`：创建或更新 key，支持 JSON 值、过期时间、`nx`/`xx` 条件写入。
- `redis_delete`：删除一个或多个 key。
- `redis_scan`：按模式扫描 key，可选择读取 string 值。

插件使用 Node 内置 `net`/`tls` 和 RESP2 协议客户端，不依赖第三方 Redis SDK，也不把 Redis 凭据发送到浏览器。

## 安装

从当前工作区安装 bundle：

```powershell
# 在 DSH Web profile 中执行
# 由 Harness plugin_manager 安装当前目录的 bundle
```

本目录的 `cordis.patch.yml` 已配置本机和测试连接。密码只从环境变量读取，不写入 patch：

```powershell
# 在启动 DSH 的同一终端中设置，替换为实际密码
$env:DSH_REDIS_PASSWORD_LOCAL = "<local-password>"
$env:DSH_REDIS_PASSWORD_TEST = "<test-password>"
```

修改环境变量后需要重新启动 DSH。若要改用其他 Redis 地址，可设置 `DSH_REDIS_URL`，或在 patch 中增加连接。

也可以在 patch 中配置多个连接：

```yaml
- insert:
    - id: redis
      name: 'dsh-redis'
      config:
        connections:
          - name: local
            url: 'redis://127.0.0.1:6379/0'
          - name: production
            url: 'rediss://redis.example.com:6380/0'
            password: !!js >-
              process.env.DSH_REDIS_PASSWORD_PRODUCTION || ''
        defaultConnection: local
        maxScanKeys: 1000
        maxCollectionItems: 1000
        maxStringLength: 1000000
        operationTimeoutMs: 30000
        writeApproval: true
```

密码优先从连接配置读取；推荐使用环境变量 `DSH_REDIS_PASSWORD_<连接名大写>`，避免把密码写入 patch。Redis URL 中的密码也支持 URL 编码。

## Agent 调用示例

```text
redis_health {}
redis_set {"key":"profile:42","value":{"name":"Ada"},"ttlSeconds":3600}
redis_get {"key":"profile:42","parseJson":true}
redis_scan {"pattern":"profile:*","includeValues":true}
redis_delete {"keys":["profile:42"]}
```

`redis_set` 和 `redis_delete` 默认经过 Harness 的写操作审批门。若确需关闭，可在插件配置中设置 `writeApproval: false`；生产环境建议保持开启。

## 限制

- `redis_scan`、集合读取和字符串读取都有配置上限，避免一次把整个数据库加载进 Agent 上下文。
- `redis_get` 对 stream 等未实现读取语义的类型会返回 `supported: false`，不会执行未知命令。
- 每次命令按需建立并关闭一个 TCP/TLS 连接，优先保证插件隔离和生命周期简单；高吞吐场景应使用连接池型 Redis MCP 服务。
