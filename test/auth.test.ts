import { assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createFakeSql, mcpRequest, TEST_ENV } from "./helpers.ts";

/** GET /events：认证通过会走到查询并返回 200，没通过则 401 */
function eventsRequest(authorization?: string): Request {
  return new Request("http://localhost/events?hours=1", {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

function createTestApp() {
  const { sql } = createFakeSql((query) =>
    Promise.resolve(query.includes("COUNT(*)") ? [{ total: 0 }] : [])
  );
  return createApp({ createSql: () => sql });
}

async function statusFor(authorization?: string): Promise<number> {
  const res = await createTestApp().fetch(eventsRequest(authorization), TEST_ENV);
  await res.text();
  return res.status;
}

Deno.test("Authorization 带 Bearer 前缀可以通过", async () => {
  assertEquals(await statusFor(`Bearer ${TEST_ENV.API_KEY}`), 200);
});

Deno.test("Authorization 只填纯密钥也可以通过", async () => {
  assertEquals(
    await statusFor(TEST_ENV.API_KEY),
    200,
    "有的客户端填不了 Bearer 前缀，只认前缀会把它们全挡在门外",
  );
});

Deno.test("Bearer 前缀大小写和多余空格不影响认证", async () => {
  assertEquals(await statusFor(`bearer ${TEST_ENV.API_KEY}`), 200);
  assertEquals(await statusFor(`  Bearer   ${TEST_ENV.API_KEY}  `), 200);
});

Deno.test("密钥不对一律 401", async () => {
  const rejected = [
    undefined,
    "",
    "Bearer ",
    "Bearer wrong-key",
    "wrong-key",
    `Bearer ${TEST_ENV.API_KEY}-extra`,
  ];
  for (const header of rejected) {
    assertEquals(await statusFor(header), 401, `不该放行：${JSON.stringify(header)}`);
  }
});

Deno.test("MCP 未授权请求不能触发数据库连接或删除", async () => {
  let connections = 0;
  const app = createApp({ createSql: () => {
    connections++;
    throw new Error("Unauthorized request must not connect to the database");
  } });
  for (const path of ["/mcp", "/mcp/"]) {
    for (const token of ["", "Bearer wrong-key"]) {
      const request = mcpRequest({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "delete_events", arguments: { type: "app", confirm: true } },
      }, { Authorization: token });
      const response = await app.fetch(new Request(`http://localhost${path}`, request), TEST_ENV);
      const body = await response.json();
      assertEquals(response.status, 200);
      assertEquals(body.result.isError, true);
      assertEquals(body.result._meta["mcp/www_authenticate"].length, 1);
      assertEquals(body.result.structuredContent, undefined);
    }
  }
  assertEquals(connections, 0);
});

Deno.test("MCP 正确密钥允许握手", async () => {
  const { sql } = createFakeSql();
  const app = createApp({ createSql: () => sql });
  const response = await app.fetch(mcpRequest({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "deployment-check", version: "1.0.0" } },
  }), TEST_ENV);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).result.serverInfo.name, "device-event-logger");
});


Deno.test("未登录可以发现工具及 OAuth 要求，但查询仍返回授权提示", async () => {
  const app = createApp({ createSql: () => { throw new Error("Must not access data"); } });
  const list = await app.fetch(mcpRequest({jsonrpc:"2.0",id:1,method:"tools/list"},{Authorization:""}), TEST_ENV);
  assertEquals(list.status,200);
  for (const tool of (await list.json()).result.tools) {
    assertEquals(tool.securitySchemes,[{type:"oauth2",scopes:["events"]}]);
    assertEquals(tool._meta.securitySchemes,tool.securitySchemes);
  }
  const initialize = await app.fetch(mcpRequest({jsonrpc:"2.0",id:2,method:"initialize",params:{}},{Authorization:""}), TEST_ENV);
  assertEquals(initialize.status,200);
  const query = await app.fetch(mcpRequest({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"query_events",arguments:{hours:24}}},{Authorization:""}), TEST_ENV);
  assertEquals((await query.json()).result.isError,true);
});


Deno.test("未授权 MCP 的请求体过大时拒绝解析", async () => {
  const app=createApp({createSql:()=>{throw new Error("Must not access data");}});
  const response=await app.fetch(mcpRequest({jsonrpc:"2.0",id:1,method:"tools/call",params:{arguments:{value:"x".repeat(70000)}}},{Authorization:""}),TEST_ENV);
  assertEquals(response.status,413);
});
