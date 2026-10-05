// Test support: a fresh, migrated database per test package (packages run in parallel).
import { join } from "node:path";
import pg from "pg";
import { createDb } from "./client.ts";
import { runMigrations } from "./migrate.ts";

/**
 * Recreates `dbName` on the server in DATABASE_URL, migrates it and returns
 * its URL. TEST_DB_SUFFIX is appended to the name, so a second checkout (a
 * worktree) can run its tests without dropping another's database mid-run.
 */
export async function createTestDatabase(baseName: string): Promise<string> {
  const suffix = process.env.TEST_DB_SUFFIX ?? "";
  if (!/^[a-z0-9_]*$/.test(suffix)) throw new Error("TEST_DB_SUFFIX may only use a-z, 0-9 and _");
  const dbName = `${baseName}${suffix}`;
  const adminUrl = process.env.DATABASE_URL ?? "postgres://fs:fs@localhost:5433/founder_signal";
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Postgres isn't reachable at ${adminUrl}. Run \`pnpm db:up\` first.`, { cause: err });
  }
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const { db, pool } = createDb({ connectionString: url.toString(), ssl: false });
  await runMigrations(db, join(import.meta.dirname, "..", "migrations"));
  await pool.end();
  return url.toString();
}
