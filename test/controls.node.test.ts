// Test-only PostgreSQL via PGlite; no production data is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { hash, OAUTH_ISSUER as base, MCP_RESOURCE as resource } from "../src/routes/oauth.ts";
const { PGlite } = await import(process.env.OAUTH_TEST_MODULES + "/@electric-sql/pglite/dist/index.js");
const db = new PGlite();
// Reproduce an existing deployment: old tokens must retain events-only access.
await db.exec("CREATE TABLE oauth_tokens(id TEXT PRIMARY KEY,client TEXT NOT NULL,kind TEXT NOT NULL,expires TIMESTAMPTZ NOT NULL)");
await db.query("INSERT INTO oauth_tokens VALUES ($1,'legacy','access',now()+interval '1 hour')", [hash("mcp_at_legacy")]);
const sql = { unsafe: async (q: string, args?: unknown[]) => {
  if (!args && q.includes("CREATE TABLE")) { await db.exec(q); return []; }
  return (await db.query(q, args)).rows;
}};
const env = { API_KEY: "local-test-owner-key", DATABASE_URL: "unused", TZ_OFFSET: "480" };
const app = createApp({ createSql: () => sql as any });
const request = (path: string, init: RequestInit = {}) => app.fetch(new Request(base + path, init), env);
const owner = { authorization: env.API_KEY };
const write = (body: unknown, headers: Record<string, string> = owner) => request("/controls", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
const call = async (name: string, args: unknown = {}, token = env.API_KEY) => (await (await request("/mcp", {
  method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
})).json()).result;

test("unauthenticated requests cannot query or mutate control state", async () => {
  let connections = 0;
  const isolated = createApp({ createSql: () => { connections++; throw Error("must not connect"); } });
  for (const path of ["/controls", "/controls/"]) for (const method of ["GET", "POST"]) {
    const response = await isolated.fetch(new Request(base + path, { method }), env);
    assert.equal(response.status, 401);
  }
  assert.equal(connections, 0);
  const denied = await call("set_app_control", { app: "小红书", enabled: true, duration_minutes: 1 }, "wrong-key");
  assert.equal(denied.isError, true);
  assert.match(denied._meta["mcp/www_authenticate"][0], /scope="app_controls"/);
});
test("new deployment starts disabled; GET is private and uncached", async () => {
  const response = await request("/controls?app=" + encodeURIComponent("小红书"), { headers: owner });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { app: "小红书", enabled: false, expires_at: null, message: "", updated_at: null });
  assert.equal((await request("/controls?app=other", { headers: owner })).status, 400);
});
test("invalid inputs cannot create permanent restrictions or affect other apps", async () => {
  for (const body of [null, [], { app: "微信", enabled: true, duration_minutes: 1 },
    { app: "小红书", enabled: "true", duration_minutes: 1 }, { app: "小红书", enabled: true },
    ...[0, -1, 1441, 1.5, "30"].map(duration_minutes => ({ app: "小红书", enabled: true, duration_minutes })),
    { app: "小红书", enabled: true, duration_minutes: 1, message: "x".repeat(201) },
  ]) assert.equal((await write(body)).status, 400);
  assert.equal((await db.query("SELECT * FROM app_controls")).rows.length, 0);
});
test("REST enable persists across app instances; expiry and disable are effective", async () => {
  const start = Date.now();
  const response = await write({ app: "小红书", enabled: true, duration_minutes: 1, message: "测试提醒" });
  const state = await response.json(); assert.equal(state.enabled, true); assert.equal(state.message, "测试提醒");
  assert.ok(Date.parse(state.expires_at) >= start + 59000 && Date.parse(state.expires_at) <= Date.now() + 61000);
  const restarted = createApp({ createSql: () => sql as any });
  const persisted = await (await restarted.fetch(new Request(base + "/controls", { headers: owner }), env)).json();
  assert.equal(persisted.enabled, true); assert.equal(persisted.expires_at, state.expires_at);
  await db.query("UPDATE app_controls SET expires_at=now()-interval '1 second'");
  assert.equal((await (await request("/controls", { headers: owner })).json()).enabled, false);
  const disabled = await (await write({ app: "小红书", enabled: false })).json();
  assert.equal(disabled.enabled, false); assert.equal(disabled.expires_at, null);
});
test("MCP advertises five tools and separates control permission from records", async () => {
  const catalog = await (await request("/mcp", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
  assert.equal(catalog.result.tools.length, 5);
  for (const tool of catalog.result.tools.filter((t: any) => t.name.endsWith("app_control"))) {
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["app_controls"] }]);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  assert.equal((await call("query_events", { hours: 1 }, "mcp_at_legacy")).isError, false);
  const denied = await call("set_app_control", { app: "小红书", enabled: true, duration_minutes: 1 }, "mcp_at_legacy");
  assert.equal(denied.isError, true); assert.match(denied._meta["mcp/www_authenticate"][0], /insufficient_scope/);
  assert.match(denied._meta["mcp/www_authenticate"][0], /scope="events app_controls"/);
  assert.equal((await call("get_app_control")).structuredContent.enabled, false);
});

let controlAccess = "", controlRefresh = "", client = "";
const form = (data: Record<string, string>, extra: Record<string, string> = {}) => ({ method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...extra }, body: new URLSearchParams(data) });
test("explicit OAuth consent grants only requested control scope", async () => {
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect", verifier = "v".repeat(64);
  client = (await (await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect] }) })).json()).client_id;
  const params = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: "code", resource,
    scope: "app_controls", code_challenge_method: "S256", code_challenge: hash(verifier) });
  const login = await request("/oauth/authorize?" + params);
  const html = await login.text(); assert.match(html, /开启和解除小红书临时限制/); assert.ok(!html.includes("查询事件和清理记录"));
  const pending = html.match(/name="request" value="([^"]+)"/)![1];
  const approved = await request("/oauth/authorize", form({ request: pending, key: env.API_KEY }, {
    origin: base, cookie: login.headers.get("set-cookie")!.split(";")[0],
  }));
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const issued = await (await request("/oauth/token", form({ grant_type: "authorization_code", client_id: client,
    redirect_uri: redirect, code, code_verifier: verifier, resource }))).json();
  assert.equal(issued.scope, "app_controls"); controlAccess = issued.access_token; controlRefresh = issued.refresh_token;
  assert.equal((await call("set_app_control", { app: "小红书", enabled: true, duration_minutes: 1 }, controlAccess)).structuredContent.enabled, true);
  assert.equal((await call("get_app_control", {}, controlAccess)).structuredContent.enabled, true);
  assert.equal((await call("query_events", {}, controlAccess)).isError, true);
  assert.equal((await request("/controls", { headers: { authorization: "Bearer " + controlAccess } })).status, 401);
  assert.equal((await call("set_app_control", { app: "小红书", enabled: false }, controlAccess)).structuredContent.enabled, false);
});
test("refresh preserves granted scope and cannot silently expand it", async () => {
  assert.equal((await request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: controlRefresh,
    client_id: client, resource, scope: "events app_controls" }))).status, 400);
  const refreshed = await (await request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: controlRefresh,
    client_id: client, resource, scope: "app_controls" }))).json();
  assert.equal(refreshed.scope, "app_controls");
  assert.equal((await call("query_events", {}, refreshed.access_token)).isError, true);
  assert.equal((await call("get_app_control", {}, refreshed.access_token)).isError, false);
  await db.close();
});
