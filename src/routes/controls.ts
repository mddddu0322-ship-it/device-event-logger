import { Hono } from "hono";
import type postgres from "postgres";
import type { Env, Vars } from "../types.ts";
import { withRetry } from "../lib/db.ts";

export const CONTROL_SCOPE = "app_controls";
export const CONTROL_DDL = `
CREATE TABLE IF NOT EXISTS app_controls (
  app TEXT PRIMARY KEY CHECK (app IN ('小红书')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  message TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR expires_at IS NOT NULL)
);
`;

const securitySchemes = [{ type: "oauth2", scopes: [CONTROL_SCOPE] }];
const appProperty = { type: "string", enum: ["小红书"], description: "App name. Only 小红书 is supported in this pilot." };
const outputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    app: { type: "string" }, enabled: { type: "boolean" },
    expires_at: { anyOf: [{ type: "string" }, { type: "null" }] },
    message: { type: "string" },
    updated_at: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["app", "enabled", "expires_at", "message", "updated_at"],
};
export const CONTROL_TOOLS = [
  {
    name: "get_app_control", title: "Get App Restriction",
    description: "Read the temporary app restriction checked by the user's iOS Shortcut. Only 小红书 is supported. Expired restrictions are reported disabled. This does not read phone activity.",
    securitySchemes, _meta: { securitySchemes },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, properties: { app: appProperty }, required: [] },
    outputSchema,
  },
  {
    name: "set_app_control", title: "Set Temporary App Restriction",
    description: "Enable or disable a temporary 小红书 restriction, only when the user requests it or has explicitly agreed to a rule. Enabling requires duration_minutes (1–1440); it expires automatically. The iOS Shortcut must be configured on the phone; it checks on the next app opening, not continuously. This does not lock the OS or close an already-open app. Disabling is always available. Repeating enable restarts the duration.",
    securitySchemes, _meta: { securitySchemes },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        app: appProperty,
        enabled: { type: "boolean", description: "true enables a temporary restriction; false immediately disables it." },
        duration_minutes: { type: "integer", minimum: 1, maximum: 1440, description: "Required when enabling. Automatic expiry in 1–1440 minutes." },
        message: { type: "string", maxLength: 200, description: "Optional plain text for the Shortcut notification." },
      }, required: ["app", "enabled"],
    }, outputSchema,
  },
];

class ControlInputError extends Error {}
function parseApp(value: unknown): string {
  if (value === undefined) return "小红书";
  if (value !== "小红书") throw new ControlInputError("当前仅支持小红书。");
  return value;
}
function toISO(value: unknown): string | null {
  return value == null ? null : new Date(value as string).toISOString();
}
function serialize(row: Record<string, unknown> | undefined, app: string) {
  return { app, enabled: row?.active === true,
    expires_at: toISO(row?.expires_at), message: String(row?.message ?? ""), updated_at: toISO(row?.updated_at) };
}
export async function getAppControl(sql: postgres.Sql, appValue?: unknown) {
  const app = parseApp(appValue);
  const rows = await withRetry(() => sql.unsafe(
    "SELECT *, (enabled AND expires_at>now()) AS active FROM app_controls WHERE app=$1", [app]));
  return serialize(rows[0], app);
}
export async function setAppControl(sql: postgres.Sql, args: Record<string, unknown>) {
  const app = parseApp(args.app);
  if (args.app === undefined || typeof args.enabled !== "boolean") throw new ControlInputError("需要提供 app 和布尔值 enabled。");
  const duration = args.duration_minutes;
  if (args.enabled && (typeof duration !== "number" || !Number.isInteger(duration) || duration < 1 || duration > 1440)) {
    throw new ControlInputError("启用限制时，duration_minutes 必须是 1–1440 的整数。");
  }
  if (args.message !== undefined && (typeof args.message !== "string" || args.message.length > 200)) {
    throw new ControlInputError("message 必须是最多 200 字符的文本。");
  }
  const message = args.enabled ? (args.message ?? "当前应用暂时限制使用，稍后再打开。") : "";
  const rows = await withRetry(() => sql.unsafe(
    `INSERT INTO app_controls(app,enabled,expires_at,message)
     VALUES ($1,$2,CASE WHEN $2 THEN now()+($3::integer * interval '1 minute') ELSE NULL END,$4)
     ON CONFLICT (app) DO UPDATE SET enabled=EXCLUDED.enabled,expires_at=EXCLUDED.expires_at,
       message=EXCLUDED.message,updated_at=now()
     RETURNING *, (enabled AND expires_at>now()) AS active`,
    [app, args.enabled, args.enabled ? duration : 0, message]));
  return serialize(rows[0], app);
}
export async function callAppControlTool(name: string, args: Record<string, unknown>, sql: postgres.Sql) {
  try {
    const result = name === "get_app_control" ? await getAppControl(sql, args.app) : await setAppControl(sql, args);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
  } catch (error) {
    if (!(error instanceof ControlInputError)) console.error("App control database operation failed");
    return { content: [{ type: "text", text: error instanceof ControlInputError ? error.message : "应用限制服务暂时不可用。" }], isError: true };
  }
}

export const controls = new Hono<{ Bindings: Env; Variables: Vars }>();
controls.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
controls.get("/", async c => {
  try { return c.json(await getAppControl(c.var.sql, c.req.query("app"))); }
  catch (error) { if (error instanceof ControlInputError) return c.json({ error: error.message }, 400); throw error; }
});
controls.post("/", async c => {
  const args = await c.req.json().catch(() => null);
  if (!args || Array.isArray(args) || typeof args !== "object") return c.json({ error: "需要 JSON 对象。" }, 400);
  try { return c.json(await setAppControl(c.var.sql, args)); }
  catch (error) { if (error instanceof ControlInputError) return c.json({ error: error.message }, 400); throw error; }
});
