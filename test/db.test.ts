import { assert, assertEquals, assertRejects } from "@std/assert";
import { backoffDelays, isTransientDbError, withRetry } from "../src/lib/db.ts";

const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 1 };

Deno.test("数据库冷启动算瞬时错误", () => {
  assert(isTransientDbError(new Error("the database system is starting up")));
  assert(isTransientDbError(Object.assign(new Error("nope"), { code: "57P03" })));
  assert(isTransientDbError(Object.assign(new Error("nope"), { code: "CONNECT_TIMEOUT" })));
});

Deno.test("缺表、语法错误不算瞬时错误", () => {
  assert(!isTransientDbError(new Error('relation "events" does not exist')));
  assert(!isTransientDbError(new Error("syntax error at or near")));
});

Deno.test("默认退避总等待留在 MCP 客户端 30 秒超时内", () => {
  const total = backoffDelays().reduce((sum, delay) => sum + delay, 0);
  assert(total + 3 * 3000 < 10_000, `连接和退避总等待过长: ${total}ms + 连接耗时`);
});

Deno.test("withRetry 重试瞬时错误直到成功", async () => {
  let calls = 0;
  const result = await withRetry(() => {
    calls++;
    if (calls < 3) return Promise.reject(new Error("the database system is starting up"));
    return Promise.resolve("ok");
  }, FAST_RETRY);

  assertEquals(result, "ok");
  assertEquals(calls, 3);
});

Deno.test("withRetry 不重试非瞬时错误", async () => {
  let calls = 0;
  await assertRejects(() =>
    withRetry(() => {
      calls++;
      return Promise.reject(new Error('relation "events" does not exist'));
    }, FAST_RETRY)
  );

  assertEquals(calls, 1);
});

Deno.test("withRetry 到达次数上限后抛错", async () => {
  let calls = 0;
  await assertRejects(() =>
    withRetry(() => {
      calls++;
      return Promise.reject(new Error("the database system is starting up"));
    }, { ...FAST_RETRY, retries: 3 })
  );

  assertEquals(calls, 3);
});
