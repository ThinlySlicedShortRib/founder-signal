import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.ts";

/** Applies pending migrations from `migrationsFolder`. Safe to run repeatedly. */
export async function runMigrations(db: Db, migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
}
