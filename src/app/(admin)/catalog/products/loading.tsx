import { getTranslations } from "next-intl/server";
import { Skeleton } from "@/components/ui/skeleton";

export default async function Loading() {
  const t = await getTranslations("common");
  return (
    <div className="space-y-6" aria-busy="true">
      <p role="status" className="sr-only">
        {t("loading")}
      </p>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-11" />
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
