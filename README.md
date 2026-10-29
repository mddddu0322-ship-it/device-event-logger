# device-event-logger

记录用户设备事件的 API 端点，支持通过 MCP 查询和清理。

## 一键部署

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/clone?referralCode=fcYa38&utm_medium=integration&utm_source=template&utm_campaign=generic)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Tosd0/device-event-logger)

点击按钮即可自动创建服务和 PostgreSQL 数据库。数据库表会在首次请求时自动初始化。

## 手动部署

### Deno Deploy

1. Fork 或导入此仓库到 GitHub
2. 前往 [dash.deno.com](https://dash.deno.com) 创建项目，关联仓库
3. 设置入口文件为 `entry/deno.ts`
4. 在项目设置中添加环境变量：
   - `DATABASE_URL` — PostgreSQL 连接字符串
   - `API_KEY` — 认证密钥
   - `TZ_OFFSET` — `480`（可选）
5. 部署即可，推送代码会自动重新部署

### Cloudflare Workers

1. 安装 Wrangler CLI：

```bash
npm install -g wrangler
```

2. 创建 `wrangler.toml`：

```toml
name = "device-event-logger"
main = "entry/cloudflare.ts"
compatibility_date = "2024-01-01"
node_compat = true

[vars]
TZ_OFFSET = "480"
```

3. 设置 Secrets：

```bash
wrangler secret put DATABASE_URL
wrangler secret put API_KEY
```

4. 部署：

```bash
wrangler deploy
```

> 注意：CF Workers 需要支持 TCP 连接的 PostgreSQL（如 Neon、Supabase），通过 `cloudflare:sockets` 连接。

### Node.js

```bash
git clone https://github.com/Tosd0/device-event-logger.git
cd device-event-logger
npm install

# 设置环境变量
export DATABASE_URL="postgres://user:pass@host:5432/dbname"
export API_KEY="your-secret-key"
export TZ_OFFSET="480"

# 启动（需要 Node.js >= 22）
npm start
```

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 连接字符串 | 是 |
| `API_KEY` | `/events` 和 `/mcp` 端点的认证密钥（`Authorization` 头写 `Bearer <key>` 或直接写 `<key>` 都可以） | 是 |
| `TZ_OFFSET` | 与 UTC 的时区偏移（分钟，默认 `480`，即 +08:00；+05:30 这类非整点时区写 `330`） | 否 |
| `PORT` | 服务端口（默认 `8000`，仅 Node/Deno） | 否 |

## MCP 工具

`/mcp` 是一个 JSON-RPC 端点，接入 MCP 客户端后有三个工具可用。

| 工具 | 作用 |
|------|------|
| `list_event_types` | 列出库里出现过的事件类型，可用 `hours` 限定最近多久 |
| `query_events` | 按时间范围、类型、值查询记录 |
| `delete_events` | 按时间范围、类型、值删除记录 |

### delete_events

删除条件可以任意组合，至少要给一个：

| 参数 | 说明 |
|------|------|
| `before_days` | 删 N 天前的记录（从当前时刻往回算） |
| `date` | 删本地某一天，写 `YYYY-MM-DD`，按 `TZ_OFFSET` 所在时区解释 |
| `since` / `until` | 自定义时间区间，ISO 8601，两端都含 |
| `type` | 事件类型。不带点号时连子类型一起匹配（`app` 覆盖 `app.open` 等所有 `app.*`），带点号只匹配这一种 |
| `value` | 精确匹配值，比如某个具体应用名 |
| `confirm` | 传 `true` 才真的删 |

时间条件三选一：`date` 不能和 `before_days`、`since`、`until` 一起用；`before_days` 和 `until` 都定义时间上界，也不能同时给。

不带 `confirm` 时是预览模式，只返回命中条数，不动数据：

```json
{ "before_days": 30, "type": "app" }
→ Preview only, nothing was deleted. 128 event(s) match ...
```

确认条数没问题后，同样的条件加上 `confirm: true` 再调一次才会真删。

> 此部署版本的 `/mcp` 端点要求 API_KEY。MCP 客户端需要支持设置 `Authorization` 请求头。仅支持 OAuth 的客户端还需要额外配置 OAuth，不能直接使用此密钥方式。

## HTTP 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 服务运行状态，不读取事件 |
| `GET` | `/healthz` | 数据库就绪检查，用于 Railway 部署健康检查 |
| `POST` | `/events` | 写入一条事件，body 为 `{ "type": "app.open", "value": "Safari" }` |
| `GET` | `/events` | 查询记录，支持 `hours`/`since`/`until`/`type`/`value`/`limit`/`offset` |
| `DELETE` | `/events?days=N` | 删除 N 天前的记录 |

`/events` 和 `/mcp` 需要在 `Authorization` 头里带上 API_KEY，写 `Bearer <key>` 或直接写 `<key>` 都可以。
