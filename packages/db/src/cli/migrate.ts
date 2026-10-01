// Local: `pnpm db:migrate` (reads DATABASE_URL from the repo's .env).
import { join } from "node:path";
import { readEnv, resolveDatabaseConfig } from "@fs/config";
import { createDb } from "../client.ts";
import { runMigrations } from "../migrate.ts";

const { db, pool } = createDb(await resolveDatabaseConfig(readEnv()));
try {
  await runMigrations(db, join(import.meta.dirname, "..", "..", "migrations"));
  console.log("Migrations applied");
} finally {
  await pool.end();
}
