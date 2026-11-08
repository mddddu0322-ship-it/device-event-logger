import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createSql, withRetry } from "../src/lib/db.ts";

test("an unresponsive PostgreSQL handshake fails within the request budget", { timeout: 12000 }, async () => {
  const sockets = new Set<net.Socket>();
  // Accept TCP but never answer the PostgreSQL startup message.
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const sql = createSql(`postgres://test:test@127.0.0.1:${port}/test`, { ssl: false });
  const started = Date.now();
  try {
    await assert.rejects(withRetry(() => sql.unsafe("SELECT 1")), /CONNECT_TIMEOUT/);
    assert.ok(Date.now() - started < 11000, "connection attempts must not exceed the client budget");
  } finally {
    await sql.end({ timeout: 0 });
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("transient reconnect succeeds but SQL failures are not replayed", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error("connect failed"), { code: "CONNECT_TIMEOUT" });
    return "connected";
  }, { baseDelayMs: 1, maxDelayMs: 1 });
  assert.equal(result, "connected");
  calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw Object.assign(new Error("statement timeout"), { code: "57014" });
  }));
  assert.equal(calls, 1);
});
