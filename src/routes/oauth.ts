import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Env, Vars } from "../types.ts";

// Fixed canonical issuer: do not trust the request Host or forwarded headers.
export const OAUTH_ISSUER = "https://device-event-logger-4rtn.onrender.com";
export const MCP_RESOURCE = `${OAUTH_ISSUER}/mcp`;
export const ACCESS_PREFIX = "mcp_at_";
const token = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("base64url");
const decodeJSON = (value: any): any => typeof value === "string" ? JSON.parse(value) : value;
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

export function allowedRedirect(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash &&
      ["chatgpt.com", "chat.openai.com"].includes(u.hostname) &&
      (u.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname));
  } catch { return false; }
}

export const OAUTH_DDL = `
CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY, redirects JSONB NOT NULL, expires TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_requests(id TEXT PRIMARY KEY, csrf TEXT NOT NULL, data JSONB NOT NULL, expires TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes(id TEXT PRIMARY KEY, data JSONB NOT NULL, expires TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens(id TEXT PRIMARY KEY, client TEXT NOT NULL, kind TEXT NOT NULL, expires TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS oauth_tokens_expiry ON oauth_tokens(expires);
`;

export async function validOAuthToken(sql: import("postgres").Sql, value: string) {
  if (!value.startsWith(ACCESS_PREFIX)) return false;
  const rows = await sql.unsafe("SELECT id FROM oauth_tokens WHERE id=$1 AND kind='access' AND expires>now()", [hash(value)]);
  return rows.length > 0;
}

