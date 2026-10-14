import { audit } from "@/server/audit";
import { can, getCurrentUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { catalogCsvChunks } from "@/server/queries/catalog-export";
import { requestMeta } from "@/server/request";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Streams every product and variant as CSV (UTF-8 with BOM, CRLF, formula-safe). */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });
  if (!can(user, "catalog.edit")) return new Response(null, { status: 403 });
  const withCosts = can(user, "reports.view_costs");

  await audit(db, {
    actorId: user.id,
    action: "catalog.export",
    entityType: "Catalog",
    after: { withCosts },
    ...(await requestMeta()),
  });

  const chunks = catalogCsvChunks(withCosts);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        console.error("[catalog export] failed", error);
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="products-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
