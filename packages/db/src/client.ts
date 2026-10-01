import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";

export type Db = NodePgDatabase<typeof schema>;

export interface CreateDbOptions {
  connectionString: string;
  /** Verify the server certificate against the Amazon RDS CA bundle. */
  ssl: boolean;
  /** Lambda handles one request per instance, so a tiny pool is enough. */
  maxConnections?: number;
}

/**
 * The RDS CA bundle ships next to the Lambda handler (see the bundle scripts).
 * Locally it's read from packages/db/certs.
 */
function rdsCaBundle(): string {
  const path =
    process.env.RDS_CA_PATH ??
    (process.env.LAMBDA_TASK_ROOT
      ? join(process.env.LAMBDA_TASK_ROOT, "rds-global-bundle.pem")
      : join(import.meta.dirname, "..", "certs", "rds-global-bundle.pem"));
  return readFileSync(path, "utf8");
}

export function createDb({ connectionString, ssl, maxConnections = 2 }: CreateDbOptions) {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    ssl: ssl ? { ca: rdsCaBundle(), rejectUnauthorized: true } : undefined,
  });
  const db: Db = drizzle(pool, { schema });
  return { db, pool };
}
