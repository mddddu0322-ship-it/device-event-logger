import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createFakeSql, mcpRequest, TEST_ENV } from "./helpers.ts";

const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

Deno.test("首页可访问且不会连接数据库", async () => {
  const app = createApp({ createSql: () => { throw new Error("Must not connect"); } });
  const response = await app.fetch(new Request("http://localhost/"), TEST_ENV);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).service, "device-event-logger");
});

Deno.test("健康检查验证数据库可用，故障时不会报健康", async () => {
  for (const available of [true, false]) {
    const { sql } = createFakeSql((query) => {
      if (query === "SELECT 1" && !available) return Promise.reject(new Error("Database unavailable"));
      return Promise.resolve([]);
    });
    const app = createApp({ createSql: () => sql });
    const response = await app.fetch(new Request("http://localhost/healthz"), TEST_ENV);
    await response.text();
    assertEquals(response.status, available ? 200 : 500);
  }
});

Deno.test("建表失败后，下一个请求会重新建表", async () => {
  let attempts = 0;
  const { sql } = createFakeSql((query) => {
    if (query.includes("CREATE TABLE")) {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error("boom"));
    }
    return Promise.resolve([]);
  });
  const app = createApp({ createSql: () => sql });

  const first = await app.fetch(mcpRequest(TOOLS_LIST), TEST_ENV);
  await first.text();
  assertEquals(first.status, 500);

  const second = await app.fetch(mcpRequest(TOOLS_LIST), TEST_ENV);
  await second.text();
  assertEquals(second.status, 200);
  assertEquals(attempts, 2, "第一次建表失败后必须再试一次，否则这个部署会永久缺表");
});

Deno.test("建表成功后不再重复执行 DDL", async () => {
  let attempts = 0;
  const { sql } = createFakeSql((query) => {
    if (query.includes("CREATE TABLE")) attempts++;
    return Promise.resolve([]);
  });
  const app = createApp({ createSql: () => sql });

  for (let i = 0; i < 3; i++) {
    const res = await app.fetch(mcpRequest(TOOLS_LIST), TEST_ENV);
    await res.text();
  }

  assertEquals(attempts, 1);
});

Deno.test("并发请求只建一次表", async () => {
  let attempts = 0;
  const { sql } = createFakeSql((query) => {
    if (query.includes("CREATE TABLE")) attempts++;
    return Promise.resolve([]);
  });
  const app = createApp({ createSql: () => sql });

  const responses = await Promise.all(
    Array.from({ length: 5 }, () => app.fetch(mcpRequest(TOOLS_LIST), TEST_ENV)),
  );
  for (const res of responses) await res.text();

  assertEquals(attempts, 1);
});

Deno.test("建表 SQL 保持原样", async () => {
  const { sql, queries } = createFakeSql();
  const app = createApp({ createSql: () => sql });

  const res = await app.fetch(mcpRequest(TOOLS_LIST), TEST_ENV);
  await res.text();

  const ddl = queries[0].query;
  assertStringIncludes(ddl, "CREATE TABLE IF NOT EXISTS events");
  assertStringIncludes(ddl, "type TEXT NOT NULL CHECK (type ~ '^[a-z0-9]+(\\.[a-z0-9]+)*$')");
  assertStringIncludes(ddl, "ts TIMESTAMPTZ NOT NULL");
  assertStringIncludes(ddl, "CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts)");
  assertStringIncludes(ddl, "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)");
});
