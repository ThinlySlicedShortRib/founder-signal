// Creates a fresh `founder_signal_test` database and applies migrations before the suite.
import { join } from "node:path";
import { createDb, runMigrations } from "@fs/db";
import pg from "pg";

const adminUrl = process.env.DATABASE_URL ?? "postgres://fs:fs@localhost:5433/founder_signal";
const testDbName = "founder_signal_test";

export default async function setup() {
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Postgres isn't reachable at ${adminUrl}. Run \`pnpm db:up\` first.`, { cause: err });
  }
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${testDbName}`;
  process.env.TEST_DATABASE_URL = url.toString();

  const { db, pool } = createDb({ connectionString: url.toString(), ssl: false });
  await runMigrations(db, join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations"));
  await pool.end();
}
