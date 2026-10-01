import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import { rightsRule } from "../schema/ingestion.ts";

/** The rights rules that could apply to these publishers and sources (resolve with @fs/core `resolveRights`). */
export async function loadRightsRules(db: Db, { publisherKeys = [], sourceKeys = [] }: { publisherKeys?: string[]; sourceKeys?: string[] }) {
  const clauses = [];
  if (publisherKeys.length) clauses.push(and(eq(rightsRule.scope, "domain"), inArray(rightsRule.scopeKey, publisherKeys)));
  if (sourceKeys.length) clauses.push(and(eq(rightsRule.scope, "source"), inArray(rightsRule.scopeKey, sourceKeys)));
  if (!clauses.length) return [];
  return db
    .select({
      scope: rightsRule.scope,
      scopeKey: rightsRule.scopeKey,
      display: rightsRule.display,
      retainText: rightsRule.retainText,
      offlineAllowed: rightsRule.offlineAllowed,
      licenseNote: rightsRule.licenseNote,
    })
    .from(rightsRule)
    .where(or(...clauses));
}
