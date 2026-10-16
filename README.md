# dsh-redis

`dsh-redis` 是 DeepSeek Harness 的 Redis Host 插件，让 Agent 通过模型工具安全地连接 Redis，执行常用的增删改查操作。

## 功能

插件注册以下工具：

- `redis_list`：列出连接并执行 `PING`。
- `redis_health`：检查连接状态与插件限制。
- `redis_get`：读取 key，支持 string、hash、list、set、zset，并返回 TTL。
- `redis_set`：创建或更新 string key，支持 JSON 值、过期时间、`nx`/`xx` 条件写入。
- `redis_delete`：删除一个或多个 key。
- `redis_hset` / `redis_hdel`：新增/更新 hash field，或删除 hash field。
- `redis_zadd` / `redis_zrem`：新增/更新 sorted-set member 的 score，或删除 member。
- `redis_sadd` / `redis_srem`：新增或删除 set member。
- `redis_list_push` / `redis_lrem`：向 list 左/右追加值，或按值删除匹配项。
- `redis_scan`：按模式扫描 key，可选择读取 string 值。

插件使用 Node 内置 `net`/`tls` 和 RESP2 协议客户端，不依赖第三方 Redis SDK，也不把 Redis 凭据发送到浏览器。

## 安装

从当前工作区安装 bundle：

```powershell
# 在 DSH Web profile 中执行
# 由 Harness plugin_manager 安装当前目录的 bundle
```

仓库只提供安全默认配置 [`cordis.patch.example.yml`](cordis.patch.example.yml)。私有连接配置应写在 DSH profile 的 `cordis.patch.yml` 覆盖层，不要提交到 Git。可按需设置地址与密码环境变量，或在 profile 覆盖层中填写私有连接信息：

```powershell
$env:DSH_REDIS_URL_TEST = "redis://your-test-host:6379/10"
$env:DSH_REDIS_URL_TEST_GREET = "redis://your-test-host:6379/20"
$env:DSH_REDIS_PASSWORD_LOCAL = "<local-password>"
$env:DSH_REDIS_PASSWORD_TEST = "<test-password>"
```

该项目目录的本地 `cordis.patch.yml` 已加入 `.gitignore`，只用于本机开发，不会进入提交或发布包。修改环境变量后需要重新启动 DSH。

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

账号密码形式的配置模板见 [`cordis.patch.username-password.example.yml`](cordis.patch.username-password.example.yml)。将其中连接项合并到 DSH profile 的 `cordis.patch.yml` 覆盖层，替换用户名和密码占位符；不要将真实凭据写入 Git 跟踪文件。

## Agent 调用示例

```text
redis_health {}
redis_set {"key":"profile:42","value":{"name":"Ada"},"ttlSeconds":3600}
redis_get {"key":"profile:42","parseJson":true}
redis_scan {"pattern":"profile:*","includeValues":true}
redis_hset {"key":"user:42","fields":{"name":"Ada","active":true}}
redis_hdel {"key":"user:42","fields":["active"]}
redis_zadd {"key":"leaderboard","members":[{"member":"user:42","score":125}]}
redis_sadd {"key":"online-users","members":["user:42"]}
redis_list_push {"key":"jobs","side":"right","values":[{"id":1}]}
redis_delete {"keys":["profile:42"]}
```

所有 Redis 写工具（`redis_set`、`redis_delete`、`redis_hset`、`redis_hdel`、`redis_zadd`、`redis_zrem`、`redis_sadd`、`redis_srem`、`redis_list_push`、`redis_lrem`）执行前都会弹出逐次确认，显示目标 key 与字段/member 摘要。用户可选择“允许本次操作”“允许本次会话”或“拒绝本次操作”。会话授权仅保存在当前 Agent 运行实例的内存中，仅覆盖后续 Redis 写工具调用；DSH 重启或会话重新恢复后需重新授权。取消、无可用确认界面或非主会话调用都会 fail closed。可在插件配置中设置 `writeApproval: false` 关闭确认，但生产环境建议保持开启。

## 限制

- `redis_scan`、集合读取和字符串读取都有配置上限，避免一次把整个数据库加载进 Agent 上下文。
- `redis_get` 对 stream 等未实现读取语义的类型会返回 `supported: false`，不会执行未知命令。
- 每次命令按需建立并关闭一个 TCP/TLS 连接，优先保证插件隔离和生命周期简单；高吞吐场景应使用连接池型 Redis MCP 服务。
