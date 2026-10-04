import { type Db, schema } from "@fs/db";
import { putReviewInputSchema } from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../lib/errors.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

const { contentItem, review } = schema;

const idParam = z.object({ id: z.uuid() });

/** PUT/DELETE /items/:id/review (build plan §7): an idempotent upsert, one review per user and item. */
export function reviewRoutes({ db }: { db: Db }) {
  return new Hono<AuthedEnv>()
    .use(requireUser)

    .put(
      "/:id/review",
      zValidator("param", idParam, (result, c) => {
        if (!result.success) return apiError(c, 404, "NOT_FOUND", "Item not found");
      }),
      zValidator("json", putReviewInputSchema, (result, c) => {
        if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Send a vote and optional reasons");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const { id } = c.req.valid("param");
        const { vote, reasons, freeText, origin } = c.req.valid("json");
        const [item] = await db.select({ id: contentItem.id }).from(contentItem).where(eq(contentItem.id, id));
        if (!item) return apiError(c, 404, "NOT_FOUND", "Item not found");

        const values = { vote, reasons: [...new Set(reasons)], freeText: freeText || null, editedAt: new Date() };
        const [row] = await db
          .insert(review)
          .values({ userId, itemId: id, origin, ...values })
          // The origin stays what it was first (an older onboarding pick edited later is still from onboarding).
          .onConflictDoUpdate({ target: [review.userId, review.itemId], set: values })
          .returning();
        return c.json({
          review: { itemId: row!.itemId, vote: row!.vote, reasons: row!.reasons, freeText: row!.freeText, origin: row!.origin, editedAt: row!.editedAt.toISOString() },
        });
      },
    )

    .delete(
      "/:id/review",
      zValidator("param", idParam, (result, c) => {
        if (!result.success) return apiError(c, 404, "NOT_FOUND", "Item not found");
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await db.delete(review).where(and(eq(review.userId, c.get("user").id), eq(review.itemId, id)));
        return c.body(null, 204);
      },
    );
}
