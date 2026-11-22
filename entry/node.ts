import { serve } from "@hono/node-server";
import { createApp } from "../src/app.ts";

// Optional schema selection for PostgreSQL hosts using a non-public schema.
// Existing deployments keep their previous connection settings unless enabled.
const databaseSchema = process.env.DATABASE_SCHEMA;
if (databaseSchema && !/^[a-z_][a-z0-9_]*$/.test(databaseSchema)) {
  throw new Error("Invalid DATABASE_SCHEMA");
}
const app = createApp(databaseSchema ? {
  postgresOptions: {
    connection: { search_path: `${databaseSchema},public` },
  },
} : undefined);

serve({
  fetch: (request) => app.fetch(request, {
    API_KEY: process.env.API_KEY ?? "",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    TZ_OFFSET: process.env.TZ_OFFSET,
  }),
  port: Number(process.env.PORT) || 8000,
});
