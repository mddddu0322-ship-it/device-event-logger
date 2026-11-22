import postgres from "postgres";

type Row = Record<string, unknown>;
const namespace = "device_event_logger";
const metadataTables = [
  { name: "app_controls", columns: ["app", "enabled", "expires_at", "message", "updated_at"], key: "app" },
  { name: "oauth_clients", columns: ["id", "redirects", "expires"], key: "id" },
  { name: "oauth_requests", columns: ["id", "csrf", "data", "expires"], key: "id" },
  { name: "oauth_codes", columns: ["id", "data", "expires"], key: "id" },
  { name: "oauth_tokens", columns: ["id", "client", "kind", "expires", "scope"], key: "id" },
] as const;

function queryValues(rows: Row[], columns: readonly string[], casts: Set<string> = new Set()) {
  const parameters: unknown[] = [];
  const groups = rows.map((row) => {
    const placeholders = columns.map((column) => {
      let value = row[column];
      if (casts.has(column) && value != null && typeof value === "object") value = JSON.stringify(value);
      parameters.push(value);
      const parameter = "$" + parameters.length;
      return casts.has(column) ? parameter + "::jsonb" : parameter;
    });
    return "(" + placeholders.join(",") + ")";
  });
  return { groups: groups.join(","), parameters };
}

export async function copyFromOldDatabase(oldUrl: string, newUrl: string) {
  if (!oldUrl || !newUrl || oldUrl === newUrl) throw new Error("Migration requires two different database URLs");
  const oldSql = postgres(oldUrl, { max: 1, connect_timeout: 5, idle_timeout: 10 });
  const newSql = postgres(newUrl, { max: 1, connect_timeout: 5, idle_timeout: 10, ssl: "require" });
  const copied: Record<string, number> = {};
  try {
    // Old database is authoritative until the final switch.
    const latest = await newSql.unsafe(`SELECT COALESCE(MAX(id), 0) AS id FROM ${namespace}.events`);
    let cursor = Number(latest[0].id);
    let transferred = 0;
    for (;;) {
      const batch = await oldSql.unsafe(
        "SELECT id,type,value,ts,created_at FROM events WHERE id>$1 ORDER BY id LIMIT 250",
        [cursor],
      ) as Row[];
      if (!batch.length) break;
      const columns = ["id", "type", "value", "ts", "created_at"];
      const { groups, parameters } = queryValues(batch, columns);
      await newSql.unsafe(
        `INSERT INTO ${namespace}.events(${columns.join(",")}) VALUES ${groups} ON CONFLICT (id) DO NOTHING`,
        parameters,
      );
      cursor = Number(batch[batch.length - 1].id);
      transferred += batch.length;
    }
    copied.events = transferred;

    for (const table of metadataTables) {
      const rows = await oldSql.unsafe(`SELECT ${table.columns.join(",")} FROM ${table.name}`) as Row[];
      if (!rows.length) { copied[table.name] = 0; continue; }
      const jsonColumns = new Set(["redirects", "data"]);
      const { groups, parameters } = queryValues(rows, table.columns, jsonColumns);
      const setColumns = table.columns.filter((c) => c !== table.key);
      const assignments = setColumns.map((c) => `${c}=EXCLUDED.${c}`).join(",");
      const updateCondition = table.name === "app_controls"
        ? ` WHERE EXCLUDED.updated_at >= ${namespace}.app_controls.updated_at`
        : "";
      await newSql.unsafe(
        `INSERT INTO ${namespace}.${table.name}(${table.columns.join(",")}) VALUES ${groups} ON CONFLICT (${table.key}) DO UPDATE SET ${assignments}${updateCondition}`,
        parameters,
      );
      copied[table.name] = rows.length;
    }
    await newSql.unsafe(
      `SELECT setval(pg_get_serial_sequence('${namespace}.events','id'), (SELECT MAX(id) FROM ${namespace}.events), true)`,
    );
    return copied;
  } finally {
    await Promise.allSettled([oldSql.end(), newSql.end()]);
  }
}
