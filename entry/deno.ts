import { createApp } from "../src/app.ts";

const app = createApp();

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000, hostname: "0.0.0.0" }, (req) =>
  app.fetch(req, {
    API_KEY: Deno.env.get("API_KEY") ?? "",
    DATABASE_URL: Deno.env.get("DATABASE_URL") ?? "",
    TZ_OFFSET: Deno.env.get("TZ_OFFSET"),
  })
);
