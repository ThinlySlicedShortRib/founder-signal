// Lambda: founder-signal-<env>-migrate. CI invokes it before shifting traffic to a new API release.
import { join } from "node:path";
import { readEnv, resolveDatabaseConfig } from "@fs/config";
import { createDb, runMigrations } from "@fs/db";

export async function handler() {
  const { db, pool } = createDb(await resolveDatabaseConfig(readEnv()));
  try {
    // The bundle script copies packages/db/migrations next to index.mjs.
    await runMigrations(db, join(process.env.LAMBDA_TASK_ROOT ?? import.meta.dirname, "migrations"));
    return { ok: true };
  } finally {
    await pool.end();
  }
}