export function createOAuthRoutes() {
  const oauth = new Hono<{ Bindings: Env; Variables: Vars }>();
  // Single owner and single instance. Global limits prevent spoofed proxy headers bypassing them.
  const rates = new Map<string, { count: number; expires: number }>();
  function limited(name: string, max: number) {
    const now = Date.now(), previous = rates.get(name);
    const bucket = previous && previous.expires > now ? previous : { count: 0, expires: now + 60_000 };
    rates.set(name, bucket);
    return ++bucket.count > max;
  }
  oauth.use("*", bodyLimit({ maxSize: 16384, onError: c => c.json({ error: "invalid_request" }, 413) }));
  oauth.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    // Keep the real Origin on same-origin HTML form POSTs. no-referrer makes browsers send Origin: null.
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (Number(c.req.header("content-length") ?? 0) > 16384) return c.json({ error: "invalid_request" }, 413);
    await next();
  });
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    oauth.get(path, c => c.json({ resource: MCP_RESOURCE, authorization_servers: [OAUTH_ISSUER], scopes_supported: ["events"] }));
  }
  oauth.get("/.well-known/oauth-authorization-server", c => c.json({
    issuer: OAUTH_ISSUER, authorization_endpoint: `${OAUTH_ISSUER}/oauth/authorize`,
    token_endpoint: `${OAUTH_ISSUER}/oauth/token`, registration_endpoint: `${OAUTH_ISSUER}/oauth/register`,
    revocation_endpoint: `${OAUTH_ISSUER}/oauth/revoke`,
    authorization_response_iss_parameter_supported: true,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: ["events"],
  }));
  oauth.post("/oauth/register", async c => {
    if (limited("register", 30)) return c.json({ error: "slow_down" }, 429);
    const b = await c.req.json().catch(() => null);
    if (!b || !Array.isArray(b.redirect_uris) || !b.redirect_uris.length || b.redirect_uris.length > 5 || !b.redirect_uris.every(allowedRedirect) ||
      (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== "none")) return c.json({ error: "invalid_client_metadata" }, 400);
    const id = token();
    await c.get("sql").unsafe("INSERT INTO oauth_clients(id,redirects,expires) VALUES ($1,$2::text::jsonb,now()+interval '1 year')", [id, JSON.stringify(b.redirect_uris)]);
    return c.json({ client_id: id, client_id_issued_at: Math.floor(Date.now()/1000), redirect_uris: b.redirect_uris,
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "events" }, 201);
  });
  oauth.get("/oauth/authorize", async c => {
    if (limited("authorize", 30)) return c.json({ error: "slow_down" }, 429);
    const q = c.req.query(), sql = c.get("sql");
    const clients = await sql.unsafe("SELECT redirects FROM oauth_clients WHERE id=$1 AND expires>now()", [q.client_id ?? ""]);
    if (!clients.length || !allowedRedirect(q.redirect_uri) || !decodeJSON(clients[0].redirects).includes(q.redirect_uri) ||
      q.response_type !== "code" || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? "") ||
      q.resource !== MCP_RESOURCE || (q.scope && q.scope !== "events")) return c.json({ error: "invalid_request" }, 400);
    const id = token(), csrf = token();
    await sql.unsafe("INSERT INTO oauth_requests(id,csrf,data,expires) VALUES ($1,$2,$3::text::jsonb,now()+interval '10 minutes')", [hash(id), hash(csrf), JSON.stringify(q)]);
    setCookie(c, "__Host-oauth_csrf", csrf, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
    return c.html(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权手机使用记录</title><body><h1>授权 ChatGPT 连接手机使用记录</h1><p>授权后，ChatGPT 可以查询事件和清理记录。删除操作会要求确认。</p><p>请输入快捷指令使用的 API Key，仅用于向此服务确认身份。授权令牌有效期为一小时，可续期三十天。</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${id}"><label>API Key <input type="password" name="key" autocomplete="off" required></label><button type="submit">确认授权</button></form></body></html>`);
  });
  oauth.post("/oauth/authorize", async c => {
    if (c.req.header("origin") !== OAUTH_ISSUER) return c.json({ error: "invalid_request", error_description: "授权页面来源校验失败，请从 ChatGPT 重新连接。" }, 403);
    if (limited("login", 10)) return c.json({ error: "slow_down" }, 429);
    const b = await c.req.parseBody(), sql = c.get("sql"), id = String(b.request ?? ""), key = String(b.key ?? "");
    const csrf = getCookie(c, "__Host-oauth_csrf") ?? "";
    const pending = await sql.unsafe("SELECT * FROM oauth_requests WHERE id=$1 AND expires>now()", [hash(id)]);
    if (!pending.length) return c.json({ error: "invalid_request", error_description: "授权页面已过期或已提交，请从 ChatGPT 重新连接。" }, 400);
    if (!csrf || !equal(pending[0].csrf, hash(csrf))) return c.json({ error: "invalid_request", error_description: "授权会话校验失败，请从 ChatGPT 重新连接并在同一浏览器完成授权。" }, 400);
    if (!key || !c.env.API_KEY || !equal(key, c.env.API_KEY)) return c.text("API Key 不正确，请返回重试。", 401);
    const q = decodeJSON(pending[0].data), code = token();
    // Delete and create in one SQL statement so concurrent consent cannot reuse a request.
    const inserted = await sql.unsafe("WITH claimed AS (DELETE FROM oauth_requests WHERE id=$1 AND expires>now() RETURNING data) INSERT INTO oauth_codes(id,data,expires) SELECT $2,data,now()+interval '60 seconds' FROM claimed RETURNING id", [hash(id), hash(code)]);
    if (!inserted.length) return c.json({ error: "invalid_request" }, 400);
    const target = new URL(q.redirect_uri);
    target.searchParams.set("code", code); target.searchParams.set("iss", OAUTH_ISSUER);
    if (q.state) target.searchParams.set("state", q.state);
    return c.redirect(target.toString(), 303);
  });
  oauth.post("/oauth/token", async c => {
    if (limited("token", 60)) return c.json({ error: "slow_down" }, 429);
    const b = await c.req.parseBody(), sql = c.get("sql"), client = String(b.client_id ?? "");
    if (b.resource !== MCP_RESOURCE) return c.json({ error: "invalid_target" }, 400);
    const access = ACCESS_PREFIX + token(), refresh = "mcp_rt_" + token();
    let consumed: unknown[];
    if (b.grant_type === "authorization_code") {
      const codeHash = hash(String(b.code ?? "")), verifier = String(b.code_verifier ?? "");
      const rows = await sql.unsafe("SELECT data FROM oauth_codes WHERE id=$1 AND expires>now()", [codeHash]);
      if (!rows.length) return c.json({ error: "invalid_grant" }, 400);
      const q = decodeJSON(rows[0].data);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || q.client_id !== client || q.redirect_uri !== b.redirect_uri || !equal(q.code_challenge, hash(verifier))) return c.json({ error: "invalid_grant" }, 400);
      consumed = await sql.unsafe("WITH claimed AS (DELETE FROM oauth_codes WHERE id=$1 AND expires>now() RETURNING id) INSERT INTO oauth_tokens(id,client,kind,expires) SELECT $2,$3,'access',now()+interval '1 hour' FROM claimed UNION ALL SELECT $4,$3,'refresh',now()+interval '30 days' FROM claimed RETURNING id", [codeHash, hash(access), client, hash(refresh)]);
    } else if (b.grant_type === "refresh_token") {
      consumed = await sql.unsafe("WITH claimed AS (DELETE FROM oauth_tokens WHERE id=$1 AND client=$2 AND kind='refresh' AND expires>now() RETURNING id) INSERT INTO oauth_tokens(id,client,kind,expires) SELECT $3,$2,'access',now()+interval '1 hour' FROM claimed UNION ALL SELECT $4,$2,'refresh',now()+interval '30 days' FROM claimed RETURNING id", [hash(String(b.refresh_token ?? "")), client, hash(access), hash(refresh)]);
    } else return c.json({ error: "unsupported_grant_type" }, 400);
    if (!consumed.length) return c.json({ error: "invalid_grant" }, 400);
    for (const table of ["oauth_requests", "oauth_codes", "oauth_tokens", "oauth_clients"]) await sql.unsafe(`DELETE FROM ${table} WHERE expires<now()`);
    return c.json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "events" });
  });
  oauth.post("/oauth/revoke", async c => {
    if (limited("revoke", 30)) return c.json({ error: "slow_down" }, 429);
    const b = await c.req.parseBody();
    await c.get("sql").unsafe("DELETE FROM oauth_tokens WHERE id=$1 AND client=$2", [hash(String(b.token ?? "")), String(b.client_id ?? "")]);
    return c.body(null, 200);
  });
  return oauth;
}
