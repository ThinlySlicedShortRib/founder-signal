import { readEnv } from "@fs/config";
import { serve } from "@hono/node-server";
import { buildApp } from "./bootstrap.ts";

const port = Number(process.env.PORT ?? 8787);
const app = await buildApp(readEnv());

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
