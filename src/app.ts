import { Hono } from "hono";
import type { Env, Vars } from "./types.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { createSql, withRetry } from "./lib/db.ts";
import { parseOffsetEnv } from "./lib/timezone.ts";
import { events } from "./routes/events.ts";
import { mcp } from "./routes/mcp.ts";
import { createOAuthRoutes, OAUTH_DDL, OAUTH_ISSUER, ACCESS_PREFIX, validOAuthToken } from "./routes/oauth.ts";
import type postgres from "postgres";

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL CHECK (type ~ '^[a-z0-9]+(\\.[a-z0-9]+)*$'),
    value TEXT,
    ts TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

export type AppOptions = {
  postgresOptions?: Record<string, unknown>;
  /** 替换数据库连接的创建方式，测试用 */
  createSql?: (databaseUrl: string, options?: Record<string, unknown>) => postgres.Sql;
};

export function createApp(options?: AppOptions) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  const makeSql = options?.createSql ?? createSql;

  let sqlInstance: postgres.Sql | null = null;
  let schemaReady = false;
  let schemaPromise: Promise<void> | null = null;
  let cachedOffsetMinutes: number | null = null;

  /**
   * 建表。并发请求共用同一次执行；失败时清掉进行中的 Promise，
   * 让下一个请求重新尝试——数据库晚一步就绪不应该让这个部署永久缺表。
   */
  async function ensureSchema(sql: postgres.Sql): Promise<void> {
    if (schemaReady) return;
    schemaPromise ??= withRetry(() => sql.unsafe(SCHEMA_DDL + OAUTH_DDL)).then(() => {
      schemaReady = true;
    });
    try {
      await schemaPromise;
    } catch (error) {
      schemaPromise = null;
      throw error;
    }
  }

  // CORS
  app.use("*", corsMiddleware);

  // Global error handler
  app.onError((err, c) => {
    console.error("Unexpected error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // 404 handler
  app.notFound((c) => {
    return c.json({ error: "Not found" }, 404);
  });

  app.get("/", (c) => c.json({ service: "device-event-logger", status: "running" }));

  // Keep shortcuts on their existing API key. OAuth tokens are limited to MCP.
  app.use("*", (c, next) => {
    if (/^\/events(\/|$)/.test(c.req.path)) return authMiddleware(c, next);
    if (/^\/mcp(\/|$)/.test(c.req.path)) {
      const raw = (c.req.header("Authorization") ?? "").trim();
      const bearer = /^Bearer /i.test(raw);
      const token = bearer ? raw.slice(7).trim() : raw;
      if (token && c.env.API_KEY && token === c.env.API_KEY) return next();
      if (bearer && token.startsWith(ACCESS_PREFIX)) return next();
      c.header("WWW-Authenticate", `Bearer resource_metadata="${OAUTH_ISSUER}/.well-known/oauth-protected-resource"`);
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  // DB + timezone injection
  app.use("*", async (c, next) => {
    if (!sqlInstance) {
      const databaseUrl = c.env.DATABASE_URL ?? "";
      sqlInstance = makeSql(databaseUrl, options?.postgresOptions);
    }
    await ensureSchema(sqlInstance);
    if (cachedOffsetMinutes === null) {
      cachedOffsetMinutes = parseOffsetEnv(c.env.TZ_OFFSET);
    }
    c.set("sql", sqlInstance);
    c.set("offsetMinutes", cachedOffsetMinutes);
    await next();
  });

  // Readiness includes schema initialization and a live database query.
  app.get("/healthz", async (c) => {
    await c.get("sql").unsafe("SELECT 1");
    return c.json({ status: "ok" });
  });

  app.use("*", async (c, next) => {
    if (/^\/mcp(\/|$)/.test(c.req.path)) {
      const token = (c.req.header("Authorization") ?? "").replace(/^Bearer /i, "").trim();
      if (token !== c.env.API_KEY && !await validOAuthToken(c.get("sql"), token)) {
        c.header("WWW-Authenticate", `Bearer resource_metadata="${OAUTH_ISSUER}/.well-known/oauth-protected-resource", error="invalid_token"`);
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    await next();
  });
  app.route("/", createOAuthRoutes());
  // Routes
  app.route("/events", events);
  app.route("/mcp", mcp);

  return app;
}
