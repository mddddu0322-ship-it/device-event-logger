import { serve } from "@hono/node-server";
import postgres from "postgres";
import { createApp } from "../src/app.ts";

// Prepare a reversible database switch. The original DATABASE_URL remains untouched.
const useNewDatabase = process.env.DATABASE_USE_NEXT === "true";
const newDatabaseUrl = process.env.DATABASE_URL_NEXT;
if (useNewDatabase && !newDatabaseUrl) {
  throw new Error("DATABASE_USE_NEXT requires DATABASE_URL_NEXT");
}
const activeDatabaseUrl = useNewDatabase ? newDatabaseUrl! : (process.env.DATABASE_URL ?? "");

const databaseSchema = useNewDatabase ? "device_event_logger" : process.env.DATABASE_SCHEMA;
if (databaseSchema && !/^[a-z_][a-z0-9_]*$/.test(databaseSchema)) {
  throw new Error("Invalid DATABASE_SCHEMA");
}
const app = createApp(databaseSchema ? {
  postgresOptions: {
    connection: { search_path: `${databaseSchema},public` },
  },
} : undefined);

// Check the candidate without moving any production reads or writes to it.
// Never log the database URL, login, password, or event contents.
async function probeCandidateDatabase() {
  if (!newDatabaseUrl || useNewDatabase) return;
  const test = postgres(newDatabaseUrl, { max: 1, connect_timeout: 5, ssl: "require" });
  try {
    await test.unsafe("SELECT 1 FROM device_event_logger.events LIMIT 1");
    console.info(JSON.stringify({ event: "candidate_db_probe", status: "ok" }));
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown";
    console.error(JSON.stringify({ event: "candidate_db_probe", status: "failed", code }));
  } finally {
    await test.end().catch(() => {});
  }
}
void probeCandidateDatabase();

// Run a guarded catch-up copy while the old database is still live.
// The switch flag remains independent; this operation cannot switch production reads.
if (process.env.DATABASE_MIGRATE_ON_START === "true" && newDatabaseUrl && !useNewDatabase) {
  void import("./migration.ts")
    .then(({ copyFromOldDatabase }) => copyFromOldDatabase(activeDatabaseUrl, newDatabaseUrl))
    .then((counts) => console.info(JSON.stringify({ event: "candidate_db_copy", status: "ok", counts })))
    .catch((error) => console.error(JSON.stringify({
      event: "candidate_db_copy", status: "failed", code: (error as { code?: string }).code ?? "unknown",
    })));
}


serve({
  fetch: (request) => app.fetch(request, {
    API_KEY: process.env.API_KEY ?? "",
    DATABASE_URL: activeDatabaseUrl,
    TZ_OFFSET: process.env.TZ_OFFSET,
  }),
  port: Number(process.env.PORT) || 8000,
});
