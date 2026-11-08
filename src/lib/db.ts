import postgres from "postgres";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 数据库刚启动、连接被回收等情况下抛出的错误，重试一下通常就好了
const TRANSIENT_SQL_STATES = new Set([
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
]);

const TRANSIENT_MESSAGES = [
  "the database system is starting up",
  "the database system is not yet accepting connections",
  "connection terminated",
  "connect_timeout",
  "econnrefused",
  "econnreset",
];

export function isTransientDbError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_SQL_STATES.has(code)) return true;

  const message = error instanceof Error ? error.message : String(error);
  const haystack = `${typeof code === "string" ? code : ""} ${message}`.toLowerCase();
  return TRANSIENT_MESSAGES.some((pattern) => haystack.includes(pattern));
}

export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export const RETRY_DEFAULTS = { retries: 3, baseDelayMs: 250, maxDelayMs: 500 };

/**
 * 连接耗时也占用客户端的超时预算。配合 3 秒连接超时，
 * 三次连接尝试及退避约需 9.75 秒，避免原先五次 30 秒连接尝试。
 */
export function backoffDelays(options: RetryOptions = {}): number[] {
  const { retries, baseDelayMs, maxDelayMs } = { ...RETRY_DEFAULTS, ...options };
  return Array.from(
    { length: Math.max(retries - 1, 0) },
    (_, attempt) => Math.min(baseDelayMs * 2 ** attempt, maxDelayMs),
  );
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = backoffDelays(options);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isTransientDbError(error)) throw error;
      console.log(`DB transient error, retrying in ${delay}ms... (${attempt + 1}/${delays.length})`);
      await sleep(delay);
    }
  }
}

export function createSql(databaseUrl: string, options?: Record<string, unknown>): postgres.Sql {
  return postgres(databaseUrl, {
    // App transitions arrive in bursts; a slow read must not occupy the only slot.
    max: 3,
    connect_timeout: 3,
    idle_timeout: 20,
    max_lifetime: 300,
    ...options,
    connection: {
      application_name: "device-event-logger",
      statement_timeout: 5000,
      lock_timeout: 2000,
      ...(options?.connection as Record<string, unknown> | undefined),
    },
  });
}
