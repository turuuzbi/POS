import { MapPinOff } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { requirePermission } from "@/server/auth/session";
import { resolveLocation } from "@/server/queries/locations";
import { AdjustmentForm } from "./adjustment-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adjustments");
  return { title: t("newTitle") };
}

export default async function NewAdjustmentPage() {
  const user = await requirePermission("inventory.adjust");
  const t = await getTranslations("adjustments");
  const { locations, location } = await resolveLocation(user, null);
  return (
    <div className="space-y-6">
      <PageHeader title={t("newTitle")} description={t("description")} />
      {location ? (
        <AdjustmentForm
          locations={locations.map((l) => ({ id: l.id, name: l.name }))}
          defaultLocationId={location.id}
        />
      ) : (
        <EmptyState icon={MapPinOff} title={t("noLocations")} />
      )}
    </div>
  );
}
