import type postgres from "postgres";

export const TEST_ENV = {
  API_KEY: "test-key",
  DATABASE_URL: "postgres://fake/db",
  TZ_OFFSET: "8",
};

export type FakeSqlHandler = (query: string, args?: unknown[]) => Promise<unknown[]>;

/** 记录所有 SQL 调用的假连接，让测试不依赖真数据库 */
export function createFakeSql(handler?: FakeSqlHandler) {
  const queries: { query: string; args?: unknown[] }[] = [];
  const sql = {
    unsafe: (query: string, args?: unknown[]) => {
      queries.push({ query, args });
      return handler ? handler(query, args) : Promise.resolve([]);
    },
  };
  return { sql: sql as unknown as postgres.Sql, queries };
}

export function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_ENV.API_KEY}`, ...headers },
    body: JSON.stringify(body),
  });
}
