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

`/mcp` 是一个 JSON-RPC 端点，接入 MCP 客户端后有五个工具可用。

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


## 此部署实例的 ChatGPT OAuth 接入

本实例在现有 Render 服务中提供 OAuth 授权网关；无需额外注册身份提供方账号。

- MCP URL：`https://device-event-logger-4rtn.onrender.com/mcp`
- 身份验证选择 **OAuth**。支持动态客户端注册（DCR），进阶客户端 ID/Secret 留空。
- ChatGPT 跳转到本站授权页后，输入快捷指令使用的 API_KEY，明确同意授权。
- `events` 权限用于 MCP 查询、列举类型和清理；删除有预览和确认要求。应用限制另需明确授权 `app_controls`。
- `/events` 的现有密钥验证不变。OAuth 令牌不能用于该上传接口。
- 授权码使用 PKCE S256，60 秒有效且只能使用一次；访问令牌有效期一小时，刷新令牌三十天且每次续期轮换。
- 数据库只保存授权码和令牌的 SHA-256 摘要；Cookie 使用 Secure、HttpOnly、SameSite=Lax，并校验授权请求的来源。
- 可信回调限于 ChatGPT 的正式 OAuth 回调路径。更换域名或客户端时需同步修改 `src/routes/oauth.ts` 的规范签发方和回调校验。

### OAuth 集成验证

测试使用临时 PGlite 数据库，不接触生产事件数据：

```sh
npm install --prefix /tmp/device-event-oauth-check --no-audit --no-fund @electric-sql/pglite
OAUTH_TEST_MODULES=/tmp/device-event-oauth-check/node_modules node --experimental-strip-types --test test/oauth.node.test.ts
```


## 小红书临时限制试用版

默认关闭。服务端只保存开关，手机需自行配置“打开小红书”个人自动化。

- `get_app_control`：读取有效状态，需要 `app_controls` OAuth 权限。
- `set_app_control`：开启或解除限制，需要 `app_controls`。启用时提供 `app: "小红书"`、`enabled: true`、`duration_minutes: 1..1440`，可选 `message`（最多 200 字符）。解除时传 `enabled: false`。
- 老的 `events` 授权不会自动增加控制权限。首次使用控制工具时需重新同意所需权限；刷新令牌不会扩大权限。
- 限制状态由 PostgreSQL 保存，重启后保留；每次读取按数据库当前时间判断到期，到期立即返回 `enabled: false`，不依赖后台定时任务。
- 快捷指令读取 `GET /controls?app=%E5%B0%8F%E7%BA%A2%E4%B9%A6`，Authorization 沿用已有 API_KEY。按字典字段 `enabled` 判断，使用 `message` 显示通知，再打开 ChatGPT。
- `POST /controls` 接受相同参数的 JSON，仅用于持有 API_KEY 的管理调用。GET 永不修改开关；所有状态接口禁止缓存。
- 手机失去网络或自动化被关闭时无法保证拦截。仅在下一次打开 App 时检查，无法即时关闭已打开的 App。打开 ChatGPT 不保证返回某一指定对话。
- 试用版仅支持小红书，不能影响其他应用。保留随时解除和最长 24 小时自动到期。

本地验证（临时测试数据库，无需生产连接）：

```sh
npm install --prefix /tmp/device-event-control-check --no-audit --no-fund @electric-sql/pglite
OAUTH_TEST_MODULES=/tmp/device-event-control-check/node_modules node --experimental-strip-types --test test/controls.node.test.ts test/oauth.node.test.ts
```
